// Reine Datenlogik ohne Tauri-Abhängigkeit. Wird in tests/ mit Node geprüft.

// Erhöhen, wenn der Katalog neue Werte bekommt: Die App erkundet dann neu.
export const CATALOG_VERSION = 2;

export const HEATING_CIRCUITS = ['hc1', 'hc2', 'hc3', 'hc4'];
export const DHW_CIRCUITS = ['dhw1', 'dhw2'];

// --- Zugangsdaten -----------------------------------------------------------

/** Das Gateway will den Pass vom Aufkleber ohne Bindestriche. */
export function normalizePassword(pass) {
  return pass.replace(/-/g, '').trim();
}

/** Aufkleber-QR: "V:1;L:<login>;P:<pass>;MAC:<mac>;N:<modell>" */
export function parseStickerQr(text) {
  const fields = {};
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (!fields.L || !fields.P) return null;
  return { login: fields.L, password: normalizePassword(fields.P) };
}

// --- Einzelwerte ------------------------------------------------------------

const STATE_LABELS = {
  open: 'Fühler offen', short: 'Kurzschluss', invalid: 'ungültig', off: 'aus',
};
const TEXT_LABELS = {
  on: 'an', off: 'aus', '': 'Ruhe', ch: 'Heizen', dhw: 'Warmwasser', frost: 'Frostschutz',
};

/**
 * Liest eine Ressource. Statische Endpunkte melden Fehler über Sentinel-Werte
 * in `state` (z. B. {"open": -32768}); ein solcher Wert ist keine Messung.
 * Ergebnis: { value: number|string|null, unit, note }
 */
export function readValue(res) {
  const unit = res.unitOfMeasure ?? null;
  if (res.type === 'arrayData') {
    const v = (res.values ?? []).map(x => TEXT_LABELS[x] ?? x).join(', ');
    return { value: v || TEXT_LABELS[''], unit: null, note: null };
  }
  const value = res.value ?? null;
  if (typeof value === 'number' && Array.isArray(res.state)) {
    for (const entry of res.state) {
      for (const [label, sentinel] of Object.entries(entry)) {
        if (sentinel === value) return { value: null, unit, note: STATE_LABELS[label] ?? label };
      }
    }
  }
  if (typeof value === 'string') return { value: TEXT_LABELS[value] ?? value, unit, note: null };
  return { value, unit, note: null };
}

/** emonValue: "values": [{"outputProduced": 1.2}, {"compressor": 0.4}, ...] */
export function readEmon(res) {
  return Object.assign({}, ...(res.values ?? []));
}

/** Arbeitszahl seit Inbetriebnahme: erzeugte Wärme / eingesetzter Strom. */
export function seasonalCop(emon) {
  const input = (emon.compressor ?? 0) + (emon.eheater ?? 0);
  if (!emon.outputProduced || !input) return null;
  return emon.outputProduced / input;
}

// --- Verläufe ---------------------------------------------------------------

export const RANGES = {
  '48h': { rate: 'PT1H', days: 2, label: '48 Stunden' },
  '30d': { rate: 'P1D', days: 30, label: '30 Tage' },
  '12m': { rate: 'P1M', days: 365, label: '12 Monate' },
};

const AVERAGED_UNITS = new Set(['C', '°C', 'K']);

function step(date, rate) {
  const d = new Date(date);
  if (rate === 'PT1H') d.setTime(d.getTime() + 3600_000);
  else if (rate === 'P1D') d.setDate(d.getDate() + 1);
  else if (rate === 'P1M') d.setMonth(d.getMonth() + 1);
  else throw new Error(`unbekannte sampleRate ${rate}`);
  return d;
}

/**
 * Ein Bucket enthält Summe (y) und Anzahl (c) der Messungen. Für Temperaturen
 * ist der Mittelwert y/c gemeint, für Energiemengen die Summe y.
 * Zeitstempel ergeben sich aus startTime plus n-mal sampleRate.
 */
export function recordingPoints(res, rate) {
  const average = AVERAGED_UNITS.has(res.unitOfMeasure);
  const points = [];
  for (const series of res.values ?? []) {
    if (rate && series.sampleRate !== rate) continue;
    let t = new Date(series.startTime);
    for (const bucket of series.recording ?? []) {
      const v = !bucket.c ? null : average ? bucket.y / bucket.c : bucket.y;
      points.push({ t: t.getTime(), v });
      t = step(t, series.sampleRate);
    }
  }
  return points;
}

/** Mehrere Reihen auf gemeinsame Zeitachse legen (fehlende Werte = null). */
export function alignSeries(pointLists) {
  const times = [...new Set(pointLists.flatMap(ps => ps.map(p => p.t)))].sort((a, b) => a - b);
  const columns = pointLists.map(ps => {
    const byTime = new Map(ps.map(p => [p.t, p.v]));
    return times.map(t => byTime.get(t) ?? null);
  });
  return { times, columns };
}

/** Punktweise Summe mehrerer Reihen; null nur, wenn alle Teile fehlen. */
export function sumPoints(...lists) {
  const { times, columns } = alignSeries(lists);
  return times.map((t, i) => {
    const parts = columns.map(c => c[i]).filter(v => v !== null);
    return { t, v: parts.length ? parts.reduce((a, b) => a + b, 0) : null };
  });
}

/** Stromeinsatz: Verdichter + Heizstab, sonst Gesamt-Strom, sonst null. */
export function electricityPoints(byKey) {
  const parts = ['compressor', 'eheater'].filter(k => byKey[k]);
  if (parts.length) return sumPoints(...parts.map(k => byKey[k]));
  return byKey.electricity ?? null;
}

