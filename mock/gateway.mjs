// Simuliertes K 40 RF für Tests ohne echte Heizung.
// Start: node mock/gateway.mjs   (braucht openssl für das Testzertifikat)
//
// Verhält sich wie in der Bosch-Doku beschrieben:
//   Port 9442: POST /auth/token (Formular), 412 ohne Tastendruck, 400 bei falschen Daten
//   Port 9443: GET mit Bearer-Token, 401 ohne Token, 404 für nicht vorhandene Ressourcen
// Tastendruck simulieren: Enter im Terminal, oder POST https://<host>:9442/mock/press
// Zugangsdaten des Simulators: Login 100000001, Pass aaaa-bbbb-cccc-dddd

import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOGIN = '100000001';
const PASS = 'aaaabbbbccccdddd';
const TOKEN = 'mock-token-4f1c2a9e';
const PRESS_WINDOW_MS = 5 * 60_000;

let pressedUntil = process.env.MOCK_PRESSED ? Infinity : 0;

// --- Zertifikat (CN = Geräte-ID, wie beim echten Gerät) ---------------------
const dir = fileURLToPath(new URL('.', import.meta.url));
const keyFile = `${dir}key.pem`, certFile = `${dir}cert.pem`;
if (!existsSync(certFile)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
    '-out', certFile, '-days', '3650', '-subj', `/CN=${LOGIN}`], { stdio: 'ignore' });
}
const tls = { key: readFileSync(keyFile), cert: readFileSync(certFile) };

// --- Simulierte Anlage: Wärmepumpe, ein Heizkreis, ein Warmwasserkreis ------
const hours = t => t / 3600_000;
const outdoor = t => 6 + 5 * Math.sin((hours(t) - 9) / 24 * 2 * Math.PI) - 4 * Math.cos(t / 3.15e10 * 2 * Math.PI);
const supply = t => 36 - 0.6 * outdoor(t);
const room = t => 21 + 0.4 * Math.sin(hours(t) / 24 * 2 * Math.PI);
const dhw = t => 46 + 4 * Math.sin(hours(t) / 12 * 2 * Math.PI);
const heatKw = t => Math.max(0, 0.9 * (20 - outdoor(t)) / 10);          // kWh je Stunde
const elecKw = t => heatKw(t) / (3 + 0.08 * outdoor(t));

const now = () => Date.now();
const float = (id, value, unitOfMeasure, state = [{ open: -32768.0 }, { short: 32767.0 }]) =>
  ({ id, type: 'floatValue', writeable: 0, value: Math.round(value * 10) / 10, unitOfMeasure, state });

const resources = {
  '/gateway/brand': () => ({ id: '/gateway/brand', type: 'stringValue', writeable: 0, value: 'Bosch' }),
  '/system/basicInfo': () => ({
    id: '/system/basicInfo', type: 'systeminfo', writeable: 0, gatewayId: LOGIN,
    values: [{ ModuleHwIdentStr: 'XCU_THH', ProductName: 'Compress CS5800iAW 12 MB', Id: '8' }],
  }),
  '/system/sensors/temperatures/outdoor_t1': () => float('/system/sensors/temperatures/outdoor_t1', outdoor(now()), 'C'),
  '/heatSources/actualSupplyTemperature': () => float('/heatSources/actualSupplyTemperature', supply(now()), 'C'),
  '/heatSources/returnTemperature': () => float('/heatSources/returnTemperature', supply(now()) - 4, 'C'),
  '/heatSources/systemPressure': () => float('/heatSources/systemPressure', 1.4, 'bar', [{ invalid: 255.0 }]),
  '/heatSources/compressor/powerElecActual': () => ({ ...float('/heatSources/compressor/powerElecActual', elecKw(now()) * 1000, 'W'), state: undefined }),
  '/heatSources/actualHeatDemand': () => ({ id: '/heatSources/actualHeatDemand', type: 'arrayData', writeable: 0, values: ['ch'] }),
  '/heatingCircuits/hc1/roomtemperature': () => float('/heatingCircuits/hc1/roomtemperature', room(now()), 'C'),
  '/heatingCircuits/hc1/currentRoomSetpoint': () => float('/heatingCircuits/hc1/currentRoomSetpoint', 21, 'C', [{ off: 0.0 }]),
  '/dhwCircuits/dhw1/actualTemp': () => float('/dhwCircuits/dhw1/actualTemp', dhw(now()), 'C'),
  '/heatSources/emon/totalConsumption': () => ({
    id: '/heatSources/emon/totalConsumption', type: 'emonValue', writeable: 0, unit: 'kWh',
    values: [{ outputProduced: 18312.99 }, { eheater: 0.15 }, { compressor: 5185.09 }],
  }),
};

