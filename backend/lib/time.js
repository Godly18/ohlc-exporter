// UTC calendar-day logic. The ONLY place that decides what "complete day" means.
//
// Rule (spec section 6): availability is based on complete UTC calendar days, never a rolling
// 24-hour window. Dates are 'YYYY-MM-DD' strings; they compare correctly as plain strings.

export const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function dayNumber(date) {
  const m = DATE_RE.exec(date);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

export function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  return fromDayNumber(dayNumber(date) + n);
}

/** The UTC calendar date containing the instant `ms`. */
export function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(date) {
  return dayNumber(date) * DAY_MS;
}

export function dayStartSec(date) {
  return dayNumber(date) * 86_400;
}

export function yearOf(date) {
  return Number(date.slice(0, 4));
}

export function yearStartDate(year) {
  return `${String(year).padStart(4, '0')}-01-01`;
}

export function yearEndDate(year) {
  return `${String(year).padStart(4, '0')}-12-31`;
}

export function daysInclusive(startDate, endDate) {
  return dayNumber(endDate) - dayNumber(startDate) + 1;
}

export function yearsInRange(startDate, endDate) {
  const years = [];
  for (let y = yearOf(startDate); y <= yearOf(endDate); y++) years.push(y);
  return years;
}

/** 'YYYY-MM-DD' <-> 20250615, used in the binary header. */
export function dateToCompact(date) {
  return Number(date.replace(/-/g, ''));
}

export function compactToDate(n) {
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Latest UTC day that has fully ENDED (yesterday). Not necessarily downloadable yet. */
export function latestCompletedDay(nowMs) {
  return addDays(utcDateOf(nowMs), -1);
}

/**
 * Latest day we are willing to fetch right now. A day that just ended is only fetched
 * `settleMinutes` after midnight UTC, so the final candles have time to complete at the source.
 */
export function latestFetchableDay(nowMs, settleMinutes) {
  const completed = latestCompletedDay(nowMs);
  const startOfToday = dayStartMs(utcDateOf(nowMs));
  return nowMs >= startOfToday + settleMinutes * 60_000 ? completed : addDays(completed, -1);
}

export function isSaturday(date) {
  return new Date(dayStartMs(date)).getUTCDay() === 6;
}

/**
 * Days on which an EMPTY result from the source is legitimate (market closed): Saturdays,
 * Dec 25, Jan 1, and any explicitly configured dates. Every other day must contain candles.
 */
export function isMarketClosedDay(date, extraClosedDates = new Set()) {
  const mmdd = date.slice(5);
  return isSaturday(date) || mmdd === '12-25' || mmdd === '01-01' || extraClosedDates.has(date);
}

export function formatIsoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Availability states for one calendar day (spec section 9).
 *   DAY_NOT_COMPLETE : today/future, or just ended but not yet fetchable
 *   DAY_MISSING      : ended and fetchable, nothing verified yet (retrievable on demand)
 *   DAY_DOWNLOADING / DAY_VERIFYING / DAY_FAILED : transient processing states
 *   DAY_AVAILABLE    : covered by a validated, durably stored dataset
 */
export const DayState = Object.freeze({
  NOT_COMPLETE: 'DAY_NOT_COMPLETE',
  MISSING: 'DAY_MISSING',
  DOWNLOADING: 'DAY_DOWNLOADING',
  VERIFYING: 'DAY_VERIFYING',
  AVAILABLE: 'DAY_AVAILABLE',
  FAILED: 'DAY_FAILED',
});

export function computeDayState({ date, nowMs, settleMinutes, completeThrough, transient }) {
  if (completeThrough && date <= completeThrough) return DayState.AVAILABLE;
  if (date > latestFetchableDay(nowMs, settleMinutes)) return DayState.NOT_COMPLETE;
  if (transient === 'DOWNLOADING') return DayState.DOWNLOADING;
  if (transient === 'VERIFYING') return DayState.VERIFYING;
  if (transient === 'FAILED') return DayState.FAILED;
  return DayState.MISSING;
}
