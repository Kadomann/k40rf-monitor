import * as k40 from './k40.js';

const { invoke } = window.__TAURI__.core;
const $ = id => document.getElementById(id);

// --- Gespeicherte Einstellungen ---------------------------------------------
// { host, token, product, found: { tiles: [...], temperatures: [...], energy: [...] } }
const CONFIG_KEY = 'k40-monitor';
let cfg = (() => {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch { return null; }
})();
const saveConfig = () => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));

// --- Fehlermeldungen ---------------------------------------------------------
const MESSAGES = {
  unreachable: 'Das Gateway antwortet nicht. Ist dieses Gerät im selben Netzwerk wie die Heizung?',
  proximity: 'Das Gateway hat die Kopplung abgelehnt. Drück WLAN- und Funk-Taste gleichzeitig etwa eine Sekunde, bis die LEDs blau blinken, und tipp dann gleich auf „Koppeln“. Klappt es weiter nicht: Dieses Gerät muss im selben Netz sein wie das Gateway, nicht im Gäste-WLAN.',
  credentials: 'Login oder Pass passen nicht. Vergleich sie bitte mit dem Aufkleber.',
  unauthorized: 'Der Token wird vom Gateway nicht akzeptiert.',
  token_db_full: 'Der Token-Speicher des Gateways ist voll. Nicht mehr benötigte Tokens müssen erst widerrufen werden, siehe Anleitung im README.',
  no_network: 'Dieses Gerät ist mit keinem lokalen Netzwerk verbunden.',
};
const describe = err => MESSAGES[err?.kind] ?? `Unerwarteter Fehler: ${err?.message ?? err}`;

