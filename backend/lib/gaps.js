// Missing-data report. Providers routinely deliver candle series with holes (no trades in a minute, an
// outage, a missing day), and the app delivers what was retrieved instead of refusing. This module walks
// the exact candles that went into an export and describes every hole, so the user knows precisely what
// is not in the CSV.
//
// Two kinds of gap are reported:
//   * whole UTC days with no candle at all
//   * missing candle timestamps inside a day (collapsed into first..last ranges)
// For 'fx' instruments (forex, gold) the regular weekly closure (Fri 21:00 -> Sun 22:00 UTC) plus Dec 25,
// Jan 1 and EXTRA_CLOSED_DATES are expected to be empty. They are counted in the summary but not listed, so a
// normal export does not get a report full of weekends. 'always' instruments (crypto) list everything.

import { addDays, dayStartSec, isSaturday } from './time.js';
import { yieldToLoop } from './yield.js';

const DAY = 86_400;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
const dateOf = (daySec) => new Date(daySec * 1000).toISOString().slice(0, 10);
const label = (daySec) => `${dateOf(daySec)} (${WEEKDAY[new Date(daySec * 1000).getUTCDay()]})`;

export const MAX_LISTED_RANGES = 20_000;

/**
 * @param segments  [{ set, from, to }] candle index ranges in chronological order (exactly what the CSV holds)
 * @param opts.start/end  requested inclusive UTC dates
 * @param opts.stepSeconds  timeframe step (60 for M1)
 * @param opts.calendar  'fx' | 'always'
 * @param opts.extraClosedDates Set of YYYY-MM-DD that are expected to be empty (fx only)
 * @param opts.retrieval  null, or { stoppedBefore: 'YYYY-MM-DD', reason } when fetching stopped early
 * @returns {Promise<null | {text: string, missingCandles: number, rows: number}>} null when nothing is missing
 */
