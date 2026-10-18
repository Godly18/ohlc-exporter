// Dedicated OANDA v20 REST client. Server-side only: the token never leaves this module's config.
//
// Strategy: ONE request per UTC calendar day (an M1 day has at most 1440 candles, far below
// OANDA's 5000-candle response limit, so a day is a single, complete, easily verifiable batch).
// Requests are spaced out (no hammering), time out, and retry only transient failures with
// bounded exponential backoff. There are no infinite loops.

import { getTimeframe } from '../../config/catalog.js';
import { MAX_SCALED_PRICE, PRICE_SCALE } from '../../lib/candles.js';
import { OandaError } from '../../lib/errors.js';
import { addDays, dayStartMs, formatIsoSeconds } from '../../lib/time.js';
import { sleep } from '../../lib/yield.js';

export const OANDA_MAX_CANDLES_PER_REQUEST = 5000;
const TIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

/** "1.07123" -> 107123 (scaled by 1e5). Rejects anything that cannot be stored losslessly. */
export function parsePrice(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new OandaError('malformed price');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new OandaError('malformed price');
  const scaled = Math.round(n * PRICE_SCALE);
  if (Math.abs(n * PRICE_SCALE - scaled) > 1e-3) throw new OandaError('price has more than 5 decimals');
  if (scaled > MAX_SCALED_PRICE) throw new OandaError('price out of range');
  return scaled;
}

export function parseCandle(raw) {
  const m = typeof raw?.time === 'string' ? TIME_RE.exec(raw.time) : null;
  if (!m || !raw.mid) throw new OandaError('malformed candle');
  const ms = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(ms)) throw new OandaError('malformed candle time');
  const volume = Number(raw.volume);
  if (!Number.isInteger(volume) || volume < 0) throw new OandaError('malformed candle volume');
  return {
    ts: ms / 1000,
    o: parsePrice(raw.mid.o),
    h: parsePrice(raw.mid.h),
    l: parsePrice(raw.mid.l),
    c: parsePrice(raw.mid.c),
    v: volume,
    complete: raw.complete === true,
  };
}

export function createOandaClient({ oanda, logger, fetchImpl = globalThis.fetch, sleepFn = sleep }) {
  let lastRequestAt = 0;

  async function throttle(signal) {
    const wait = lastRequestAt + oanda.requestDelayMs - Date.now();
    if (wait > 0) await sleepFn(wait, signal);
    lastRequestAt = Date.now();
  }

  async function getJson(url, signal) {
    for (let attempt = 0; ; attempt++) {
      await throttle(signal);
      let retryAfterMs = 0;
      try {
        const timeout = AbortSignal.timeout(oanda.timeoutMs);
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${oanda.token}`, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        if (res.ok) return await res.json();

        const retryable = res.status === 429 || res.status >= 500;
        const header = Number(res.headers?.get?.('retry-after'));
        if (Number.isFinite(header) && header > 0) retryAfterMs = Math.min(header * 1000, 30_000);
        throw new OandaError(`OANDA responded with HTTP ${res.status}`, { status: res.status, retryable });
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err; // caller cancelled: never retry
        const retryable = err instanceof OandaError ? err.retryable : true; // network error / timeout
        if (!retryable || attempt >= oanda.maxRetries) {
          if (err instanceof OandaError) throw err;
          throw new OandaError(`request failed after ${attempt + 1} attempt(s): ${err?.name ?? 'error'}`, { retryable: false });
        }
        const backoff = retryAfterMs || Math.min(500 * 2 ** attempt, 10_000);
        logger.warn('OANDA request failed; retrying', { attempt: attempt + 1, of: oanda.maxRetries, backoffMs: backoff, error: err });
        await sleepFn(backoff, signal);
      }
    }
  }

  return {
    /**
     * Fetch every candle of one UTC calendar day. Returns { candles, incompleteCount }.
     * Candles at/after the next day's midnight are dropped (they belong to the next day).
     */
    async fetchDayCandles({ instrument, timeframe, date, signal }) {
      const tf = getTimeframe(timeframe);
      if (!tf) throw new OandaError('unsupported timeframe');
      const from = dayStartMs(date);
      const to = dayStartMs(addDays(date, 1));
      const query = new URLSearchParams({
        price: 'M',
        granularity: tf.oandaGranularity,
        from: formatIsoSeconds(from),
        to: formatIsoSeconds(to),
      });
      const url = `${oanda.host}/v3/instruments/${encodeURIComponent(instrument)}/candles?${query}`;

      const json = await getJson(url, signal);
      if (!json || !Array.isArray(json.candles)) throw new OandaError('malformed response');
      if (json.candles.length >= OANDA_MAX_CANDLES_PER_REQUEST) {
        // A full page means the day may have been truncated: never treat it as complete.
        throw new OandaError('response hit the candle limit; day cannot be trusted as complete');
      }

      const candles = [];
      let incompleteCount = 0;
      for (const raw of json.candles) {
        const k = parseCandle(raw);
        if (k.ts * 1000 >= to) continue;
        if (!k.complete) incompleteCount++;
        candles.push(k);
      }
      return { candles, incompleteCount };
    },
  };
}
