// Invalid candles that were SKIPPED while building a yearly dataset (bad OHLC, non-positive price, duplicate,
// misaligned timestamp, ...). They are not in the .bin, so they show up as missing timestamps; this small
// sidecar (oanda-data/<INST>/<TF>/<YEAR>.skipped.json) remembers WHY, so the missing-data report can say so.
// Both the web app and the GitHub Actions script read it straight from R2.

import { datasetSkippedKey } from '../services/r2/keys.js';

export const MAX_SKIPPED_PER_YEAR = 200_000;

/** @returns {Map<string, {ts:number|null, reason:string}>} keyed by `${ts}` (or a unique key when ts is unknown) */
export function emptySkipped() {
  return new Map();
}

export function addSkipped(map, items) {
  for (const { ts, reason } of items) {
    if (map.size >= MAX_SKIPPED_PER_YEAR) return;
    map.set(ts === null ? `x${map.size}:${reason}` : String(ts), { ts, reason });
  }
}

export function encodeSkipped(map) {
  const items = [...map.values()].sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity)).map((i) => [i.ts, i.reason]);
  return Buffer.from(JSON.stringify({ v: 1, items }), 'utf8');
}

export function decodeSkipped(buf) {
  const map = emptySkipped();
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return map;
    addSkipped(
      map,
      parsed.items
        .filter((i) => Array.isArray(i) && (i[0] === null || Number.isInteger(i[0])) && typeof i[1] === 'string')
        .map((i) => ({ ts: i[0], reason: i[1].slice(0, 80) })),
    );
  } catch {
    /* an unreadable sidecar only costs the explanation, never the data */
  }
  return map;
}

export async function loadSkipped(storage, instrument, timeframe, year) {
  const buf = await storage.getObjectBuffer(datasetSkippedKey(instrument, timeframe, year));
  return buf ? decodeSkipped(buf) : emptySkipped();
}

export async function saveSkipped(storage, instrument, timeframe, year, map) {
  await storage.putObject(datasetSkippedKey(instrument, timeframe, year), encodeSkipped(map), { contentType: 'application/json' });
}
