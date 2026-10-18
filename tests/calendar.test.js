import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../backend/config/index.js';
import {
  addDays,
  computeDayState,
  DayState,
  daysInclusive,
  isMarketClosedDay,
  isValidDateString,
  latestCompletedDay,
  latestFetchableDay,
  yearsInRange,
} from '../backend/lib/time.js';
import { validateExportRequest } from '../backend/lib/validation.js';

const { config } = loadConfig({ MIN_DATA_YEAR: '2020', MAX_EXPORT_DAYS: '800', DAY_SETTLE_MINUTES: '10' });
const at = (iso) => Date.parse(iso);
const req = (start, end, extra = {}) => ({ instrument: 'EUR_USD', timeframe: 'M1', start_date: start, end_date: end, ...extra });
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return { code: e.code, reason: e.extra?.reason, message: e.message };
  }
  return null;
};

describe('complete UTC calendar day logic (no rolling 24h)', () => {
  it('latest completed day is yesterday (UTC), at every moment of today', () => {
    assert.equal(latestCompletedDay(at('2026-09-14T00:00:01Z')), '2026-09-13');
    assert.equal(latestCompletedDay(at('2026-09-14T12:00:00Z')), '2026-09-13');
    assert.equal(latestCompletedDay(at('2026-09-14T23:59:59Z')), '2026-09-13');
    assert.equal(latestCompletedDay(at('2026-09-15T00:00:00Z')), '2026-09-14');
  });

  it('is not a rolling 24 hour window: 23h59m after midnight nothing new becomes complete', () => {
    // A rolling-24h rule would consider "today 00:00 .. now" complete once 24h passed; we never do.
    assert.equal(latestCompletedDay(at('2026-09-14T23:59:59.999Z')), '2026-09-13');
  });

  it('only fetches a just-ended day after the settle delay', () => {
    assert.equal(latestFetchableDay(at('2026-09-14T00:05:00Z'), 10), '2026-09-12');
    assert.equal(latestFetchableDay(at('2026-09-14T00:10:00Z'), 10), '2026-09-13');
    assert.equal(latestFetchableDay(at('2026-09-14T09:00:00Z'), 10), '2026-09-13');
  });

  it('handles month and year boundaries', () => {
    assert.equal(latestCompletedDay(at('2027-01-01T08:00:00Z')), '2026-12-31');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(daysInclusive('2025-06-15', '2025-08-20'), 67);
  });

  it('validates date strings strictly', () => {
    for (const bad of ['2025-02-30', '2025-6-1', '25-06-01', 'abc', '', null, undefined, 20250601, '2025-13-01', '2025-06-15T00:00:00Z']) {
      assert.equal(isValidDateString(bad), false, String(bad));
    }
    assert.equal(isValidDateString('2024-02-29'), true);
  });

  it('knows which empty days are legitimate market closures', () => {
    assert.equal(isMarketClosedDay('2026-09-12'), true); // Saturday
    assert.equal(isMarketClosedDay('2026-09-14'), false); // Monday
    assert.equal(isMarketClosedDay('2026-12-25'), true);
    assert.equal(isMarketClosedDay('2026-01-01'), true);
    assert.equal(isMarketClosedDay('2026-03-04', new Set(['2026-03-04'])), true);
  });

  it('enumerates years for cross-year requests', () => {
    assert.deepEqual(yearsInRange('2024-11-20', '2026-02-10'), [2024, 2025, 2026]);
    assert.deepEqual(yearsInRange('2025-06-15', '2025-08-20'), [2025]);
  });
});

