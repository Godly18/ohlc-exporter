import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { dayStartMs, dayStartSec } from '../backend/lib/time.js';
import { zipSingleFile } from '../backend/lib/zip.js';
import { silentLogger } from '../backend/lib/logger.js';
import { createBinanceClient, parseArchiveCsv } from '../backend/services/binance/client.js';
import { createTwelveDataClient } from '../backend/services/twelvedata/client.js';

const logger = silentLogger();
const NOW = Date.parse('2026-09-14T12:00:00Z');
const noSleep = async () => {};

async function makeZip(csv, name = 'BTCUSDT-1m-2026-08.csv') {
  async function* one() {
    yield Buffer.from(csv);
  }
  const parts = [];
  for await (const p of zipSingleFile(name, one(), NOW)) parts.push(p);
  return Buffer.concat(parts);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const res = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new TextEncoder().encode(String(body)).buffer),
});

const binanceCfg = (extra = {}) => ({
  apiBase: 'https://api.test',
  archiveBase: 'https://archive.test',
  archiveEnabled: true,
  requestDelayMs: 0,
  timeoutMs: 5000,
  maxRetries: 2,
  ...extra,
});

/** One archive row: open time, o,h,l,c, volume, close time, ... (12 columns like the real files). */
const row = (ms, o, h, l, c, v) => `${ms},${o},${h},${l},${c},${v},${ms + 59_999},100.0,10,1,1,0`;

describe('Binance monthly archive parsing', () => {
  it('reads millisecond and MICROsecond timestamps, a header row, and ignores other months', async () => {
    const t = dayStartMs('2026-08-01');
    const csv = [
      'open_time,open,high,low,close,volume',
      row(t, '65000.01000000', '65010.00000000', '64990.00000000', '65005.50000000', '1.23456789'),
      row((t + 60_000) * 1000, '65005.50000000', '65020.00000000', '65000.00000000', '65010.00000000', '0.5'), // microseconds
      row(dayStartMs('2026-07-31') + 86_340_000, '1', '1', '1', '1', '1'), // belongs to July: not served
      '',
    ].join('\n');
    const days = await parseArchiveCsv(csv, '2026-08');
    assert.deepEqual([...days.keys()], ['2026-08-01']);
    const [a, b] = days.get('2026-08-01');
    assert.deepEqual(a, { ts: t / 1000, o: 6_500_001_000_000, h: 6_501_000_000_000, l: 6_499_000_000_000, c: 6_500_550_000_000, v: 123_456_789 });
    assert.equal(b.ts, t / 1000 + 60);
    assert.equal(b.v, 50_000_000);
  });

  it('rejects malformed rows rather than guessing', async () => {
    const ok = row(dayStartMs('2026-08-01'), '1', '1', '1', '1', '1');
    await assert.rejects(parseArchiveCsv(`${ok}\nabc,1,1,1,1,1`, '2026-08'), /malformed/);
    await assert.rejects(parseArchiveCsv(`${ok}\n${row(dayStartMs('2026-08-01') + 60_000, '1', '1', '1')}`.replace(/,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*$/, ''), '2026-08'), /malformed/);
    await assert.rejects(parseArchiveCsv(row(dayStartMs('2026-08-01') + 1000, '1', '1', '1', '1', '1'), '2026-08'), /malformed archive timestamp/);
    await assert.rejects(parseArchiveCsv(row(dayStartMs('2026-08-01'), '1.123456789', '1', '1', '1', '1'), '2026-08'), /malformed archive price/);
  });
});

