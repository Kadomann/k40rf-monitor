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
    cfg = { host: draft.host, token: draft.token, catalogVersion: k40.CATALOG_VERSION, ...result };
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

async function startDashboard() {
  $('setup').hidden = true;
  $('dashboard').hidden = false;
  $('product').textContent = cfg.product ?? 'Heizung';
  buildControls();
  if (cfg.catalogVersion !== k40.CATALOG_VERSION) {
    // Neue App-Version kennt neue Werte: einmal nachsehen, welche das Gateway liefert.
    status('live-status', 'Prüfe, welche Werte dein Gateway liefert …');
    try {
      Object.assign(cfg, await explore(cfg.host, cfg.token, () => {}), { catalogVersion: k40.CATALOG_VERSION });
      saveConfig();
    } catch (err) {
      status('live-status', describe(err), true);
    }
  }
  refreshLive();
  loadHistory();
  loadCop();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refreshLive(); }, 60_000);
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
      loadCop();
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

/** Holt Recordings parallel. Ergebnis: { key: points } für alle erfolgreichen Abrufe. */
async function fetchRecordings(defs, query, rate, cutoff = -Infinity) {
  const results = await Promise.allSettled(defs.map(async d => {
    const res = await api(d.path, query);
    // Manche Gateways liefern z. B. Stundenwerte von Temperaturen nur ohne startDate.
    // Dann ohne nachfragen; den Zeitraum schneidet cutoff unten selbst zu.
    if (query.startDate && !k40.hasBuckets(res)) return api(d.path, { sampleRate: query.sampleRate });
    return res;
  }));
  const byKey = {};
  defs.forEach((d, i) => {
    if (results[i].status === 'fulfilled') {
      byKey[d.key] = k40.recordingPoints(results[i].value, rate).filter(p => p.t >= cutoff);
    }
  });
  return byKey;
}

/**
 * Zeichnet ein Diagramm. series: [{ label, color, points, order? }].
 * overlay: Balken liegen übereinander statt nebeneinander (kleinere Reihe vorn).
 */