const recordings = {
  '/recordings/system/sensors/temperatures/outdoor_t1': { unit: 'C', f: outdoor, sum: false },
  '/recordings/heatSources/actualSupplyTemperature': { unit: 'C', f: supply, sum: false },
  '/recordings/heatingCircuits/hc1/roomtemperature': { unit: 'C', f: room, sum: false },
  '/recordings/dhwCircuits/dhw1/actualTemp': { unit: 'C', f: dhw, sum: false },
  '/recordings/heatSources/emon/total/outputProduced': { unit: 'kWh', f: heatKw, sum: true },
  '/recordings/heatSources/emon/total/electricity': { unit: 'kWh', f: elecKw, sum: true },
};

function isoLocal(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function recording(path, query) {
  const def = recordings[path];
  const rate = query.get('sampleRate');
  if (!['PT1H', 'P1D', 'P1M'].includes(rate)) return [400, { error: 'sampleRate required' }];
  const start = query.get('startDate') ? new Date(`${query.get('startDate')}T00:00:00`) : new Date(now() - 60 * 86400_000);
  if (rate === 'P1D') start.setHours(0);
  if (rate === 'P1M') start.setDate(1), start.setHours(0);
  start.setMinutes(0, 0, 0);
  const buckets = [];
  for (let t = new Date(start); t.getTime() < now();) {
    const next = new Date(t);
    if (rate === 'PT1H') next.setHours(next.getHours() + 1);
    if (rate === 'P1D') next.setDate(next.getDate() + 1);
    if (rate === 'P1M') next.setMonth(next.getMonth() + 1);
    const samples = Math.round((Math.min(next, now()) - t) / 60_000);   // ein Sample je Minute
    let y = 0;
    for (let i = 0; i < samples; i++) y += def.sum ? def.f(t.getTime() + i * 60_000) / 60 : def.f(t.getTime() + i * 60_000);
    buckets.push({ y: Math.round(y * 100) / 100, c: samples });
    t = next;
  }
  return [200, {
    id: `${path}?sampleRate=${rate}`, type: 'yRecordingExtended', writeable: 0, unitOfMeasure: def.unit,
    recordedResource: { id: path.replace('/recordings', ''), uri: `https://192.0.2.10:9443${path.replace('/recordings', '')}` },
    recordingType: 'actual',
    values: [{ startTime: isoLocal(start), sampleRate: rate, endTime: isoLocal(new Date()), recording: buckets }],
  }];
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => resolve(b)); });
}

const auth = https.createServer(tls, async (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (req.method === 'POST' && url.pathname === '/mock/press') {
    pressedUntil = now() + PRESS_WINDOW_MS;
    return send(res, 200, { pressed: true });
  }
  if (req.method !== 'POST' || url.pathname !== '/auth/token') return send(res, 404, { error: 'not found' });
  if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) {
    return send(res, 415, { error: 'Unsupported Media Type' });
  }
  const form = new URLSearchParams(await readBody(req));
  if (now() > pressedUntil) return send(res, 412, { error: 'physical_proximity_unproven' });
  if (form.get('grant_type') !== 'password' || form.get('username') !== LOGIN || form.get('password') !== PASS) {
    return send(res, 400, { error: 'invalid_grant' });
  }
  console.log(`Token ausgegeben an "${form.get('client_name')}"`);
  send(res, 200, { access_token: TOKEN, token_type: 'Bearer', scope: 'open_api.read' });
});

const data = https.createServer(tls, (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Unauthorized' });
  if (url.pathname in recordings) return send(res, ...recording(url.pathname, url.searchParams));
  const make = resources[url.pathname];
  if (!make) return send(res, 404, { error: 'not found' });
  send(res, 200, make());
});

auth.listen(9442, () => console.log('Simuliertes Gateway: Token auf 9442, Daten auf 9443'));
data.listen(9443);
console.log(`Login ${LOGIN}, Pass aaaa-bbbb-cccc-dddd. Enter drücken = WLAN- und Funktaste drücken.`);
process.stdin.on('data', () => {
  pressedUntil = now() + PRESS_WINDOW_MS;
  console.log('Tasten gedrückt, Token kann 5 Minuten lang angefordert werden.');
});