describe('Binance client: archive first, API otherwise', () => {
  async function setup({ zipOk = true, checksumOk = true, archive = true, apiRows = null, extraCfg = {} } = {}) {
    const t = dayStartMs('2026-08-03');
    const csv = [row(t, '65000.00000000', '65010.00000000', '64990.00000000', '65005.00000000', '2.0'), row(t + 60_000, '65005.00000000', '65020.00000000', '65000.00000000', '65010.00000000', '1.0')].join('\n');
    const zip = await makeZip(csv);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://archive.test/') && url.endsWith('.CHECKSUM')) {
        return archive && checksumOk ? res(`${sha(zip)}  BTCUSDT-1m-2026-08.zip\n`) : archive ? res(`${'0'.repeat(64)}  x.zip`) : res('nope', { status: 404 });
      }
      if (url.startsWith('https://archive.test/')) return archive && zipOk ? res(zip) : res('nope', { status: 404 });
      if (url.startsWith('https://api.test/')) return res(apiRows ? apiRows(new URL(url)) : []);
      throw new Error(`unexpected url ${url}`);
    };
    const client = createBinanceClient({ binance: binanceCfg(extraCfg), logger, clock: () => NOW, fetchImpl, sleepFn: noSleep });
    return { client, calls };
  }
  const ask = (client, date) => client.fetchDayCandles({ instrument: 'BTCUSDT', timeframe: 'M1', date });

  it('downloads the whole month ONCE from the archive (checksum verified) and serves days from it', async () => {
    const { client, calls } = await setup();
    const day3 = await ask(client, '2026-08-03');
    assert.equal(day3.via, 'archive');
    assert.equal(day3.candles.length, 2);
    assert.equal(day3.incompleteCount, 0);
    assert.equal((await ask(client, '2026-08-04')).candles.length, 0); // other days of the same month: no extra downloads
    await ask(client, '2026-08-20');
    assert.equal(calls.filter((u) => u.includes('archive.test') && u.endsWith('.zip')).length, 1);
    assert.equal(calls.filter((u) => u.endsWith('.CHECKSUM')).length, 1);
    assert.ok(calls.some((u) => u === 'https://archive.test/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2026-08.zip'));
    assert.ok(!calls.some((u) => u.startsWith('https://api.test')), 'the API is not used when the archive has the month');
  });

  it('falls back to the API when the month is not in the archive, paging 1000 candles at a time', async () => {
    const start = dayStartMs('2026-08-05');
    const all = Array.from({ length: 1440 }, (_, i) => [start + i * 60_000, '65000.00000000', '65001.00000000', '64999.00000000', '65000.50000000', '1.5', start + i * 60_000 + 59_999, '0', 0, '0', '0', '0']);
    const { client, calls } = await setup({
      archive: false,
      apiRows: (u) => {
        const from = Number(u.searchParams.get('startTime'));
        assert.equal(u.searchParams.get('symbol'), 'BTCUSDT');
        assert.equal(u.searchParams.get('interval'), '1m');
        assert.equal(u.searchParams.get('limit'), '1000');
        if (from < start || from >= start + 86_400_000) return []; // the next day's request: nothing to return
        assert.equal(Number(u.searchParams.get('endTime')), start + 86_400_000 - 1);
        return all.filter((r) => r[0] >= from).slice(0, 1000);
      },
    });
    const day = await ask(client, '2026-08-05');
    assert.equal(day.via, 'api');
    assert.equal(day.candles.length, 1440);
    assert.equal(day.incompleteCount, 0);
    assert.equal(calls.filter((u) => u.startsWith('https://api.test')).length, 2);
    await ask(client, '2026-08-06'); // the archive miss for this month is remembered: no repeated archive probes
    assert.equal(calls.filter((u) => u.endsWith('.zip')).length, 1);
  });

  it('does not trust an archive whose checksum does not match, and uses the API instead', async () => {
    const { client, calls } = await setup({ checksumOk: false, apiRows: () => [] });
    const day = await ask(client, '2026-08-03');
    assert.equal(day.via, 'api');
    assert.equal(calls.filter((u) => u.endsWith('.zip')).length, 2, 'one retry of the download, then the API');
  });

  it('never looks in the archive for the current (unfinished) month, and honours BINANCE_ARCHIVE_ENABLED=false', async () => {
    let s = await setup({ apiRows: () => [] });
    assert.equal((await ask(s.client, '2026-09-10')).via, 'api');
    assert.ok(!s.calls.some((u) => u.includes('archive.test')));
    s = await setup({ apiRows: () => [], extraCfg: { archiveEnabled: false } });
    assert.equal((await ask(s.client, '2026-08-03')).via, 'api');
    assert.ok(!s.calls.some((u) => u.includes('archive.test')));
  });

  it('flags still-open candles, drops candles outside the day, and rejects malformed rows', async () => {
    const day = '2026-09-13';
    const start = dayStartMs(day);
    const mk = (ms, close) => [ms, '1.0', '1.0', '1.0', '1.0', '1.0', close, '0', 0, '0', '0', '0'];
    let s = await setup({ apiRows: () => [mk(start - 60_000, start - 1), mk(start, start + 59_999), mk(start + 86_400_000, 0)] });
    const out = await ask(s.client, day);
    assert.equal(out.candles.length, 1, 'only the candle inside the day');
    s = await setup({ apiRows: () => [mk(start, NOW + 1000)] });
    assert.equal((await ask(s.client, day)).incompleteCount, 1);
    s = await setup({ apiRows: () => [[start, 'x', '1', '1', '1', '1', start + 1]] });
    await assert.rejects(ask(s.client, day), /malformed/);
    s = await setup({ apiRows: () => ({ code: -1 }) });
    await assert.rejects(ask(s.client, day), /malformed Binance response/);
  });

  it('retries 429/5xx with a bounded number of attempts and then gives up', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      return n < 3 ? res('busy', { status: 429, headers: { 'retry-after': '1' } }) : res([]);
    };
    const client = createBinanceClient({ binance: binanceCfg(), logger, clock: () => NOW, fetchImpl, sleepFn: noSleep });
    assert.deepEqual((await client.fetchDayCandles({ instrument: 'ETHUSDT', timeframe: 'M1', date: '2026-09-10' })).candles, []);
    assert.equal(n, 3);

    n = 0;
    const always500 = createBinanceClient({ binance: binanceCfg(), logger, clock: () => NOW, fetchImpl: async () => (n++, res('x', { status: 503 })), sleepFn: noSleep });
    await assert.rejects(always500.fetchDayCandles({ instrument: 'ETHUSDT', timeframe: 'M1', date: '2026-09-10' }), /HTTP 503/);
    assert.equal(n, 3, '1 try + 2 retries');

    n = 0;
    const geo = createBinanceClient({ binance: binanceCfg(), logger, clock: () => NOW, fetchImpl: async () => (n++, res('x', { status: 451 })), sleepFn: noSleep });
    await assert.rejects(geo.fetchDayCandles({ instrument: 'ETHUSDT', timeframe: 'M1', date: '2026-09-10' }), /HTTP 451/);
    assert.equal(n, 1, 'permanent errors are not retried');
  });

  it('refuses instruments that are not Binance pairs', async () => {
    const { client } = await setup();
    await assert.rejects(client.fetchDayCandles({ instrument: 'EUR_USD', timeframe: 'M1', date: '2026-08-03' }), /unsupported/);
    await assert.rejects(client.fetchDayCandles({ instrument: 'XAUUSD', timeframe: 'M1', date: '2026-08-03' }), /unsupported/);
  });
});

