// Twelve Data (https://twelvedata.com). Used for ONE instrument only: XAUUSD (XAU/USD).
//
// The free plan allows ~8 requests/minute and 800 credits/day, so requests are paced accordingly and a
// request covers a small WINDOW of days (3 by default; <= 5000 candles per response, ~1,400/day for gold),
// which is split per day and served to the dataset builder one day at a time. A response that reaches the
// 5000-row cap is treated as truncated: only the days before its last candle's day are trusted.
//
// Prices arrive as decimal strings; they are converted exactly and rounded half-up at 5 decimals.

import { getInstrument, getTimeframe } from '../../config/catalog.js';
import { parseDecimalScaled } from '../../lib/decimal.js';
import { SourceError } from '../../lib/errors.js';
import { addDays } from '../../lib/time.js';
import { createRequester } from '../sources/http.js';

const OUTPUT_CAP = 5000;
const PRICE_DECIMALS = 5;

export function createTwelveDataClient({ twelvedata, logger, clock = Date.now, fetchImpl = globalThis.fetch, sleepFn }) {
  const http = createRequester({
    name: 'Twelve Data',
    delayMs: Math.ceil(60_000 / Math.max(1, twelvedata.ratePerMinute)) + 100,
    timeoutMs: twelvedata.timeoutMs,
    maxRetries: 0, // retries are handled here because Twelve Data reports errors inside HTTP 200 bodies
    logger,
    fetchImpl,
    ...(sleepFn ? { sleepFn } : {}),
  });
  const pause = sleepFn ?? ((ms, signal) => import('../../lib/yield.js').then((m) => m.sleep(ms, signal)));

  const cap = twelvedata.outputCap ?? OUTPUT_CAP;
  const cache = new Map(); // date -> candle[]

  function parseValue(v) {
    const dt = typeof v?.datetime === 'string' ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.datetime) : null;
    if (!dt) throw new SourceError('malformed Twelve Data candle time');
    const ms = Date.parse(`${dt[1]}T${dt[2]}:${dt[3]}:${dt[4]}Z`);
    if (!Number.isFinite(ms) || ms % 60_000 !== 0) throw new SourceError('malformed Twelve Data candle time');
    const o = parseDecimalScaled(v.open, PRICE_DECIMALS, { round: true });
    const h = parseDecimalScaled(v.high, PRICE_DECIMALS, { round: true });
    const l = parseDecimalScaled(v.low, PRICE_DECIMALS, { round: true });
    const c = parseDecimalScaled(v.close, PRICE_DECIMALS, { round: true });
    if (o === null || h === null || l === null || c === null) throw new SourceError('malformed Twelve Data price');
    const volRaw = v.volume === undefined || v.volume === null || v.volume === '' ? 0 : Number(v.volume);
    if (!Number.isFinite(volRaw) || volRaw < 0) throw new SourceError('malformed Twelve Data volume');
    return { date: dt[1], candle: { ts: ms / 1000, o, h, l, c, v: Math.round(volRaw) } };
  }

  async function requestWindow(symbol, interval, fromDate, toDate, signal) {
    const query = new URLSearchParams({
      symbol,
      interval,
      start_date: `${fromDate} 00:00:00`,
      end_date: `${toDate} 23:59:59`,
      timezone: 'UTC',
      order: 'ASC',
      outputsize: String(cap),
      format: 'JSON',
      apikey: twelvedata.apiKey,
    });
    const url = `${twelvedata.baseUrl}/time_series?${query}`;

    for (let attempt = 0; ; attempt++) {
      let body;
      try {
        body = await http.get(url, { signal, errorBodyOk: true });
      } catch (err) {
        if (signal?.aborted) throw err;
        const retryable = err instanceof SourceError ? err.retryable || (err.status ?? 0) >= 500 : true;
        if (!retryable || attempt >= twelvedata.maxRetries) throw err instanceof SourceError ? err : new SourceError('Twelve Data request failed');
        await pause(Math.min(2000 * 2 ** attempt, 20_000), signal);
        continue;
      }
      if (body?.status === 'error' || body?.code >= 400) {
        const message = String(body.message ?? '');
        if (/no data is available|no data found/i.test(message)) return []; // nothing in this window (e.g. weekend)
        if (body.code === 429 || /api credits|rate limit/i.test(message)) {
          if (/for the day|daily/i.test(message)) {
            throw new SourceError('Twelve Data daily credit limit reached. Please try again tomorrow.', { status: 429, retryable: false });
          }
          if (attempt >= twelvedata.maxRetries) throw new SourceError('Twelve Data rate limit; please retry later.', { status: 429, retryable: false });
          logger.warn('Twelve Data rate limit hit; waiting a minute', { attempt: attempt + 1 });
          await pause(61_000, signal);
          continue;
        }
        if (body.code === 401 || body.code === 403) throw new SourceError('Twelve Data rejected the API key or plan.', { status: body.code });
        throw new SourceError(`Twelve Data error ${body.code ?? ''}: ${message.replace(/apikey=\S+/gi, '').slice(0, 120)}`.trim(), { status: body.code ?? null });
      }
      if (!Array.isArray(body?.values)) throw new SourceError('malformed Twelve Data response');
      return body.values;
    }
  }

  return {
    /** Every candle of one UTC calendar day (fetched together with the next few days; see header comment). */
    async fetchDayCandles({ instrument, timeframe, date, lastDay, signal }) {
      const inst = getInstrument(instrument);
      const tf = getTimeframe(timeframe);
      if (!inst || inst.provider !== 'twelvedata' || !tf) throw new SourceError('Twelve Data is only used for XAUUSD');
      if (!twelvedata.apiKey) throw new SourceError('Twelve Data is not configured');

      if (!cache.has(date)) {
        cache.clear();
        const windowEnd = (() => {
          const maxEnd = addDays(date, Math.max(1, twelvedata.windowDays) - 1);
          return lastDay && lastDay < maxEnd ? (lastDay < date ? date : lastDay) : maxEnd;
        })();
        const values = await requestWindow(inst.providerSymbol, tf.twelveInterval, date, windowEnd, signal);

        const byDay = new Map();
        let newest = '';
        for (const v of values) {
          const { date: d, candle } = parseValue(v);
          if (d < date || d > windowEnd) continue;
          let arr = byDay.get(d);
          if (!arr) byDay.set(d, (arr = []));
          arr.push(candle);
          if (d > newest) newest = d;
        }
        const truncated = values.length >= cap;
        for (let d = date; d <= windowEnd; d = addDays(d, 1)) {
          if (truncated && d >= newest) {
            if (d === date) throw new SourceError('Twelve Data response was truncated; day cannot be trusted as complete');
            continue; // the last day in a truncated response may be partial: fetch it again next time
          }
          cache.set(d, (byDay.get(d) ?? []).sort((a, b) => a.ts - b.ts));
        }
        logger.info('Twelve Data window loaded', { from: date, to: windowEnd, candles: values.length, nowIso: new Date(clock()).toISOString() });
      }
      const candles = cache.get(date) ?? [];
      cache.delete(date);
      return { candles, incompleteCount: 0 };
    },
  };
}