describe('export request validation', () => {
  const now = at('2026-09-14T12:00:00Z');

  it('accepts a completed day and a normal range (end date inclusive)', () => {
    const r = validateExportRequest(req('2026-09-01', '2026-09-13'), now, config);
    assert.deepEqual(r, { instrument: 'EUR_USD', timeframe: 'M1', start: '2026-09-01', end: '2026-09-13' });
    assert.ok(validateExportRequest(req('2026-09-13', '2026-09-13'), now, config));
  });

  it('accepts cross-month and cross-year ranges', () => {
    assert.ok(validateExportRequest(req('2026-08-20', '2026-09-05'), now, config));
    assert.ok(validateExportRequest(req('2024-11-20', '2026-02-10'), now, { ...config, maxExportDays: 2000 }));
  });

  it('rejects the current UTC day with the in-progress message', () => {
    const e = code(() => validateExportRequest(req('2026-09-14', '2026-09-14'), now, config));
    assert.equal(e.code, 'DATA_NOT_AVAILABLE_YET');
    assert.equal(e.reason, 'in_progress');
    assert.equal(e.message, 'Data not available yet. The requested date is still in progress. Please retry later.');
  });

  it('does NOT silently shorten a range that ends today (Sep 1 -> Sep 14)', () => {
    const e = code(() => validateExportRequest(req('2026-09-01', '2026-09-14'), now, config));
    assert.equal(e.reason, 'in_progress');
  });

  it('rejects future dates', () => {
    assert.equal(code(() => validateExportRequest(req('2026-09-15', '2026-09-16'), now, config)).code, 'FUTURE_DATE');
    assert.equal(code(() => validateExportRequest(req('2026-09-01', '2027-01-01'), now, config)).code, 'FUTURE_DATE');
  });

  it('rejects a just-concluded day until it has settled', () => {
    const justAfterMidnight = at('2026-09-14T00:03:00Z');
    const e = code(() => validateExportRequest(req('2026-09-10', '2026-09-13'), justAfterMidnight, config));
    assert.equal(e.code, 'DATA_NOT_AVAILABLE_YET');
    assert.equal(e.reason, 'not_verified');
    assert.equal(e.message, 'Data not available yet. The requested date has not been fully processed and verified. Please retry later.');
    // but the day before is fine
    assert.ok(validateExportRequest(req('2026-09-10', '2026-09-12'), justAfterMidnight, config));
  });

  it('UTC boundary: the same instant is a different "current day" on either side of midnight', () => {
    assert.equal(code(() => validateExportRequest(req('2026-09-14', '2026-09-14'), at('2026-09-14T23:59:59Z'), config)).reason, 'in_progress');
    assert.ok(validateExportRequest(req('2026-09-14', '2026-09-14'), at('2026-09-15T00:30:00Z'), config));
  });

  it('rejects inverted ranges with the specified message', () => {
    const e = code(() => validateExportRequest(req('2026-09-10', '2026-09-01'), now, config));
    assert.equal(e.code, 'INVALID_RANGE');
    assert.equal(e.message, 'Invalid date range. The start date must not be later than the end date.');
  });

  it('rejects unsupported instruments/timeframes and malformed input', () => {
    assert.equal(code(() => validateExportRequest(req('2026-09-01', '2026-09-02', { instrument: 'XXX_YYY' }), now, config)).code, 'INVALID_INSTRUMENT');
    assert.equal(code(() => validateExportRequest(req('2026-09-01', '2026-09-02', { timeframe: 'H1' }), now, config)).code, 'INVALID_TIMEFRAME');
    assert.equal(code(() => validateExportRequest(req('2026-02-30', '2026-09-02'), now, config)).code, 'INVALID_DATE');
    assert.equal(code(() => validateExportRequest(null, now, config)).code, 'INVALID_REQUEST');
    assert.equal(code(() => validateExportRequest([], now, config)).code, 'INVALID_REQUEST');
  });

  it('enforces the minimum year and the maximum range', () => {
    assert.equal(code(() => validateExportRequest(req('2019-12-31', '2020-01-02'), now, config)).code, 'DATE_TOO_EARLY');
    assert.equal(code(() => validateExportRequest(req('2020-01-01', '2026-09-01'), now, config)).code, 'RANGE_TOO_LARGE');
  });
});

describe('day availability states', () => {
  const base = { settleMinutes: 10, completeThrough: '2026-09-10' };
  const now = at('2026-09-14T12:00:00Z');

  it('covered day is AVAILABLE; today is NOT_COMPLETE; missing complete days are MISSING', () => {
    assert.equal(computeDayState({ ...base, date: '2026-09-10', nowMs: now }), DayState.AVAILABLE);
    assert.equal(computeDayState({ ...base, date: '2026-09-11', nowMs: now }), DayState.MISSING);
    assert.equal(computeDayState({ ...base, date: '2026-09-13', nowMs: now }), DayState.MISSING);
    assert.equal(computeDayState({ ...base, date: '2026-09-14', nowMs: now }), DayState.NOT_COMPLETE);
    assert.equal(computeDayState({ ...base, date: '2026-09-20', nowMs: now }), DayState.NOT_COMPLETE);
  });

  it('a just-ended day inside the settle window is NOT_COMPLETE', () => {
    assert.equal(computeDayState({ ...base, date: '2026-09-13', nowMs: at('2026-09-14T00:02:00Z') }), DayState.NOT_COMPLETE);
  });

  it('reports transient processing states', () => {
    assert.equal(computeDayState({ ...base, date: '2026-09-12', nowMs: now, transient: 'DOWNLOADING' }), DayState.DOWNLOADING);
    assert.equal(computeDayState({ ...base, date: '2026-09-12', nowMs: now, transient: 'VERIFYING' }), DayState.VERIFYING);
    assert.equal(computeDayState({ ...base, date: '2026-09-12', nowMs: now, transient: 'FAILED' }), DayState.FAILED);
  });
});