function renderChart(id, type, series, { rate, digits, unit, emptyText, overlay = false, footer = null }) {
  const figure = $(`fig-${id}`);
  const empty = figure.querySelector('.chart-empty');
  const box = figure.querySelector('.chart');
  charts[id]?.destroy();
  charts[id] = null;
  const { times, columns } = k40.alignSeries(series.map(s => s.points));
  const hasData = columns.some(c => c.some(v => v !== null));
  empty.textContent = emptyText;
  empty.hidden = hasData;
  box.hidden = !hasData;
  if (!hasData) return;

  const muted = cssVar('--muted'), rule = cssVar('--rule'), ink = cssVar('--ink');
  const withUnit = v => `${k40.formatNumber(v, digits)}${unit ? ` ${unit}` : ''}`;
  charts[id] = new window.Chart($(`chart-${id}`), {
    type,
    data: {
      labels: times.map(t => k40.formatTime(t, rate)),
      datasets: series.map((s, i) => ({
        label: s.label,
        data: columns[i],
        order: s.order ?? i,
        grouped: !overlay,
        borderColor: cssVar(s.color),
        backgroundColor: cssVar(s.color),
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
        legend: { display: series.length > 1, position: 'bottom', labels: { color: ink, boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${c.parsed.y === null ? '–' : withUnit(c.parsed.y)}`,
            footer: footer ?? (() => ''),
          },
        },
      },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: type === 'bar', ticks: { color: muted }, grid: { color: rule }, border: { display: false } },
      },
    },
  });
}

/** Umschalter aus Knöpfen; options: { key: Beschriftung } */
function segmented(id, options, current, onPick) {
  $(id).replaceChildren(...Object.entries(options).map(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === current));
    b.onclick = () => onPick(key);
    return b;
  }));
}

let energyMode = localStorage.getItem('k40-energy') ?? 'both';
let copPeriod = localStorage.getItem('k40-cop') ?? 'month';
let energyData = null;   // { rate, byKey } des gewählten Zeitraums
let copData = null;      // { heat, elec } je Monat

function buildControls() {
  const rangeLabels = Object.fromEntries(Object.entries(k40.RANGES).map(([k, r]) => [k, r.label]));
  segmented('ranges', rangeLabels, range, key => {
    range = key;
    localStorage.setItem('k40-range', key);
    buildControls();
    loadHistory();
  });
  segmented('energy-modes', k40.ENERGY_MODES, energyMode, key => {
    energyMode = key;
    localStorage.setItem('k40-energy', key);
    buildControls();
    renderEnergy();
  });
  segmented('cop-periods', k40.COP_PERIODS, copPeriod, key => {
    copPeriod = key;
    localStorage.setItem('k40-cop', key);
    buildControls();
    renderCop();
  });
}

const found = group => k40.catalog()[group].filter(d => cfg.found[group].includes(d.key));

async function loadTemperatures(opts, run) {
  const defs = found('temperatures');
  $('fig-temp').hidden = !defs.length;
  if (!defs.length) return;
  const byKey = await fetchRecordings(defs, opts.query, opts.rate, opts.cutoff);
  if (run !== historyRun) return;
  renderChart('temp', 'line',
    defs.filter(d => byKey[d.key]).map(d => ({ label: d.label, color: d.color, points: byKey[d.key] })),
    { rate: opts.rate, digits: 1, unit: '°C', emptyText: `Das Gateway hat für „${k40.RANGES[range].label}“ keine Temperaturwerte geliefert.` });
}

async function loadEnergy(opts, run) {
  const defs = found('energy');
  $('fig-energy').hidden = !defs.length;
  if (!defs.length) return;
  const byKey = await fetchRecordings(defs, opts.query, opts.rate, opts.cutoff);
  if (run !== historyRun) return;
  energyData = { rate: opts.rate, byKey };
  renderEnergy();
}

function copFooter(items) {
  const heat = items.find(i => i.dataset.label === 'Wärme erzeugt')?.parsed.y;
  const elec = items.find(i => i.dataset.label === 'Strom')?.parsed.y;
  return heat && elec >= 0.05 ? `Arbeitszahl ${k40.formatNumber(heat / elec, 2)}` : '';
}

function renderEnergy() {
  if (!energyData) return;
  const { rate, byKey } = energyData;
  const elec = k40.electricityPoints(byKey);
  const canSwitch = Boolean(byKey.heat && elec);
  $('energy-modes').hidden = !canSwitch;
  const mode = canSwitch ? energyMode : 'both';
  const series = [];
  // Strom liegt vorn im Wärmebalken: sichtbar, welcher Teil der Wärme aus Strom stammt.
  if (mode !== 'heat' && elec) series.push({ label: 'Strom', color: '--power', points: elec, order: 0 });
  if (mode !== 'electricity' && byKey.heat) series.push({ label: 'Wärme erzeugt', color: '--hot', points: byKey.heat, order: 1 });
  if (mode !== 'electricity' && byKey.burner) series.push({ label: 'Brennstoff', color: '--fuel', points: byKey.burner, order: 2 });
  renderChart('energy', 'bar', series, {
    rate, digits: 1, unit: 'kWh', overlay: true,
    footer: mode === 'both' ? copFooter : null,
    emptyText: `Das Gateway hat für „${k40.RANGES[range].label}“ keine Energiewerte geliefert.`,
  });
}

async function loadCop() {
  const defs = found('energy').filter(d => ['heat', 'compressor', 'eheater', 'electricity'].includes(d.key));
  const byKey = defs.length ? await fetchRecordings(defs, { sampleRate: 'P1M' }, 'P1M') : {};
  const elec = k40.electricityPoints(byKey);
  copData = byKey.heat && elec ? { heat: byKey.heat, elec } : null;
  $('fig-cop').hidden = !copData;
  renderCop();
}

function renderCop() {
  if (!copData) return;
  const yearly = copPeriod === 'year';
  const heat = yearly ? k40.sumByYear(copData.heat) : copData.heat;
  const elec = yearly ? k40.sumByYear(copData.elec) : copData.elec;
  renderChart('cop', 'bar', [{ label: 'Arbeitszahl', color: '--water', points: k40.copPoints(heat, elec) }], {
    rate: yearly ? 'P1Y' : 'P1M', digits: 2, unit: '',
    emptyText: 'Noch kein Zeitraum mit genug Daten für eine Arbeitszahl.',
  });
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
  status('history-status', 'Lade Verlauf …');
  try {
    await Promise.all([loadTemperatures(opts, run), loadEnergy(opts, run)]);
    if (run === historyRun) status('history-status', '');
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
    Object.assign(cfg, result, { catalogVersion: k40.CATALOG_VERSION });
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

$('refresh').onclick = () => { refreshLive(); loadHistory(); loadCop(); };
$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => $('settings').close();
$('re-explore').onclick = reExplore;
$('reset').onclick = reset;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (cfg) { loadHistory(); loadCop(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && cfg && !$('dashboard').hidden) refreshLive(); });

if (cfg?.host && cfg?.token && cfg?.found) startDashboard();
else startSetup();
