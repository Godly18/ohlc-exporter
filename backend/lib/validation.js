// Candle/dataset validation and user request validation.

import { effectiveMinYear, getInstrument, getTimeframe, providerAvailable } from '../config/catalog.js';
import { Errors } from './errors.js';
import {
  addDays,
  maxEndForYears,
  dayStartMs,
  dayStartSec,
  isValidDateString,
  latestFetchableDay,
  utcDateOf,
  yearOf,
  yearStartDate,
} from './time.js';
import { YIELD_EVERY, yieldToLoop } from './yield.js';

/**
 * Validate a decoded yearly dataset. Returns null when valid, else a short reason string.
 * Checks: timestamps aligned to the timeframe, inside the year and inside the claimed coverage,
 * strictly increasing (so also duplicate-free), and sane OHLC relationships.
 */
export async function validateCandleSet(set, { year, stepSeconds, completeThrough }) {
  if (!completeThrough) return set.length === 0 ? null : 'candles present but no coverage recorded';
  if (yearOf(completeThrough) !== year) return 'coverage date is outside the dataset year';

  const lo = dayStartSec(yearStartDate(year));
  const hi = dayStartSec(addDays(completeThrough, 1)); // exclusive
  let prev = -1;
  for (let i = 0; i < set.length; i++) {
    const ts = set.ts[i];
    if (ts % stepSeconds !== 0) return `timestamp not aligned to timeframe at index ${i}`;
    if (ts < lo || ts >= hi) return `timestamp outside covered range at index ${i}`;
    if (ts <= prev) return ts === prev ? `duplicate timestamp at index ${i}` : `out-of-order timestamp at index ${i}`;
    prev = ts;
    const o = set.o[i];
    const h = set.h[i];
    const l = set.l[i];
    const c = set.c[i];
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return `non-positive price at index ${i}`;
    if (h < o || h < c || h < l || l > o || l > c) return `invalid OHLC relationship at index ${i}`;
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await yieldToLoop();
  }
  return null;
}

/** Validate one day's parsed candles ({ts,o,h,l,c,v}). Returns null or a reason. */
const V1_LIMITS = Object.freeze({ maxPrice: 2_147_483_647, maxVolume: 0xffff_ffff });
export const V2_LIMITS = Object.freeze({ maxPrice: Number.MAX_SAFE_INTEGER, maxVolume: Number.MAX_SAFE_INTEGER });

/** Largest price/volume the instrument's dataset layout can hold. */
export const limitsFor = (instrument) => (instrument?.formatVersion === 2 ? V2_LIMITS : V1_LIMITS);

/** Why ONE candle is unusable, or null. `lo`/`hi` bound the requested day (seconds). */
function candleProblem(k, lo, hi, stepSeconds, limits) {
  if (!Number.isInteger(k.ts) || k.ts < lo || k.ts >= hi) return 'timestamp outside the requested day';
  if (k.ts % stepSeconds !== 0) return 'timestamp not aligned to the timeframe';
  if (!(k.o > 0) || !(k.h > 0) || !(k.l > 0) || !(k.c > 0)) return 'non-positive price';
  if (!Number.isSafeInteger(k.o) || !Number.isSafeInteger(k.h) || !Number.isSafeInteger(k.l) || !Number.isSafeInteger(k.c)) return 'invalid price';
  if (k.o > limits.maxPrice || k.h > limits.maxPrice || k.l > limits.maxPrice || k.c > limits.maxPrice) return 'price out of range';
  if (k.h < k.o || k.h < k.c || k.h < k.l || k.l > k.o || k.l > k.c) return 'invalid OHLC relationship';
  if (!Number.isSafeInteger(k.v) || k.v < 0 || k.v > limits.maxVolume) return 'invalid volume';
  return null;
}

/**
 * Keep the usable candles of one day and SKIP (not fail on) the unusable ones.
 * Returns { candles, skipped }: candles are sorted, de-duplicated (first one wins) and individually valid;
 * skipped is [{ ts, reason }] for the report (ts is null when the source gave no usable timestamp).
 */
export function sanitizeDayCandles(candles, date, stepSeconds, limits = V1_LIMITS) {
  const lo = dayStartSec(date);
  const hi = lo + 86_400;
  const skipped = [];
  const good = [];
  for (const k of candles) {
    const reason = candleProblem(k, lo, hi, stepSeconds, limits);
    if (reason) skipped.push({ ts: Number.isInteger(k.ts) ? k.ts : null, reason });
    else good.push(k);
  }
  good.sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const k of good) {
    if (out.length && out[out.length - 1].ts === k.ts) skipped.push({ ts: k.ts, reason: 'duplicate timestamp' });
    else out.push(k);
  }
  return { candles: out, skipped };
}

/** Strict all-or-nothing check (kept for tests and tooling): returns null or the first reason. */
export function validateDayCandles(candles, date, stepSeconds, limits = V1_LIMITS) {
  const { candles: good, skipped } = sanitizeDayCandles(candles, date, stepSeconds, limits);
  if (skipped.length) return skipped[0].reason;
  return good.length === candles.length ? null : 'unordered candles';
}

/**
 * Validate and normalise a user export request. Pure: depends only on its arguments and `nowMs`.
 * Throws AppError with the spec'd messages. Order: shape, instrument, timeframe, date format,
 * ordering, future, current day, limits, just-concluded-not-yet-processed.
 */
export function validateExportRequest(body, nowMs, config) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw Errors.invalidRequest();

  const instrument = getInstrument(body.instrument);
  if (!instrument || !providerAvailable(instrument, config)) throw Errors.invalidInstrument();
  const timeframe = getTimeframe(body.timeframe);
  if (!timeframe) throw Errors.invalidTimeframe();

  const start = body.start_date;
  const end = body.end_date;
  if (!isValidDateString(start)) throw Errors.invalidDate('start_date');
  if (!isValidDateString(end)) throw Errors.invalidDate('end_date');
  if (start > end) throw Errors.invalidRange();

  const today = utcDateOf(nowMs);
  if (start > today || end > today) throw Errors.future();
  if (end === today) throw Errors.inProgress(); // current UTC day is never returned

  const minYear = effectiveMinYear(instrument, config);
  if (yearOf(start) < minYear) throw Errors.beforeMinDate(minYear, instrument.label);
  if (end > maxEndForYears(start, config.maxExportYears)) throw Errors.rangeTooLarge(config.maxExportYears);

  // The day that just ended is not available until it has settled and been fully verified.
  if (end > latestFetchableDay(nowMs, config.daySettleMinutes)) throw Errors.notVerified();

  return { instrument: instrument.code, timeframe: timeframe.code, start, end };
}

/** Does `dateStr` start at midnight UTC exactly? (helper for tests/boundaries) */
export function startsAtMidnightUtc(ms) {
  return ms === dayStartMs(utcDateOf(ms));
}
