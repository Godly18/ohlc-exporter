// Binance Spot market data (public endpoints, no API key).
//
// Strategy (per the requirement "use the monthly archive when the month is available, otherwise the API"):
//   1. For any day inside a month that has fully ended, try the public MONTHLY archive
//      (data.binance.vision/data/spot/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-<YYYY-MM>.zip). The whole
//      month is downloaded once, its SHA-256 is verified against the published .CHECKSUM file, and the
//      days are served from memory.
//   2. If the month is not in the archive (yet), or the archive cannot be verified, fall back to the Spot
//      REST API (klines, max 1000 candles per request, so a day is 2 requests).
// Timestamps: archive files switched from milliseconds to MICROseconds in 2025; both are handled.

import { getInstrument, getTimeframe } from '../../config/catalog.js';
import { parseDecimalScaled } from '../../lib/decimal.js';
import { SourceError } from '../../lib/errors.js';
import { addDays, dayStartMs, utcDateOf } from '../../lib/time.js';
import { unzipSingle } from '../../lib/unzip.js';
import { yieldToLoop } from '../../lib/yield.js';
import { createRequester } from '../sources/http.js';

const DECIMALS = 8;
const PAGE_LIMIT = 1000;
const NEGATIVE_CACHE_MS = 30 * 60_000;

function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Parse one monthly archive CSV into Map<YYYY-MM-DD, candle[]>. Exported for tests. */
export async function parseArchiveCsv(text, ym) {
  const days = new Map();
  let line = 0;
  let cachedDayNo = -1;
  let cachedDate = '';
  let from = 0;
  while (from < text.length) {
    let nl = text.indexOf('\n', from);
    if (nl === -1) nl = text.length;
    const raw = text.slice(from, nl).trim();
    from = nl + 1;
    if (!raw) continue;
    if (++line % 5000 === 0) await yieldToLoop();
    const cols = raw.split(',');
    if (!/^\d+$/.test(cols[0])) {
      if (line === 1) continue; // header row (some archives have one)
      throw new SourceError('malformed archive row');
    }
    if (cols.length < 6) throw new SourceError('malformed archive row');
    const rawTs = Number(cols[0]);
    const ms = cols[0].length >= 16 ? Math.floor(rawTs / 1000) : rawTs; // microseconds since 2025
    if (!Number.isSafeInteger(ms) || ms % 60_000 !== 0) throw new SourceError('malformed archive timestamp');
    const o = parseDecimalScaled(cols[1], DECIMALS);
    const h = parseDecimalScaled(cols[2], DECIMALS);
    const l = parseDecimalScaled(cols[3], DECIMALS);
    const c = parseDecimalScaled(cols[4], DECIMALS);
    const v = parseDecimalScaled(cols[5], DECIMALS);
    if (o === null || h === null || l === null || c === null || v === null) throw new SourceError('malformed archive price');
    const dayNo = Math.floor(ms / 86_400_000);
    if (dayNo !== cachedDayNo) {
      cachedDayNo = dayNo;
      cachedDate = new Date(dayNo * 86_400_000).toISOString().slice(0, 10);
    }
    if (!cachedDate.startsWith(ym)) continue; // belongs to a neighbouring month: not ours to serve
    let arr = days.get(cachedDate);
    if (!arr) days.set(cachedDate, (arr = []));
    arr.push({ ts: ms / 1000, o, h, l, c, v });
  }
  return days;
}

