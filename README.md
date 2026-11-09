# K40 Monitor

Zeigt die Werte deiner Heizung über die lokale API des Bosch Connect-Key K 40 RF
(auch Buderus MX400 und K 40 RF von IVT, Vulcano, Worcester) an: aktuelle
Temperaturen, Betriebszustand, Energiezähler und Verläufe über 48 Stunden,
30 Tage und 12 Monate. Alles läuft im Heimnetz, ohne Cloud.

Die App liest nur. Sie kann an der Heizung nichts verstellen (die API von Bosch
erlaubt derzeit nur Lesezugriff).

Voraussetzung: Gateway-Firmware 15.00.01 oder neuer.

## 1. App bauen lassen (GitHub)

Du brauchst nichts zu installieren, GitHub baut die App auf seinen Rechnern.

1. Auf GitHub ein neues Repository anlegen (privat ist in Ordnung).
2. Den Inhalt dieses Ordners hochladen, z. B. per „Add file → Upload files“
   oder mit Git:
   ```bash
   git init && git add . && git commit -m "K40 Monitor"
   git branch -M main
   git remote add origin https://github.com/DEIN-NAME/k40-monitor.git
   git push -u origin main
   ```
3. Im Repository auf **Actions** → **Build** → **Run workflow** klicken.
4. Nach etwa 15–25 Minuten unten auf der Seite des Laufs unter **Artifacts**
   herunterladen:
   - `k40-monitor-windows`: Installer (`.exe`, alternativ `.msi`)
   - `k40-monitor-android`: `.apk`

## 2. Installieren

**Windows:** Installer ausführen. Weil die App nicht kostenpflichtig signiert
ist, zeigt Windows SmartScreen eine Warnung: „Weitere Informationen“ →
„Trotzdem ausführen“.

**Android:** Die `.apk` aufs Handy kopieren und öffnen. Android fragt einmalig,
ob die Installation aus dieser Quelle erlaubt ist. Die APK ist für 64-Bit-ARM
gebaut, also für praktisch alle Handys der letzten Jahre. Es ist ein
Debug-Build: voll funktionsfähig, nur etwas größer.

**iOS:** iOS-Apps lassen sich nur auf einem Mac bauen. Mit Xcode, Node.js und
Rust auf dem Mac:
```bash
npm ci
npx tauri ios init
npx tauri ios dev      # startet auf angeschlossenem iPhone oder Simulator
```
Ohne bezahltes Apple-Entwicklerkonto läuft eine so installierte App 7 Tage,
danach muss sie neu aufgespielt werden.

## 3. Ersteinrichtung

Die App führt in vier Schritten durch die Einrichtung:

1. **Gateway finden:** Die App durchsucht dein WLAN. Wird nichts gefunden,
   die IP-Adresse aus der Geräteliste des Routers eintragen.
2. **Zugangsdaten:** Login und Pass vom Aufkleber am Gateway. Auf dem Handy
   kannst du den QR-Code des Aufklebers scannen.
3. **Koppeln:** WLAN- und Funk-Taste am Gateway gleichzeitig etwa eine Sekunde
   drücken, bis die LEDs kurz blau blinken, dann innerhalb von 5 Minuten auf
   „Koppeln“ tippen. Das Gerät muss dabei im selben Netz wie das Gateway sein
   (nicht im Gäste-WLAN).
4. **Anlage erkunden:** Die App prüft, welche Werte deine Anlage liefert, und
   zeigt dir den Token.

**Den Token aufheben!** Er läuft nicht ab und der Speicher des Gateways für
Tokens ist begrenzt. Für weitere Geräte (z. B. Handy und PC) wählst du in
Schritt 2 „Ich habe schon einen Token“ und fügst ihn ein, statt neu zu
koppeln.

Bekommt das Gateway vom Router eine neue IP-Adresse, sucht die App es
automatisch wieder.

### Tokens verwalten

Ist der Token-Speicher voll (Meldung „Token-Speicher voll“), kannst du alte
Tokens mit `curl` auflisten und widerrufen (Werte ersetzen):

```bash
# Liste
curl --insecure -H "Authorization: Bearer DEIN-TOKEN" https://GATEWAY-IP:9442/auth/token
# Widerrufen
curl --insecure -X POST -H "Authorization: Bearer DEIN-TOKEN" \
  --data-urlencode "token_id=ID-AUS-DER-LISTE" --data-urlencode "usage_type=private" \
  https://GATEWAY-IP:9442/auth/revoke
```

## Sicherheit

Das Gateway nutzt ein selbstsigniertes Zertifikat, dessen Name nicht zur
Adresse passt. Die App prüft das Zertifikat daher nicht, genau wie die
offizielle Bosch-Anleitung (`curl --insecure`). Die Verbindung ist
verschlüsselt, aber ein Angreifer *in deinem Heimnetz* könnte sich als Gateway
ausgeben und den Token abfangen. Da der Token nur Lesezugriff erlaubt, ist das
Risiko begrenzt. Der Token liegt unverschlüsselt im App-Speicher.

## Entwicklung

Mit Node.js 22 und Rust (aktuelle stable):

```bash
npm ci
npm test               # Datenlogik gegen echte Gateway-Antworten
npm run mock           # simuliertes Gateway auf diesem Rechner
npx tauri dev          # App starten
```

Das simulierte Gateway (`mock/gateway.mjs`, braucht `openssl`) verhält sich
wie in der Bosch-Doku beschrieben. Zugangsdaten: Login `100000001`, Pass
`aaaa-bbbb-cccc-dddd`. Enter im Terminal simuliert den Tastendruck am Gateway.
Die Rust-Tests dagegen: `cd src-tauri && MOCK_PRESSED=1 … cargo test -- --include-ignored`
(Simulator vorher mit `MOCK_PRESSED=1 npm run mock` starten).

Aufbau:

- `ui/k40.js`: Datenlogik (Werte lesen, Verläufe aufbereiten, welche Werte es gibt)
- `ui/app.js`, `ui/index.html`, `ui/style.css`: Oberfläche
- `src-tauri/src/k40.rs`: Netzwerk (Gateway-Suche, Token, Abruf)
- `mock/`: simuliertes Gateway, `tests/`: Tests

## Quellen und Lizenzen

- API: [bosch-home-comfort/api-docs](https://github.com/bosch-home-comfort/api-docs) (Apache-2.0)
- Testdaten in `tests/fixtures`: [pyk40rf](https://github.com/luc-ass/pyk40rf) (Apache-2.0)
- Diagramme: [Chart.js](https://www.chartjs.org) 4.5.1 (MIT)

Kein offizielles Bosch-Produkt. „Bosch“, „Buderus“ und „Connect-Key“ sind
Marken ihrer Inhaber.
