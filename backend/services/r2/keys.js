// Object-key construction and validation. Keys are ONLY built here, from allowlisted values,
// and every storage call re-validates them (defence in depth against path traversal and
// arbitrary-object access).

import { getInstrument, getTimeframe } from '../../config/catalog.js';
import { EXPORT_ID_RE } from '../../lib/tokens.js';

export const DATA_PREFIX = 'oanda-data/'; // permanent datasets
export const EXPORT_PREFIX = 'exports/'; // temporary CSV exports (the only area cleanup may touch)

const KEY_RE = /^[A-Za-z0-9_\-./]+$/;

export function assertSafeKey(key) {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 300 ||
    !KEY_RE.test(key) ||
    key.includes('..') ||
    key.includes('//') ||
    key.startsWith('/') ||
    !(key.startsWith(DATA_PREFIX) || key.startsWith(EXPORT_PREFIX))
  ) {
    throw new Error('unsafe object key');
  }
  return key;
}

function checkIdentity(instrument, timeframe, year) {
  if (!getInstrument(instrument)) throw new Error('unsupported instrument');
  if (!getTimeframe(timeframe)) throw new Error('unsupported timeframe');
  if (!Number.isInteger(year) || year < 1970 || year > 2200) throw new Error('invalid year');
}

export function datasetKey(instrument, timeframe, year) {
  checkIdentity(instrument, timeframe, year);
  return `${DATA_PREFIX}${instrument}/${timeframe}/${year}.bin`;
}

/** Small JSON next to a yearly dataset listing candles that were skipped as invalid (for the missing-data report). */
export function datasetSkippedKey(instrument, timeframe, year) {
  checkIdentity(instrument, timeframe, year);
  return `${DATA_PREFIX}${instrument}/${timeframe}/${year}.skipped.json`;
}

export function datasetTmpKey(instrument, timeframe, year) {
  return `${datasetKey(instrument, timeframe, year)}.tmp`;
}

export function datasetQuarantineKey(instrument, timeframe, year, stampMs) {
  checkIdentity(instrument, timeframe, year);
  return `${DATA_PREFIX}_quarantine/${instrument}/${timeframe}/${year}.${Math.trunc(stampMs)}.bin`;
}

export function exportKey(exportId) {
  if (!EXPORT_ID_RE.test(exportId)) throw new Error('invalid export id');
  return `${EXPORT_PREFIX}${exportId}.zip`;
}

export const isExportKey = (key) => typeof key === 'string' && key.startsWith(EXPORT_PREFIX) && !key.includes('..');