export function createBinanceClient({ binance, logger, clock = Date.now, fetchImpl = globalThis.fetch, sleepFn }) {
  const http = createRequester({
    name: 'Binance',
    delayMs: binance.requestDelayMs,
    timeoutMs: binance.timeoutMs,
    maxRetries: binance.maxRetries,
    logger,
    fetchImpl,
    ...(sleepFn ? { sleepFn } : {}),
  });

  const monthCache = new Map(); // `${symbol}|${interval}|${ym}` -> { days: Map|null, at }
  const MAX_CACHED_MONTHS = 2;

  function remember(key, days) {
    monthCache.delete(key);
    monthCache.set(key, { days, at: clock() });
    while (monthCache.size > MAX_CACHED_MONTHS) monthCache.delete(monthCache.keys().next().value);
  }

  async function downloadMonth(symbol, interval, ym, signal) {
    const base = `${binance.archiveBase}/data/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const zip = await http.get(base, { signal, as: 'buffer', notFoundOk: true });
      if (!zip) return null; // not published (yet) / pair not listed that month
      const checksumText = await http.get(`${base}.CHECKSUM`, { signal, as: 'text', notFoundOk: true });
      const expected = checksumText ? /^[0-9a-fA-F]{64}/.exec(checksumText.trim())?.[0]?.toLowerCase() : null;
      if (!expected) {
        logger.warn('Binance archive has no usable checksum; not trusting it', { symbol, ym });
        return null;
      }
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(zip).digest('hex');
      if (actual !== expected) {
        logger.warn('Binance archive checksum mismatch', { symbol, ym, attempt: attempt + 1 });
        continue;
      }
      const { data } = await unzipSingle(zip);
      return parseArchiveCsv(data.toString('utf8'), ym);
    }
    return null;
  }

  async function loadMonth(symbol, interval, ym, signal) {
    const key = `${symbol}|${interval}|${ym}`;
    const hit = monthCache.get(key);
    if (hit && (hit.days || clock() - hit.at < NEGATIVE_CACHE_MS)) return hit.days;
    let days = null;
    try {
      days = await downloadMonth(symbol, interval, ym, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      logger.warn('Binance monthly archive unusable; falling back to the API', { symbol, ym, error: err });
    }
    logger.info(days ? 'Binance monthly archive loaded' : 'Binance monthly archive not available; using the API', { symbol, ym });
    remember(key, days);
    return days;
  }

  async function fetchDayFromApi({ symbol, interval, date, signal }) {
    const start = dayStartMs(date);
    const end = dayStartMs(addDays(date, 1));
    const candles = [];
    let incompleteCount = 0;
    let cursor = start;
    for (let page = 0; page < 4 && cursor < end; page++) {
      const query = new URLSearchParams({ symbol, interval, startTime: String(cursor), endTime: String(end - 1), limit: String(PAGE_LIMIT) });
      const rows = await http.get(`${binance.apiBase}/api/v3/klines?${query}`, { signal });
      if (!Array.isArray(rows)) throw new SourceError('malformed Binance response');
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 7) throw new SourceError('malformed Binance candle');
        const openMs = Number(r[0]);
        const o = parseDecimalScaled(r[1], DECIMALS);
        const h = parseDecimalScaled(r[2], DECIMALS);
        const l = parseDecimalScaled(r[3], DECIMALS);
        const c = parseDecimalScaled(r[4], DECIMALS);
        const v = parseDecimalScaled(r[5], DECIMALS);
        if (!Number.isSafeInteger(openMs) || openMs % 60_000 !== 0 || o === null || h === null || l === null || c === null || v === null) {
          throw new SourceError('malformed Binance candle');
        }
        if (openMs < start || openMs >= end) continue;
        if (Number(r[6]) >= clock()) incompleteCount++; // still open
        candles.push({ ts: openMs / 1000, o, h, l, c, v });
      }
      if (rows.length < PAGE_LIMIT) break;
      cursor = Number(rows[rows.length - 1][0]) + 60_000;
    }
    return { candles, incompleteCount };
  }

  return {
    /**
     * Every candle of one UTC calendar day. Returns { candles, incompleteCount, via: 'archive'|'api' }.
     */
    async fetchDayCandles({ instrument, timeframe, date, signal }) {
      const inst = getInstrument(instrument);
      const tf = getTimeframe(timeframe);
      if (!inst || inst.provider !== 'binance' || !tf) throw new SourceError('unsupported instrument or timeframe for Binance');
      const symbol = inst.providerSymbol;
      const interval = tf.binanceInterval;
      const ym = date.slice(0, 7);

      // Only months that have completely ended can be in the archive.
      if (binance.archiveEnabled && addDays(lastDayOfMonth(ym), 1) <= utcDateOf(clock())) {
        const days = await loadMonth(symbol, interval, ym, signal);
        if (days) return { candles: days.get(date) ?? [], incompleteCount: 0, via: 'archive' };
      }
      return { ...(await fetchDayFromApi({ symbol, interval, date, signal })), via: 'api' };
    },
  };
}