/** Monate oder Jahre zu Summen zusammenfassen (Jahr = 1. Januar). */
export function sumByYear(points) {
  const years = new Map();
  for (const { t, v } of points) {
    const year = new Date(t).getFullYear();
    if (v !== null) years.set(year, (years.get(year) ?? 0) + v);
    else if (!years.has(year)) years.set(year, null);
  }
  return [...years].sort((a, b) => a[0] - b[0]).map(([y, v]) => ({ t: new Date(y, 0, 1).getTime(), v }));
}

/**
 * Arbeitszahl je Zeitraum = Wärme / Strom. Zeiträume mit weniger als
 * `minInput` kWh Strom ergeben keinen sinnvollen Wert (z. B. Sommerpause).
 */
export function copPoints(heat, electricity, minInput = 1) {
  const { times, columns: [h, e] } = alignSeries([heat, electricity]);
  return times.map((t, i) => ({
    t,
    v: h[i] !== null && e[i] !== null && e[i] >= minInput ? h[i] / e[i] : null,
  }));
}

export const ENERGY_MODES = { both: 'Wärme und Strom', heat: 'Wärme', electricity: 'Strom' };
export const COP_PERIODS = { month: 'Monate', year: 'Jahre' };

export function startDate(days, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(t, rate) {
  const d = new Date(t);
  if (rate === 'PT1H') return d.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (rate === 'P1D') return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  if (rate === 'P1Y') return String(d.getFullYear());
  return d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
}

export function formatNumber(value, digits = 1) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// --- Was angezeigt werden kann ----------------------------------------------

function circuitSuffix(id) {
  const n = id.replace(/\D/g, '');
  return n === '1' ? '' : ` ${n}`;
}

/**
 * Alle Anzeigen, die die App kennt. Bei der Einrichtung wird geprüft, welche
 * davon das Gateway tatsächlich liefert; nur diese erscheinen im Dashboard.
 */
export function catalog() {
  const tiles = [
    { key: 'outdoor', label: 'Außen', path: '/system/sensors/temperatures/outdoor_t1', digits: 1 },
    { key: 'supply', label: 'Vorlauf', path: '/heatSources/actualSupplyTemperature', digits: 1 },
    { key: 'return', label: 'Rücklauf', path: '/heatSources/returnTemperature', digits: 1 },
    ...HEATING_CIRCUITS.map(id => ({
      key: `room-${id}`, label: `Raum${circuitSuffix(id)}`, path: `/heatingCircuits/${id}/roomtemperature`, digits: 1,
    })),
    ...HEATING_CIRCUITS.map(id => ({
      key: `setpoint-${id}`, label: `Raum soll${circuitSuffix(id)}`, path: `/heatingCircuits/${id}/currentRoomSetpoint`, digits: 1,
    })),
    ...DHW_CIRCUITS.map(id => ({
      key: `dhw-${id}`, label: `Warmwasser${circuitSuffix(id)}`, path: `/dhwCircuits/${id}/actualTemp`, digits: 1,
    })),
    { key: 'demand', label: 'Betrieb', path: '/heatSources/actualHeatDemand' },
    { key: 'power', label: 'Stromaufnahme', path: '/heatSources/compressor/powerElecActual', digits: 0 },
    { key: 'modulation', label: 'Modulation', path: '/heatSources/actualModulation', digits: 0 },
    { key: 'flame', label: 'Flamme', path: '/heatSources/flameStatus' },
    { key: 'pressure', label: 'Anlagendruck', path: '/heatSources/systemPressure', digits: 1 },
    { key: 'emon', label: 'Energie', path: '/heatSources/emon/totalConsumption', emon: true },
  ];
  const temperatures = [
    { key: 'outdoor', label: 'Außen', path: '/recordings/system/sensors/temperatures/outdoor_t1', color: '--cold' },
    { key: 'supply', label: 'Vorlauf', path: '/recordings/heatSources/actualSupplyTemperature', color: '--hot' },
    ...HEATING_CIRCUITS.map((id, i) => ({
      key: `room-${id}`, label: `Raum${circuitSuffix(id)}`, path: `/recordings/heatingCircuits/${id}/roomtemperature`, color: `--room${i}`,
    })),
    ...DHW_CIRCUITS.map(id => ({
      key: `dhw-${id}`, label: `Warmwasser${circuitSuffix(id)}`, path: `/recordings/dhwCircuits/${id}/actualTemp`, color: '--water',
    })),
  ];
  // Strom wird aus Verdichter + Heizstab gebildet (wie die Arbeitszahl),
  // die Gesamt-Stromaufzeichnung ist nur Ersatz, falls diese fehlen.
  const energy = [
    { key: 'heat', label: 'Wärme erzeugt', path: '/recordings/heatSources/emon/total/outputProduced', color: '--hot' },
    { key: 'compressor', path: '/recordings/heatSources/emon/total/compressor' },
    { key: 'eheater', path: '/recordings/heatSources/emon/total/eheater' },
    { key: 'electricity', path: '/recordings/heatSources/emon/total/electricity' },
    { key: 'burner', label: 'Brennstoff', path: '/recordings/heatSources/emon/total/burner', color: '--fuel' },
  ];
  return { tiles, temperatures, energy };
}

const UNIT_DISPLAY = { C: '°C', K: 'K', bar: 'bar', W: 'W', kW: 'kW', kWh: 'kWh', '%': '%' };
export function displayUnit(unit) {
  return unit ? UNIT_DISPLAY[unit] ?? unit : '';
}
