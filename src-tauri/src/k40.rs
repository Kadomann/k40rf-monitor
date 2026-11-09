//! Zugriff auf die lokale API des Bosch Connect-Key K 40 RF.
//!
//! Port 9442: Token anfordern. Port 9443: Ressourcen lesen (Bearer-Token).
//! Das Gerät nutzt ein selbstsigniertes Zertifikat mit der Geräte-ID als
//! Common Name, daher wird die Zertifikatsprüfung abgeschaltet (wie in der
//! offiziellen Anleitung mit `curl --insecure`). Die Verbindung bleibt
//! verschlüsselt, die Identität des Gateways wird aber nicht geprüft.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::time::Duration;

pub const AUTH_PORT: u16 = 9442;
pub const DATA_PORT: u16 = 9443;
const CLIENT_NAME: &str = "k40-monitor";

/// Fehler, wie ihn die Oberfläche bekommt. `kind` steuert die Meldung.
#[derive(Debug, Serialize, PartialEq)]
pub struct ApiError {
    pub kind: &'static str,
    pub status: Option<u16>,
    pub message: String,
}

impl ApiError {
    fn new(kind: &'static str, status: Option<u16>, message: impl Into<String>) -> Self {
        Self { kind, status, message: message.into() }
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        // Das Gateway steht im Heimnetz: niemals über einen System-Proxy gehen.
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .build()
        .expect("HTTP-Client konnte nicht erstellt werden")
}

fn unreachable(err: reqwest::Error) -> ApiError {
    ApiError::new("unreachable", None, err.to_string())
}

/// Token anfordern. Klappt nur kurz nach dem Drücken von WLAN- und Funktaste
/// und nur aus dem Subnetz des Gateways (sonst HTTP 412).
pub async fn request_token(
    client: &reqwest::Client,
    host: &str,
    login: &str,
    password: &str,
) -> Result<String, ApiError> {
    let password: String = password.chars().filter(|c| *c != '-').collect();
    let response = client
        .post(format!("https://{host}:{AUTH_PORT}/auth/token"))
        .form(&[
            ("grant_type", "password"),
            ("username", login.trim()),
            ("password", password.trim()),
            ("client_name", CLIENT_NAME),
        ])
        .send()
        .await
        .map_err(unreachable)?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    match status {
        200 => {
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|_| ApiError::new("bad_response", Some(status), "Antwort ist kein JSON"))?;
            json["access_token"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| ApiError::new("bad_response", Some(status), "Antwort enthält keinen Token"))
        }
        412 => Err(ApiError::new("proximity", Some(status), body)),
        400 | 401 | 403 => Err(ApiError::new("credentials", Some(status), body)),
        507 => Err(ApiError::new("token_db_full", Some(status), body)),
        _ => Err(ApiError::new("http", Some(status), body)),
    }
}

/// Eine Ressource lesen, z. B. `/gateway/brand`.
pub async fn get(
    client: &reqwest::Client,
    host: &str,
    token: &str,
    path: &str,
    query: &[(String, String)],
) -> Result<serde_json::Value, ApiError> {
    if !path.starts_with('/') {
        return Err(ApiError::new("http", None, "Pfad muss mit / beginnen"));
    }
    let response = client
        .get(format!("https://{host}:{DATA_PORT}{path}"))
        .query(query)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(unreachable)?;
    let status = response.status().as_u16();
    match status {
        200 => response
            .json()
            .await
            .map_err(|e| ApiError::new("bad_response", Some(status), e.to_string())),
        401 => Err(ApiError::new("unauthorized", Some(status), path)),
        403 => Err(ApiError::new("forbidden", Some(status), path)),
        404 => Err(ApiError::new("not_found", Some(status), path)),
        _ => Err(ApiError::new("http", Some(status), response.text().await.unwrap_or_default())),
    }
}

/// Eigene IPv4-Adresse im Heimnetz. Der UDP-"connect" sendet nichts, er lässt
/// nur das Betriebssystem die passende Netzwerkschnittstelle wählen.
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Alle Adressen im eigenen /24-Netz, auf denen `port` offen ist.
/// Annahme: übliches Heimnetz mit 255.255.255.0.
pub async fn scan_subnet(own: Ipv4Addr, port: u16, timeout: Duration) -> Vec<Ipv4Addr> {
    let [a, b, c, _] = own.octets();
    let mut probes = tokio::task::JoinSet::new();
    for last in 1..=254u8 {
        let ip = Ipv4Addr::new(a, b, c, last);
        probes.spawn(async move {
            let attempt = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((ip, port)));
            matches!(attempt.await, Ok(Ok(_))).then_some(ip)
        });
    }
    let mut found = Vec::new();
    while let Some(result) = probes.join_next().await {
        if let Ok(Some(ip)) = result {
            found.push(ip);
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    //! Die mit #[ignore] markierten Tests brauchen das simulierte Gateway:
    //!   node mock/gateway.mjs   (mit MOCK_PRESSED=1 für den Token-Test)
    //!   cargo test -- --include-ignored
    use super::*;

    const MOCK_TOKEN: &str = "mock-token-4f1c2a9e";

    #[test]
    fn eigene_adresse_wird_gefunden() {
        let ip = local_ipv4().expect("keine IPv4-Adresse gefunden");
        assert!(!ip.is_loopback());
    }

    #[tokio::test]
    #[ignore]
    async fn token_und_daten_vom_simulator() {
        let client = http_client();
        let token = request_token(&client, "127.0.0.1", "100000001", "aaaa-bbbb-cccc-dddd").await.unwrap();
        assert_eq!(token, MOCK_TOKEN);

        let brand = get(&client, "127.0.0.1", &token, "/gateway/brand", &[]).await.unwrap();
        assert_eq!(brand["value"], "Bosch");

        let query = [("sampleRate".to_string(), "P1D".to_string())];
        let rec = get(&client, "127.0.0.1", &token, "/recordings/heatSources/actualSupplyTemperature", &query)
            .await
            .unwrap();
        assert_eq!(rec["type"], "yRecordingExtended");
    }

    #[tokio::test]
    #[ignore]
    async fn fehler_werden_unterschieden() {
        let client = http_client();
        let wrong = request_token(&client, "127.0.0.1", "100000001", "falsch").await.unwrap_err();
        assert!(matches!(wrong.kind, "credentials" | "proximity"), "{wrong:?}");

        let e = get(&client, "127.0.0.1", "falsch", "/gateway/brand", &[]).await.unwrap_err();
        assert_eq!(e.kind, "unauthorized");
        let e = get(&client, "127.0.0.1", MOCK_TOKEN, "/heatSources/flameStatus", &[]).await.unwrap_err();
        assert_eq!(e.kind, "not_found");
        let e = get(&client, "127.0.0.1", MOCK_TOKEN, "/gateway/brand", &[]).await;
        assert!(e.is_ok());
        // 198.51.100.1 ist ein reserviertes Testnetz, dort antwortet niemand
        let e = get(&client, "198.51.100.1", MOCK_TOKEN, "/gateway/brand", &[]).await.unwrap_err();
        assert_eq!(e.kind, "unreachable");
    }

    #[tokio::test]
    #[ignore]
    async fn suche_findet_simulator_im_eigenen_netz() {
        let own = local_ipv4().unwrap();
        let found = scan_subnet(own, AUTH_PORT, Duration::from_millis(700)).await;
        assert!(found.contains(&own), "gefunden: {found:?}, eigene Adresse: {own}");
    }
}