describe('Twelve Data client (XAUUSD only)', () => {
  const cfg = (extra = {}) => ({ apiKey: 'KEY-123456', baseUrl: 'https://td.test', ratePerMinute: 8, windowDays: 3, timeoutMs: 5000, maxRetries: 2, ...extra });
  const value = (dt, o = '2000.10', h = '2000.50', l = '1999.90', c = '2000.20', v) => ({ datetime: dt, open: o, high: h, low: l, close: c, ...(v === undefined ? {} : { volume: v }) });
  const make = (handler, extra = {}) => {
    const calls = [];
    const sleeps = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url));
      return res(handler(new URL(url), calls.length));
    };
    const client = createTwelveDataClient({ twelvedata: cfg(extra), logger, clock: () => NOW, fetchImpl, sleepFn: async (ms) => void sleeps.push(ms) });
    return { client, calls, sleeps };
  };
  const ask = (client, date, lastDay) => client.fetchDayCandles({ instrument: 'XAUUSD', timeframe: 'M1', date, lastDay });

  it('requests a 3-day window with the right parameters and serves the days one by one', async () => {
    const { client, calls } = make(() => ({
      status: 'ok',
      values: [value('2026-09-01 00:00:00'), value('2026-09-01 00:01:00', '2000.2', '2000.6', '2000.1', '2000.4', '12'), value('2026-09-02 10:00:00'), value('2026-09-03 23:59:00')],
    }));
    const d1 = await ask(client, '2026-09-01', '2026-09-13');
    assert.equal(d1.candles.length, 2);
    assert.deepEqual(d1.candles[1], { ts: dayStartSec('2026-09-01') + 60, o: 200_020_000, h: 200_060_000, l: 200_010_000, c: 200_040_000, v: 12 });
    assert.equal(d1.candles[0].v, 0, 'missing volume becomes 0');
    assert.equal((await ask(client, '2026-09-02', '2026-09-13')).candles.length, 1);
    assert.equal((await ask(client, '2026-09-03', '2026-09-13')).candles.length, 1);
    assert.equal(calls.length, 1, 'three days cost ONE request (free plan: 800 credits/day)');
    const q = calls[0].searchParams;
    assert.equal(q.get('symbol'), 'XAU/USD');
    assert.equal(q.get('interval'), '1min');
    assert.equal(q.get('timezone'), 'UTC');
    assert.equal(q.get('order'), 'ASC');
    assert.equal(q.get('start_date'), '2026-09-01 00:00:00');
    assert.equal(q.get('end_date'), '2026-09-03 23:59:59');
    assert.equal(q.get('outputsize'), '5000');
    assert.equal(q.get('apikey'), 'KEY-123456');
    await ask(client, '2026-09-04', '2026-09-13');
    assert.equal(calls.length, 2);
  });

  it('never asks past the last verifiable day, and rounds prices to 5 decimals', async () => {
    const { client, calls } = make(() => ({ status: 'ok', values: [value('2026-09-12 10:00:00', '2000.123456', '2000.5', '1999.9', '2000.2')] }));
    const out = await ask(client, '2026-09-12', '2026-09-13');
    assert.equal(calls[0].searchParams.get('end_date'), '2026-09-13 23:59:59');
    assert.equal(out.candles[0].o, 200_012_346);
  });

  it('a weekend-only window answered with a real HTTP 400 "no data" is an empty window, not a failure (production bug)', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return res({ code: 400, status: 'error', message: '**symbol** No data is available on the specified dates. Try setting different start/end dates.' }, { status: 400 });
    };
    const client = createTwelveDataClient({ twelvedata: cfg(), logger, clock: () => NOW, fetchImpl, sleepFn: async () => {} });
    // Sat 2023-12-30 .. Sun 2023-12-31 (the window the live job died on)
    assert.deepEqual((await ask(client, '2023-12-30', '2023-12-31')).candles, []);
    assert.deepEqual((await ask(client, '2023-12-31', '2023-12-31')).candles, []);
    assert.equal(calls.length, 1, 'both weekend days came from one request, no retries');

    // other 4xx answers still fail, with the provider's reason (and never the key)
    const bad = createTwelveDataClient({ twelvedata: cfg(), logger, clock: () => NOW, fetchImpl: async () => res({ code: 400, status: 'error', message: 'interval is invalid' }, { status: 400 }), sleepFn: async () => {} });
    await assert.rejects(ask(bad, '2026-09-01'), /Twelve Data error 400: interval is invalid/);
    const denied = createTwelveDataClient({ twelvedata: cfg(), logger, clock: () => NOW, fetchImpl: async () => res({ code: 401, status: 'error', message: 'apikey is incorrect' }, { status: 401 }), sleepFn: async () => {} });
    await assert.rejects(ask(denied, '2026-09-01'), /rejected the API key/);
  });

  it('treats "no data" as an empty window, but real errors fail', async () => {
    let s = make(() => ({ code: 400, status: 'error', message: '**symbol** No data is available on the specified dates.' }));
    assert.deepEqual((await ask(s.client, '2026-09-05', '2026-09-13')).candles, []);
    s = make(() => ({ code: 401, status: 'error', message: 'apikey is incorrect' }));
    await assert.rejects(ask(s.client, '2026-09-05'), /rejected the API key/);
    s = make(() => ({ status: 'ok' }));
    await assert.rejects(ask(s.client, '2026-09-05'), /malformed/);
    s = make(() => ({ status: 'ok', values: [{ datetime: 'garbage', open: '1', high: '1', low: '1', close: '1' }] }));
    await assert.rejects(ask(s.client, '2026-09-05'), /malformed Twelve Data candle time/);
    s = make(() => ({ status: 'ok', values: [value('2026-09-05 00:00:00', 'abc')] }));
    await assert.rejects(ask(s.client, '2026-09-05'), /malformed Twelve Data price/);
  });

  it('waits out the per-minute rate limit but stops on the daily credit limit', async () => {
    let s = make((_u, n) => (n === 1 ? { code: 429, status: 'error', message: 'You have run out of API credits for the current minute.' } : { status: 'ok', values: [value('2026-09-07 08:00:00')] }));
    assert.equal((await ask(s.client, '2026-09-07', '2026-09-13')).candles.length, 1);
    assert.ok(s.sleeps.includes(61_000), 'waited a minute');

    s = make(() => ({ code: 429, status: 'error', message: 'You have run out of API credits for the day.' }));
    await assert.rejects(ask(s.client, '2026-09-07'), /daily credit limit/);
    assert.equal(s.calls.length, 1, 'no pointless retries');
  });

  it('treats a response that hit the row cap as truncated: the cut-off day is never trusted', async () => {
    const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00`;
    // like the real API: rows start at the window's start date and stop at the row cap (here 2000)
    const handler = (u) => ({
      status: 'ok',
      values: Array.from({ length: Number(u.searchParams.get('outputsize')) }, (_, i) => {
        const day = new Date(Date.parse(`${u.searchParams.get('start_date').slice(0, 10)}T00:00:00Z`) + Math.floor(i / 1440) * 86_400_000).toISOString().slice(0, 10);
        return value(`${day} ${hhmm(i % 1440)}`);
      }),
    });
    let s = make(handler, { outputCap: 2000 });
    assert.equal((await ask(s.client, '2026-09-01', '2026-09-13')).candles.length, 1440); // day 1 complete, day 2 cut off
    assert.equal(s.calls.length, 1);
    assert.equal((await ask(s.client, '2026-09-02', '2026-09-13')).candles.length, 1440); // not cached: fetched again, in full
    assert.equal(s.calls.length, 2);

    s = make(handler, { outputCap: 1000 }); // even day 1 is cut off: refuse rather than return a partial day
    await assert.rejects(ask(s.client, '2026-09-01', '2026-09-13'), /truncated/);
  });

  it('is only for XAUUSD and needs a key', async () => {
    const { client } = make(() => ({ status: 'ok', values: [] }));
    await assert.rejects(client.fetchDayCandles({ instrument: 'EUR_USD', timeframe: 'M1', date: '2026-09-01' }), /only used for XAUUSD/);
    await assert.rejects(client.fetchDayCandles({ instrument: 'BTCUSDT', timeframe: 'M1', date: '2026-09-01' }), /only used for XAUUSD/);
    const keyless = createTwelveDataClient({ twelvedata: cfg({ apiKey: '' }), logger, clock: () => NOW, fetchImpl: async () => res({}), sleepFn: noSleep });
    await assert.rejects(keyless.fetchDayCandles({ instrument: 'XAUUSD', timeframe: 'M1', date: '2026-09-01' }), /not configured/);
  });
});