function status(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

const get = (host, token, path, query = null) => invoke('api_get', { host, token, path, query });
const api = (path, query) => get(cfg.host, cfg.token, path, query);

// --- Einrichtung -----------------------------------------------------------
const STEPS = ['find', 'credentials', 'pair', 'explore'];
const draft = { host: '', login: '', password: '', token: '' };

function showStep(name) {
  for (const s of document.querySelectorAll('[data-step]')) s.hidden = s.dataset.step !== name;
  $('setup-progress').textContent = `Schritt ${STEPS.indexOf(name) + 1} von ${STEPS.length}`;
}

function startSetup() {
  $('dashboard').hidden = true;
  $('setup').hidden = false;
  showStep('find');
  scan();
}

async function scan() {
  $('scan').disabled = true;
  $('found').replaceChildren();
  status('scan-status', 'Suche im Netzwerk …');
  try {
    const ips = await invoke('scan_gateways');
    for (const ip of ips) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Gateway unter ${ip}`;
      b.onclick = () => chooseHost(ip);
      li.append(b);
      $('found').append(li);
    }
    status('scan-status', ips.length
      ? (ips.length === 1 ? 'Ein Gateway gefunden.' : `${ips.length} mögliche Gateways gefunden.`)
      : 'Kein Gateway gefunden. Trag die IP-Adresse unten von Hand ein.');
  } catch (err) {
    status('scan-status', describe(err), true);
  } finally {
    $('scan').disabled = false;
  }
}

function chooseHost(host) {
  draft.host = host.trim();
  showStep('credentials');
}

async function scanSticker() {
  status('credentials-status', '');
  try {
    await invoke('plugin:barcode-scanner|request_permissions').catch(() => {});
    const result = await invoke('plugin:barcode-scanner|scan', { windowed: false, formats: ['QR_CODE'] });
    const creds = k40.parseStickerQr(result.content);
    if (!creds) return status('credentials-status', 'Das ist nicht der QR-Code vom Gateway-Aufkleber.', true);
    $('login').value = creds.login;
    $('pass').value = creds.password;
    status('credentials-status', 'Zugangsdaten übernommen.');
  } catch (err) {
    status('credentials-status', `Scannen nicht möglich: ${err?.message ?? err}`, true);
  }
}

function credentialsNext() {
  draft.login = $('login').value.trim();
  draft.password = k40.normalizePassword($('pass').value);
  if (!draft.login || !/^[0-9a-zA-Z]{16}$/.test(draft.password)) {
    return status('credentials-status', 'Bitte Login und den 16-stelligen Pass vom Aufkleber eingeben.', true);
  }
  status('credentials-status', '');
  showStep('pair');
}

async function checkExistingToken() {
  const token = $('existing-token').value.trim();
  if (!token) return;
  $('token-check').disabled = true;
  status('token-status', 'Prüfe …');
  try {
    await get(draft.host, token, '/gateway/brand');
    draft.token = token;
    runExplore();
  } catch (err) {
    status('token-status', describe(err), true);
  } finally {
    $('token-check').disabled = false;
  }
}

async function pair() {
  $('pair').disabled = true;
  status('pair-status', 'Frage Token an …');
  try {
    draft.token = await invoke('request_token', { host: draft.host, login: draft.login, password: draft.password });
    status('pair-status', '');
    runExplore();
  } catch (err) {
    status('pair-status', describe(err), true);
  } finally {
    $('pair').disabled = false;
  }
}

/** Prüft, welche bekannten Ressourcen das Gateway liefert. */
async function explore(host, token, onProgress) {
  const { tiles, temperatures, energy } = k40.catalog();
  const jobs = [
    ...tiles.map(t => ({ group: 'tiles', key: t.key, path: t.path })),
    ...temperatures.map(t => ({ group: 'temperatures', key: t.key, path: t.path, query: { sampleRate: 'P1M' } })),
    ...energy.map(t => ({ group: 'energy', key: t.key, path: t.path, query: { sampleRate: 'P1M' } })),
  ];
  const found = { tiles: [], temperatures: [], energy: [] };
  let done = 0;
  await Promise.all(jobs.map(async job => {
    try {
      await get(host, token, job.path, job.query);
      found[job.group].push(job.key);
    } catch (err) {
      if (err?.kind === 'unreachable' || err?.kind === 'unauthorized') throw err;
    } finally {
      onProgress(++done, jobs.length);
    }
  }));
  let product = null;
  try {
    const info = await get(host, token, '/system/basicInfo');
    product = info.values?.find(v => v.ProductName)?.ProductName ?? null;
  } catch { /* nicht jede Anlage liefert das */ }
  return { found, product };
}

async function runExplore() {
  showStep('explore');
  $('explore-done').hidden = true;
  try {
    const result = await explore(draft.host, draft.token,
      (n, total) => status('explore-status', `${n} von ${total} möglichen Werten geprüft …`));
    cfg = { host: draft.host, token: draft.token, ...result };
    saveConfig();
    const names = k40.catalog().tiles.filter(t => result.found.tiles.includes(t.key)).map(t => t.label);
    status('explore-status', '');
    $('explore-summary').textContent = `${result.product ? `${result.product}. ` : ''}Gefunden: ${names.join(', ') || 'keine bekannten Werte'}.`;
    $('token-backup').value = draft.token;
    $('explore-done').hidden = false;
  } catch (err) {
    status('explore-status', describe(err), true);
  }
}

// --- Dashboard -------------------------------------------------------------
let range = localStorage.getItem('k40-range') ?? '30d';
const charts = {};
let timer = null;

function startDashboard() {
  $('setup').hidden = true;
  $('dashboard').hidden = false;
  $('product').textContent = cfg.product ?? 'Heizung';
  buildRanges();
  refreshLive();
  loadHistory();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refreshLive(); }, 60_000);
}

function buildRanges() {
  $('ranges').replaceChildren(...Object.entries(k40.RANGES).map(([key, r]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.setAttribute('aria-pressed', String(key === range));
    b.onclick = () => {
      range = key;
      localStorage.setItem('k40-range', key);
      buildRanges();
      loadHistory();
    };
    return b;
  }));
}

function readout(label, value, unit, { text = false, stale = false } = {}) {
  const box = document.createElement('div');
  box.className = `readout${stale ? ' stale' : ''}`;
  const v = document.createElement('span');
  v.className = `readout-value${text ? ' text' : ''}`;
  v.textContent = value;
  if (unit) {
    const u = document.createElement('small');
    u.textContent = unit;
    v.append(u);
  }
  const l = document.createElement('span');
  l.className = 'readout-label';
  l.textContent = label;
  box.append(v, l);
  return box;
}

/** Wenn das Gateway eine neue IP bekommen hat: im Netz suchen, wo der Token passt. */
async function rediscover() {
  status('live-status', 'Gateway nicht erreichbar, suche im Netzwerk …');
  let ips = [];
  try { ips = await invoke('scan_gateways'); } catch { return false; }
  for (const ip of ips.filter(ip => ip !== cfg.host)) {
    try {
      await get(ip, cfg.token, '/gateway/brand');
      cfg.host = ip;
      saveConfig();
      return true;
    } catch { /* nächster Kandidat */ }
  }
  return false;
}

async function refreshLive(retry = true) {
  $('refresh').disabled = true;
  const tiles = k40.catalog().tiles.filter(t => cfg.found.tiles.includes(t.key));
  const results = await Promise.allSettled(tiles.map(t => api(t.path)));
  $('refresh').disabled = false;

  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (tiles.length && errors.length === tiles.length) {
    if (errors[0]?.kind === 'unreachable' && retry && await rediscover()) {
      loadHistory();
      return refreshLive(false);
    }
    const hint = errors[0]?.kind === 'unauthorized' ? ' Unter „Einstellungen“ kannst du die App neu einrichten.' : '';
    status('live-status', describe(errors[0]) + hint, true);
    for (const el of document.querySelectorAll('.readout')) el.classList.add('stale');
    return;
  }

  const boxes = [];
  $('hero').hidden = true;
  tiles.forEach((tile, i) => {
    const r = results[i];
    if (r.status === 'rejected') return boxes.push(readout(tile.label, '–', '', { stale: true }));
    if (tile.emon) {
      const emon = k40.readEmon(r.value);
      const cop = k40.seasonalCop(emon);
      if (cop) boxes.push(readout('Arbeitszahl gesamt', k40.formatNumber(cop, 2), ''));
      if (emon.outputProduced) boxes.push(readout('Wärme gesamt', k40.formatNumber(emon.outputProduced, 0), 'kWh'));
      return;
    }
    const { value, unit, note } = k40.readValue(r.value);
    const shown = value === null ? (note ?? '–')
      : typeof value === 'number' ? k40.formatNumber(value, tile.digits ?? 1) : value;
    const isText = value === null || typeof value !== 'number';
    if (tile.key === 'outdoor' && typeof value === 'number') {
      $('hero').hidden = false;
      $('hero-value').textContent = `${k40.formatNumber(value, 1)}°`;
      return;
    }
    boxes.push(readout(tile.label, shown, isText ? '' : k40.displayUnit(unit), { text: isText }));
  });
  $('readouts').replaceChildren(...boxes);
  status('live-status', `Stand ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function drawChart(id, defs, { type, rate, query, cutoff, digits, unit }) {
  const figure = $(`fig-${id}`);
  if (!defs.length) { figure.hidden = true; return 0; }
  figure.hidden = false;
  const results = await Promise.allSettled(defs.map(d => api(d.path, query)));
  const ok = defs.map((d, i) => [d, results[i]]).filter(([, r]) => r.status === 'fulfilled');
  const lists = ok.map(([, r]) => k40.recordingPoints(r.value, rate).filter(p => p.t >= cutoff));
  const { times, columns } = k40.alignSeries(lists);

  charts[id]?.destroy();
  const muted = cssVar('--muted'), rule = cssVar('--rule'), ink = cssVar('--ink');
  charts[id] = new window.Chart($(`chart-${id}`), {
    type,
    data: {
      labels: times.map(t => k40.formatTime(t, rate)),
      datasets: ok.map(([d], i) => ({
        label: d.label,
        data: columns[i],
        borderColor: cssVar(d.color),
        backgroundColor: cssVar(d.color),
        borderWidth: type === 'line' ? 2 : 0,
        pointRadius: 0,
        tension: 0.25,
        spanGaps: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: ink, boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          callbacks: {
            label: c => c.parsed.y === null ? `${c.dataset.label}: –`
              : `${c.dataset.label}: ${k40.formatNumber(c.parsed.y, digits)} ${unit}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { ticks: { color: muted }, grid: { color: rule }, border: { display: false } },
      },
    },
  });
  return ok.length;
}

let historyRun = 0;
async function loadHistory() {
  const run = ++historyRun;
  const { rate, days } = k40.RANGES[range];
  const opts = {
    rate,
    query: { sampleRate: rate, startDate: k40.startDate(days) },
    cutoff: Date.now() - days * 86400_000,
  };
  const { temperatures, energy } = k40.catalog();
  status('history-status', 'Lade Verlauf …');
  try {
    const counts = await Promise.all([
      drawChart('temp', temperatures.filter(d => cfg.found.temperatures.includes(d.key)), { ...opts, type: 'line', digits: 1, unit: '°C' }),
      drawChart('energy', energy.filter(d => cfg.found.energy.includes(d.key)), { ...opts, type: 'bar', digits: 1, unit: 'kWh' }),
    ]);
    if (run !== historyRun) return;
    status('history-status', counts[0] + counts[1] ? '' : 'Dieses Gateway liefert keine Verlaufsdaten.');
  } catch (err) {
    if (run === historyRun) status('history-status', describe(err), true);
  }
}

// --- Einstellungen ---------------------------------------------------------
function openSettings() {
  $('settings-host').textContent = cfg.host;
  $('settings-product').textContent = cfg.product ?? 'unbekannt';
  $('settings-token').value = cfg.token;
  status('settings-status', '');
  $('settings').showModal();
}

async function reExplore() {
  $('re-explore').disabled = true;
  try {
    const result = await explore(cfg.host, cfg.token,
      (n, total) => status('settings-status', `${n} von ${total} geprüft …`));
    Object.assign(cfg, result);
    saveConfig();
    status('settings-status', 'Fertig.');
    startDashboard();
  } catch (err) {
    status('settings-status', describe(err), true);
  } finally {
    $('re-explore').disabled = false;
  }
}

function reset() {
  if (!confirm('Einrichtung löschen? Der Token bleibt auf dem Gateway gespeichert. Notier ihn dir vorher, wenn du ihn wiederverwenden willst.')) return;
  localStorage.removeItem(CONFIG_KEY);
  cfg = null;
  clearInterval(timer);
  $('settings').close();
  startSetup();
}

async function copy(inputId) {
  const input = $(inputId);
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();   // Fallback: markiert, damit man selbst kopieren kann
  }
}

// --- Verdrahtung -------------------------------------------------------------
$('scan').onclick = scan;
$('host-next').onclick = () => {
  const host = $('host').value.trim();
  if (host) chooseHost(host);
};
$('scan-qr').hidden = !/Android|iPhone|iPad/i.test(navigator.userAgent);
$('scan-qr').onclick = scanSticker;
$('credentials-next').onclick = credentialsNext;
$('token-check').onclick = checkExistingToken;
$('pair').onclick = pair;
$('finish').onclick = startDashboard;
for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => showStep(b.dataset.back);
for (const b of document.querySelectorAll('[data-copy]')) b.onclick = () => copy(b.dataset.copy);

$('refresh').onclick = () => { refreshLive(); loadHistory(); };
$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => $('settings').close();
$('re-explore').onclick = reExplore;
$('reset').onclick = reset;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => cfg && loadHistory());
document.addEventListener('visibilitychange', () => { if (!document.hidden && cfg && !$('dashboard').hidden) refreshLive(); });

if (cfg?.host && cfg?.token && cfg?.found) startDashboard();
else startSetup();
