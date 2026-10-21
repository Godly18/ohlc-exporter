import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CandleSet } from '../backend/lib/candles.js';
import { buildGapReport, MAX_LISTED_RANGES } from '../backend/lib/gaps.js';
import { dayStartSec } from '../backend/lib/time.js';

const candle = (ts) => ({ ts, o: 100, h: 101, l: 99, c: 100, v: 1 });
/** Candles for the given UTC date, minutes [from, to) of the day. */
const minutes = (date, from = 0, to = 1440) => {
  const base = dayStartSec(date);
  const out = [];
  for (let m = from; m < to; m++) out.push(candle(base + m * 60));
  return out;
};
const report = async (candles, opts) => {
  const set = new CandleSet(16);
  set.pushAll(candles);
  return buildGapReport({
    segments: [{ set, from: 0, to: set.length }],
    stepSeconds: 60,
    instrument: 'X',
    instrumentLabel: 'X',
    timeframe: 'M1',
    nowMs: Date.parse('2026-09-14T12:00:00Z'),
    ...opts,
  });
};

describe('missing-data report', () => {
  it('returns null when nothing is missing', async () => {
    assert.equal(await report([...minutes('2026-09-01'), ...minutes('2026-09-02')], { start: '2026-09-01', end: '2026-09-02', calendar: 'always' }), null);
  });

  it('lists whole empty days (collapsed) and missing minutes inside days (collapsed to ranges)', async () => {
    const candles = [
      ...minutes('2026-09-01'),
      // 09-02 and 09-03 empty
      ...minutes('2026-09-04', 0, 600), // 10:00-23:59 missing -> continues into 09-05
      ...minutes('2026-09-05', 30, 1440), // 00:00-00:29 missing
      ...minutes('2026-09-06', 0, 100),
      ...minutes('2026-09-06', 103, 1440), // 01:40-01:42 missing
    ];
    const r = await report(candles, { start: '2026-09-01', end: '2026-09-06', calendar: 'always' });
    assert.ok(r);
    assert.match(r.text, /DAYS WITH NO DATA AT ALL\n-+\n2026-09-02 \(Wed\)  to  2026-09-03 \(Thu\)  \(2 days\)/);
    assert.match(r.text, /2026-09-04T10:00:00Z {2}-> {2}2026-09-05T00:29:00Z {2}\(870 candles\)/);
    assert.match(r.text, /2026-09-06T01:40:00Z {2}-> {2}2026-09-06T01:42:00Z {2}\(3 candles\)/);
    assert.equal(r.missingCandles, 2 * 1440 + 870 + 3);
    assert.equal(r.rows, candles.length);
  });

  it('a single missing candle and a trailing gap up to the end date are reported', async () => {
    const r = await report([...minutes('2026-09-01', 0, 5), ...minutes('2026-09-01', 6, 1000)], { start: '2026-09-01', end: '2026-09-02', calendar: 'always' });
    assert.match(r.text, /2026-09-01T00:05:00Z {2}\(1 candle\)/);
    assert.match(r.text, /2026-09-01T16:40:00Z {2}-> {2}2026-09-01T23:59:00Z/);
    assert.match(r.text, /2026-09-02 \(Wed\)/);
  });

  it('fx calendars do not list the regular weekend closure, holidays or an empty Sunday, but do list weekday holes', async () => {
    // Fri 2026-09-04 21:00 close, Sat empty, Sun empty until 22:00, then trading again
    const candles = [
      ...minutes('2026-09-04', 0, 21 * 60),
      ...minutes('2026-09-06', 22 * 60, 1440),
      ...minutes('2026-09-07', 0, 700),
      ...minutes('2026-09-07', 760, 1440), // Monday hole 11:40-12:39
    ];
    const r = await report(candles, { start: '2026-09-04', end: '2026-09-07', calendar: 'fx' });
    assert.ok(r);
    assert.match(r.text, /DAYS WITH NO DATA AT ALL\n-+\n\(none\)/);
    assert.match(r.text, /2026-09-07T11:40:00Z {2}-> {2}2026-09-07T12:39:00Z {2}\(60 candles\)/);
    assert.doesNotMatch(r.text, /2026-09-05|2026-09-06T/);
    assert.match(r.text, /Regular market-closure candles \(not listed\): *\d/);
    assert.equal(r.missingCandles, 60);

    // the same data on an 'always' calendar lists the weekend
    const crypto = await report(candles, { start: '2026-09-04', end: '2026-09-07', calendar: 'always' });
    assert.match(crypto.text, /2026-09-05 \(Sat\)/);
  });

  it('an empty Sunday (the EUR_TRY case) and EXTRA_CLOSED_DATES are treated as expected closures for fx', async () => {
    const candles = [...minutes('2026-09-04', 0, 21 * 60), ...minutes('2026-09-07')];
    const r = await report(candles, { start: '2026-09-04', end: '2026-09-07', calendar: 'fx' });
    assert.equal(r, null);

    const held = [...minutes('2026-09-01'), ...minutes('2026-09-03')]; // Wed 09-02 empty
    assert.ok(await report(held, { start: '2026-09-01', end: '2026-09-03', calendar: 'fx' }));
    assert.equal(await report(held, { start: '2026-09-01', end: '2026-09-03', calendar: 'fx', extraClosedDates: new Set(['2026-09-02']) }), null);
  });

  it('caps the listed ranges but still counts everything', async () => {
    const candles = [];
    const base = dayStartSec('2026-09-01');
    for (let m = 0; m < 1440; m += 2) candles.push(candle(base + m * 60)); // every other minute missing
    for (let d = 2; d <= 30; d++) candles.push(...minutes(`2026-09-${String(d).padStart(2, '0')}`).filter((_, i) => i % 2 === 0));
    const r = await report(candles, { start: '2026-09-01', end: '2026-09-30', calendar: 'always' });
    assert.equal(r.missingCandles, 30 * 720);
    assert.match(r.text, /list truncated/);
    assert.match(r.text, new RegExp(`list limit ${MAX_LISTED_RANGES.toLocaleString('en-US')} ranges`));
  });
});
