// Aufruf: node --test tests/
// Die Dateien in tests/fixtures sind echte, anonymisierte Antworten eines K 40 RF
// aus dem Projekt pyk40rf (Apache-2.0), siehe tests/fixtures/NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as k40 from '../ui/k40.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test('Pass vom Aufkleber ohne Bindestriche', () => {
  assert.equal(k40.normalizePassword(' aaaa-bbbb-cccc-dddd '), 'aaaabbbbccccdddd');
});

test('Aufkleber-QR wird gelesen, auch mit Doppelpunkten in der MAC', () => {
  assert.deepEqual(
    k40.parseStickerQr('V:1;L:100000001;P:aaaa-bbbb-cccc-dddd;MAC:aa:bb:cc:dd:ee:ff;N:K40RF'),
    { login: '100000001', password: 'aaaabbbbccccdddd' },
  );
  assert.equal(k40.parseStickerQr('irgendein anderer QR-Code'), null);
});

test('normale Messung', () => {
  assert.deepEqual(k40.readValue(fixture('heatSources_returnTemperature')), { value: 36, unit: 'C', note: null });
});

test('Sentinel-Wert ist keine Messung', () => {
  const res = { ...fixture('heatSources_returnTemperature'), value: -32768 };
  assert.deepEqual(k40.readValue(res), { value: null, unit: 'C', note: 'Fühler offen' });
  assert.equal(k40.readValue(fixture('heatingCircuits_hc1_currentRoomSetpoint')).note, 'aus');
});

test('Texte und Listen werden übersetzt', () => {
  assert.equal(k40.readValue(fixture('heatSources_flameStatus')).value, 'aus');
  assert.equal(k40.readValue(fixture('heatSources_actualHeatDemand')).value, 'Ruhe');
  assert.equal(k40.readValue({ type: 'arrayData', values: ['ch', 'dhw'] }).value, 'Heizen, Warmwasser');
});

test('Arbeitszahl aus Energiezählern', () => {
  const emon = k40.readEmon(fixture('heatSources_emon_totalConsumption'));
  assert.equal(emon.outputProduced, 18312.99);
  assert.equal(k40.seasonalCop(emon).toFixed(2), '3.53');
  assert.equal(k40.seasonalCop({ outputProduced: 5 }), null);
});

test('Temperatur-Recording: Mittelwert = Summe / Anzahl, Tage fortlaufend', () => {
  const points = k40.recordingPoints(fixture('recordings_heatingCircuits_hc1_roomtemperature_sampleRate_P1D'), 'P1D');
  assert.ok(points.length > 200);
  assert.equal(points[0].v.toFixed(2), (18535.29 / 892).toFixed(2));
  for (const p of points) if (p.v !== null) assert.ok(p.v > 10 && p.v < 30, `unplausibel: ${p.v}`);
  // Über die Zeitumstellung hinweg bleibt es Mitternacht Ortszeit (Gerät in derselben Zeitzone).
  const d0 = new Date(points[0].t), d100 = new Date(points[100].t);
  assert.equal(d100.getHours(), d0.getHours());
});

test('Energie-Recording: Summe pro Bucket, leere Buckets sind null', () => {
  const res = {
    unitOfMeasure: 'kWh',
    values: [{ sampleRate: 'PT1H', startTime: '2026-11-01T00:00:00+01:00', recording: [{ y: 2.5, c: 60 }, { y: 0, c: 0 }] }],
  };
  const points = k40.recordingPoints(res, 'PT1H');
  assert.deepEqual(points.map(p => p.v), [2.5, null]);
  assert.equal(points[1].t - points[0].t, 3600_000);
});

test('Reihen mit unterschiedlichem Beginn werden ausgerichtet', () => {
  const { times, columns } = k40.alignSeries([[{ t: 1, v: 10 }, { t: 2, v: 11 }], [{ t: 2, v: 20 }, { t: 3, v: 21 }]]);
  assert.deepEqual(times, [1, 2, 3]);
  assert.deepEqual(columns, [[10, 11, null], [null, 20, 21]]);
});

test('Katalog: jeder Pfad steht in der Bosch-Spezifikation', () => {
  const spec = readFileSync(new URL('./fixtures/spec-paths.txt', import.meta.url), 'utf8').split('\n');
  const known = new Set(spec.map(s => s.trim()).filter(Boolean));
  const { tiles, temperatures, energy } = k40.catalog();
  for (const { path } of [...tiles, ...temperatures, ...energy]) {
    const generic = path
      .replace(/\/hc\d/, '/{heatingCircuitId}')
      .replace(/\/dhw\d/, '/{dhwCircuitId}');
    assert.ok(known.has(generic), `nicht in der Spezifikation: ${path}`);
  }
});

test('Strom = Verdichter + Heizstab, Ersatz Gesamt-Strom', () => {
  const compressor = [{ t: 1, v: 2 }, { t: 2, v: 3 }, { t: 3, v: null }];
  const eheater = [{ t: 1, v: 0.5 }, { t: 3, v: null }];
  assert.deepEqual(k40.electricityPoints({ compressor, eheater }).map(p => p.v), [2.5, 3, null]);
  const electricity = [{ t: 1, v: 9 }];
  assert.deepEqual(k40.electricityPoints({ electricity }), electricity);
  assert.equal(k40.electricityPoints({}), null);
});

test('Jahressummen aus Monaten', () => {
  const m = (y, mo, v) => ({ t: new Date(y, mo, 1).getTime(), v });
  const years = k40.sumByYear([m(2025, 10, 100), m(2025, 11, 200), m(2026, 0, 300), m(2026, 1, null)]);
  assert.deepEqual(years.map(p => [new Date(p.t).getFullYear(), p.v]), [[2025, 300], [2026, 300]]);
});

test('Arbeitszahl je Zeitraum, ohne Ausreißer bei kaum Strom', () => {
  const heat = [{ t: 1, v: 300 }, { t: 2, v: 5 }, { t: 3, v: 40 }];
  const elec = [{ t: 1, v: 100 }, { t: 2, v: 0.2 }, { t: 3, v: null }];
  assert.deepEqual(k40.copPoints(heat, elec).map(p => p.v), [3, null, null]);
  // Jahres-Arbeitszahl aus Summen, nicht aus dem Mittel der Monatswerte
  const y = k40.copPoints(k40.sumByYear([{ t: 0, v: 400 }, { t: 1, v: 100 }]), k40.sumByYear([{ t: 0, v: 100 }, { t: 1, v: 100 }]));
  assert.equal(y[0].v, 2.5);
});

test('Leere Recording-Antwort wird erkannt', () => {
  assert.equal(k40.hasBuckets({ values: [] }), false);
  assert.equal(k40.hasBuckets({ values: [{ recording: [] }] }), false);
  assert.equal(k40.hasBuckets(fixture('recordings_heatingCircuits_hc1_roomtemperature_sampleRate_P1D')), true);
});