export async function buildGapReport({ segments, start, end, stepSeconds: step, calendar, extraClosedDates = new Set(), instrumentLabel, instrument, timeframe, retrieval = null, nowMs = Date.now() }) {
  const startSec = dayStartSec(start);
  const endSec = dayStartSec(addDays(end, 1)); // exclusive
  const fx = calendar === 'fx';

  const emptyDays = []; // day start seconds
  const ranges = []; // { a, b, n } inclusive first/last missing slot
  let rangeOverflow = 0;
  let missingListed = 0;
  let missingClosure = 0;
  let rows = 0;

  const specialClosed = (daySec) => {
    const d = dateOf(daySec);
    const mmdd = d.slice(5);
    return mmdd === '12-25' || mmdd === '01-01' || extraClosedDates.has(d);
  };
  /** Part of a UTC day (inclusive slot range) that is a normal market closure, or null. */
  const cutSec = retrieval ? dayStartSec(retrieval.stoppedBefore) : Infinity; // days never retrieved are missing, not 'closed'
  const closureWindow = (daySec) => {
    if (!fx || daySec >= cutSec) return null;
    const last = daySec + DAY - step;
    if (specialClosed(daySec) || isSaturday(dateOf(daySec))) return [daySec, last];
    const dow = new Date(daySec * 1000).getUTCDay();
    if (dow === 0) return [daySec, daySec + 22 * 3600 - step]; // Sunday until the 22:00 UTC re-open
    if (dow === 5) return [daySec + 21 * 3600, last]; // Friday from the 21:00 UTC close
    return null;
  };

  const addRange = (a, b) => {
    const n = (b - a) / step + 1;
    missingListed += n;
    const prev = ranges[ranges.length - 1];
    if (prev && prev.b + step === a) {
      prev.b = b;
      prev.n += n;
    } else if (ranges.length < MAX_LISTED_RANGES) {
      ranges.push({ a, b, n });
    } else {
      rangeOverflow += n;
    }
  };

  /** Record the inclusive run of missing slots [a, b]. */
  const addGap = (a, b) => {
    while (a <= b) {
      const dayStart = Math.floor(a / DAY) * DAY;
      const dayLast = dayStart + DAY - step;
      const segEnd = Math.min(b, dayLast);
      const win = closureWindow(dayStart);
      const wholeDay = a === dayStart && segEnd === dayLast;

      if (wholeDay) {
        // A fully empty Sunday counts as a closure too: the market re-opens late that evening and many
        // pairs have no candles at all on some Sundays (e.g. exotic crosses).
        if (win && ((win[0] === dayStart && win[1] === dayLast) || new Date(dayStart * 1000).getUTCDay() === 0 && dayStart < cutSec)) missingClosure += DAY / step;
        else {
          emptyDays.push(dayStart);
          missingListed += DAY / step;
        }
      } else if (win) {
        const lo = Math.max(a, win[0]);
        const hi = Math.min(segEnd, win[1]);
        if (lo <= hi) {
          missingClosure += (hi - lo) / step + 1;
          if (a < lo) addRange(a, lo - step);
          if (hi < segEnd) addRange(hi + step, segEnd);
        } else addRange(a, segEnd);
      } else {
        addRange(a, segEnd);
      }
      a = segEnd + step;
    }
  };

  let expected = startSec;
  let counter = 0;
  for (const { set, from, to } of segments) {
    for (let i = from; i < to; i++) {
      const ts = set.ts[i];
      if (ts >= endSec) break;
      if (ts > expected) addGap(expected, ts - step);
      expected = ts + step;
      rows++;
      if ((++counter & 0x3fff) === 0) await yieldToLoop();
    }
  }
  if (expected < endSec) addGap(expected, endSec - step);

  const missingTotal = missingListed; // already includes candles in ranges beyond the list cap
  if (missingTotal === 0 && !retrieval) return null;

  // Collapse consecutive empty days.
  const dayRuns = [];
  for (const d of emptyDays) {
    const prev = dayRuns[dayRuns.length - 1];
    if (prev && prev.last + DAY === d) {
      prev.last = d;
      prev.days++;
    } else dayRuns.push({ first: d, last: d, days: 1 });
  }

  const out = [];
  out.push('MISSING DATA REPORT');
  out.push('===================');
  out.push(`Instrument      : ${instrumentLabel ?? instrument} (${instrument})`);
  out.push(`Timeframe       : ${timeframe}`);
  out.push(`Requested range : ${start} to ${end} (UTC calendar days, end date inclusive)`);
  out.push(`Generated       : ${new Date(nowMs).toISOString()}`);
  out.push('');
  out.push('The CSV contains every candle the data provider delivered for this range. Providers often leave');
  out.push('holes (minutes with no trades, outages, missing days); nothing below was invented or filled in.');
  out.push('All times are UTC; a candle timestamp is the candle OPEN time.');
  out.push('');
  out.push('SUMMARY');
  out.push('-------');
  out.push(`Candles in the CSV                      : ${rows.toLocaleString('en-US')}`);
  out.push(`Candles missing (listed in this report) : ${missingTotal.toLocaleString('en-US')}`);
  out.push(`Days with no data at all                : ${emptyDays.length.toLocaleString('en-US')}`);
  out.push(`Gaps inside days that have data         : ${ranges.length.toLocaleString('en-US')}${rangeOverflow ? ' (list truncated)' : ''}`);
  if (fx) out.push(`Regular market-closure candles (not listed): ${missingClosure.toLocaleString('en-US')}  (Fri 21:00 - Sun 22:00 UTC, Dec 25, Jan 1)`);

  if (retrieval) {
    out.push('');
    out.push('INCOMPLETE RETRIEVAL');
    out.push('--------------------');
    out.push(`Fetching from the data provider stopped before ${retrieval.stoppedBefore}${retrieval.reason ? ` (${retrieval.reason})` : ''}.`);
    out.push('Everything retrieved up to that point is included. Days from there on were NOT retrieved and appear');
    out.push('below as missing. Requesting the same range again later will retry them.');
  }

  out.push('');
  out.push('DAYS WITH NO DATA AT ALL');
  out.push('------------------------');
  if (!dayRuns.length) out.push('(none)');
  for (const r of dayRuns) {
    out.push(r.days === 1 ? label(r.first) : `${label(r.first)}  to  ${label(r.last)}  (${r.days} days)`);
  }

  out.push('');
  out.push('MISSING TIMESTAMPS INSIDE DAYS THAT HAVE DATA');
  out.push('---------------------------------------------');
  out.push(`(first missing candle -> last missing candle, ${step}-second steps)`);
  if (!ranges.length) out.push('(none)');
  for (const r of ranges) {
    out.push(r.a === r.b ? `${iso(r.a)}  (1 candle)` : `${iso(r.a)}  ->  ${iso(r.b)}  (${r.n.toLocaleString('en-US')} candles)`);
  }
  if (rangeOverflow) out.push(`... and ${rangeOverflow.toLocaleString('en-US')} more missing candles in further ranges that are not listed (list limit ${MAX_LISTED_RANGES.toLocaleString('en-US')} ranges).`);
  out.push('');

  return { text: out.join('\n'), missingCandles: missingTotal, rows };
}
