mod k40;

use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::Semaphore;

/// Gemeinsamer HTTP-Client. Das Gateway ist ein kleines eingebettetes Gerät,
/// daher höchstens vier gleichzeitige Anfragen.
struct Net {
    client: reqwest::Client,
    limit: Semaphore,
}

#[tauri::command]
async fn scan_gateways() -> Result<Vec<String>, k40::ApiError> {
    let own = k40::local_ipv4().ok_or_else(|| k40::ApiError {
        kind: "no_network",
        status: None,
        message: "keine IPv4-Adresse im lokalen Netz".into(),
    })?;
    let found = k40::scan_subnet(own, k40::AUTH_PORT, Duration::from_millis(800)).await;
    Ok(found.into_iter().map(|ip| ip.to_string()).collect())
}

#[tauri::command]
async fn request_token(
    net: tauri::State<'_, Net>,
    host: String,
    login: String,
    password: String,
) -> Result<String, k40::ApiError> {
    k40::request_token(&net.client, &host, &login, &password).await
}

#[tauri::command]
async fn api_get(
    net: tauri::State<'_, Net>,
    host: String,
    token: String,
    path: String,
    query: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, k40::ApiError> {
    let _slot = net.limit.acquire().await.expect("Semaphore geschlossen");
    let query: Vec<(String, String)> = query.unwrap_or_default().into_iter().collect();
    k40::get(&net.client, &host, &token, &path, &query).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(Net {
        client: k40::http_client(),
        limit: Semaphore::new(4),
    });

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .invoke_handler(tauri::generate_handler![scan_gateways, request_token, api_get])
        .run(tauri::generate_context!())
        .expect("Fehler beim Start der App");
}
