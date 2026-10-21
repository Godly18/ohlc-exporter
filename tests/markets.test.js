import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../backend/config/index.js';
import { parseHeader } from '../backend/lib/binformat.js';
import { validateExportRequest } from '../backend/lib/validation.js';
import { createHarness } from './helpers/harness.js';

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

const NOW = Date.parse('2026-09-14T12:00:00Z');
const req = (instrument, start, end) => ({ instrument, timeframe: 'M1', start_date: start, end_date: end });
const cfg = (env = {}) => loadConfig({ EXPORT_TOKEN_SECRET: 'x'.repeat(20), MIN_DATA_YEAR: '2010', TWELVEDATA_API_KEY: 'k', ...env }).config;
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};


describe('year enforcement per instrument', () => {
  it('crypto starts at 2018-01-01, gold at 2021-01-01, forex follows MIN_DATA_YEAR', () => {
    const c = cfg();
    for (const pair of ['BTCUSDT', 'ADABTC', 'XLMETH']) {
      const e = code(() => validateExportRequest(req(pair, '2017-12-31', '2018-01-02'), NOW, c));
      assert.equal(e.code, 'DATE_TOO_EARLY');
      assert.match(e.message, /from 2018-01-01/);
      assert.equal(validateExportRequest(req(pair, '2018-01-01', '2018-01-02'), NOW, c).instrument, pair);
    }
    const g = code(() => validateExportRequest(req('XAUUSD', '2020-12-31', '2021-01-02'), NOW, c));
    assert.equal(g.code, 'DATE_TOO_EARLY');
    assert.match(g.message, /XAU\/USD is only available from 2021-01-01/);
    assert.equal(validateExportRequest(req('XAUUSD', '2021-01-01', '2021-01-02'), NOW, c).instrument, 'XAUUSD');
    assert.equal(validateExportRequest(req('EUR_USD', '2012-01-01', '2012-01-02'), NOW, c).instrument, 'EUR_USD');
    assert.equal(code(() => validateExportRequest(req('EUR_USD', '2009-12-31', '2010-01-02'), NOW, c)).code, 'DATE_TOO_EARLY');
  });

  it('a stricter global MIN_DATA_YEAR still applies on top, and the end date rules are unchanged', () => {
    const c = cfg({ MIN_DATA_YEAR: '2024' });
    assert.equal(code(() => validateExportRequest(req('BTCUSDT', '2023-12-31', '2024-01-02'), NOW, c)).code, 'DATE_TOO_EARLY');
    assert.equal(code(() => validateExportRequest(req('BTCUSDT', '2026-09-01', '2026-09-14'), NOW, c)).code, 'DATA_NOT_AVAILABLE_YET'); // today
  });

  it('XAUUSD is not offered or accepted without a Twelve Data key; crypto needs no key', async () => {
    assert.equal(code(() => validateExportRequest(req('XAUUSD', '2026-09-01', '2026-09-02'), NOW, cfg({ TWELVEDATA_API_KEY: '' }))).code, 'INVALID_INSTRUMENT');
    assert.equal(validateExportRequest(req('BTCUSDT', '2026-09-01', '2026-09-02'), NOW, cfg({ TWELVEDATA_API_KEY: '' })).instrument, 'BTCUSDT');

    h = await createHarness({ env: { TWELVEDATA_API_KEY: '' } });
    const { json } = await h.browser().request('/api/config');
    assert.ok(!json.instruments.some((i) => i.code === 'XAUUSD'));
    assert.equal(json.instruments.length, 91);
  });

  it('/api/config lists every instrument with group, label and its first year', async () => {
    h = await createHarness({ env: { MIN_DATA_YEAR: '2010' } });
    const { json } = await h.browser().request('/api/config');
    assert.equal(json.instruments.length, 92);
    const by = new Map(json.instruments.map((i) => [i.code, i]));
    assert.deepEqual(by.get('BTCUSDT'), { code: 'BTCUSDT', label: 'BTC/USDT', group: 'Crypto', minYear: 2018 });
    assert.deepEqual(by.get('XAUUSD'), { code: 'XAUUSD', label: 'XAU/USD', group: 'Metals', minYear: 2021 });
    assert.deepEqual(by.get('EUR_USD'), { code: 'EUR_USD', label: 'EUR/USD', group: 'Forex', minYear: 2010 });
    assert.equal(json.instruments.filter((i) => i.group === 'Forex').length, 68);
    assert.equal(json.instruments.filter((i) => i.group === 'Crypto').length, 23);
  });
});

describe('crypto exports (Binance)', () => {
  it('builds a v2 dataset from Binance only, exports exact decimals, and reuses it afterwards', async () => {
    h = await createHarness();
    const c = h.browser();
    const start = await c.request('/api/export', { method: 'POST', body: req('BTCUSDT', '2026-09-01', '2026-09-03') });
    assert.equal(start.status, 202);
    const job = await h.waitForJob(c, start.json.jobId);
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    assert.equal(h.oanda.calls.length, 0, 'forex provider untouched');
    assert.equal(h.twelvedata.calls.length, 0, 'Twelve Data is never used for crypto');
    assert.ok(h.binance.calls.length > 0);
    assert.ok(h.binance.calls.every((x) => x.instrument === 'BTCUSDT'));

    const csv = await c.request(job.download.url);
    const lines = csv.text.trimEnd().split('\n');
    assert.equal(lines[0], 'timestamp,open,high,low,close,volume');
    assert.equal(lines.length - 1, 3 * 24); // fake: one candle per hour, all 3 days (crypto trades on weekends too)
    const first = lines[1].split(',');
    assert.equal(first[0], '2026-09-01T00:00:00Z');
    assert.match(first[1], /^65000\.\d{2,}$/);
    assert.match(first[5], /^\d+\.\d+$/); // fractional volume
    assert.equal(lines[1].split(',').length, 6);
    assert.ok(lines.some((l) => l.startsWith('2026-09-03T23:00:00Z')), 'end date inclusive through 23:xx');

    // stored as format v2, with the instrument's scales
    const key = 'oanda-data/BTCUSDT/M1/2026.bin';
    const header = parseHeader(await h.storage.getObjectBuffer(key));
    assert.equal(header.version, 2);
    assert.equal(header.priceScale, 1e8);
    assert.equal(header.volumeScale, 1e8);
    assert.equal(header.completeThrough, '2026-09-13', 'the whole year so far (through yesterday) is stored, not just the requested days');

    // second request: nothing new to download
    const before = h.binance.calls.length;
    const again = await c.request('/api/export', { method: 'POST', body: req('BTCUSDT', '2026-09-02', '2026-09-03') });
    await h.waitForJob(c, again.json.jobId);
    assert.equal(h.binance.calls.length, before);
  });

  it('sends the day-range hint so providers never look past the last verifiable day', async () => {
    h = await createHarness();
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('ETHUSDT', '2026-09-01', '2026-09-02') });
    await h.waitForJob(c, s.json.jobId);
    assert.ok(h.binance.calls.every((x) => x.lastDay === '2026-09-13'));
  });

  it('accepts empty days before a pair is listed AND holes after trading started (reported, not refused)', async () => {
    h = await createHarness({ binanceOpts: { listedFrom: '2026-03-10' } });
    const c = h.browser();
    let s = await c.request('/api/export', { method: 'POST', body: req('LINKBTC', '2026-09-01', '2026-09-02') });
    let job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'READY', 'leading empty days (not yet listed) are accepted');
    const csv = (await c.request(job.download.url)).text.split('\n');
    assert.equal(csv[1].split(',')[0], '2026-09-01T00:00:00Z');

    await h.close();
    h = await createHarness({ binanceOpts: { listedFrom: '2026-03-10' } });
    h.binance.emptyDays.add('2026-05-01'); // a whole day missing in the middle of trading
    const c2 = h.browser();
    s = await c2.request('/api/export', { method: 'POST', body: req('LINKBTC', '2026-04-30', '2026-05-02') });
    job = await h.waitForJob(c2, s.json.jobId);
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    const stored = await h.storage.getObjectBuffer('oanda-data/LINKBTC/M1/2026.bin');
    assert.equal(parseHeader(stored).completeThrough, '2026-09-13', 'the hole is stored as an empty day and the year is saved');
    const rep2 = (await c2.request(job.download.url)).files.find((f) => f.name.endsWith('_missing_data.txt'));
    assert.match(rep2.data.toString(), /2026-05-01 \(Fri\)/);
  });

  it('tells the user when a pair has no data at all in the requested range', async () => {
    h = await createHarness({ binanceOpts: { listedFrom: '2026-09-10' } });
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('LINKBTC', '2026-09-01', '2026-09-05') });
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, 'NO_DATA');
    assert.match(job.error.message, /No data exists/);
  });

  it('a candle that is still open fails the request ("try again later"); the days before it are saved', async () => {
    h = await createHarness();
    h.binance.incompleteDays.add('2026-09-02');
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('BNBBTC', '2026-09-01', '2026-09-02') });
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.code, 'DATA_NOT_AVAILABLE_YET');
    assert.equal(job.download, null);
    assert.ok(h.storage.keys('oanda-data/').some((k) => k.endsWith('/2026.bin')), 'days before the open candle were saved');
  });

  it('a forex-format file under a crypto name is treated as corrupt and rebuilt', async () => {
    h = await createHarness();
    const c = h.browser();
    let s = await c.request('/api/export', { method: 'POST', body: req('XRPETH', '2026-09-01', '2026-09-01') });
    await h.waitForJob(c, s.json.jobId);
    const key = 'oanda-data/XRPETH/M1/2026.bin';
    const buf = Buffer.from(await h.storage.getObjectBuffer(key));
    buf.writeUInt32LE(100_000, 36); // claim the wrong price scale
    await h.storage.putObject(key, buf, {});
    s = await c.request('/api/export', { method: 'POST', body: req('XRPETH', '2026-09-01', '2026-09-01') });
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'READY');
    assert.ok([...(await h.storage.listObjects('oanda-data/_quarantine/'))].length >= 1);
  });
});

describe('gold exports (Twelve Data, XAUUSD only)', () => {
  it('builds XAUUSD from Twelve Data only, with the forex-style calendar', async () => {
    h = await createHarness();
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('XAUUSD', '2026-09-10', '2026-09-13') });
    assert.equal(s.status, 202);
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    assert.equal(h.oanda.calls.length, 0);
    assert.equal(h.binance.calls.length, 0, 'Binance is never used for gold');
    assert.ok(h.twelvedata.calls.every((x) => x.instrument === 'XAUUSD'));
    const lines = (await c.request(job.download.url)).text.trimEnd().split('\n');
    assert.match(lines[1], /^2026-09-10T00:00:00Z,2000\.\d{2,},/);
    assert.ok(!lines.some((l) => l.startsWith('2026-09-12')), 'Saturday has no gold candles');
    assert.equal(parseHeader(await h.storage.getObjectBuffer('oanda-data/XAUUSD/M1/2026.bin')).version, 1);
  });

  it('an empty weekday is accepted for gold and listed in the missing-data report', async () => {
    h = await createHarness();
    h.twelvedata.emptyDays.add('2026-09-09');
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('XAUUSD', '2026-09-08', '2026-09-10') });
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    const rep = (await c.request(job.download.url)).files.find((f) => f.name.endsWith('_missing_data.txt'));
    assert.match(rep.data.toString(), /2026-09-09 \(Wed\)/);
  });

  it('forex still goes to OANDA only', async () => {
    h = await createHarness();
    const c = h.browser();
    const s = await c.request('/api/export', { method: 'POST', body: req('GBP_AUD', '2026-09-08', '2026-09-09') });
    const job = await h.waitForJob(c, s.json.jobId);
    assert.equal(job.status, 'READY');
    assert.equal(h.binance.calls.length + h.twelvedata.calls.length, 0);
    assert.ok(h.oanda.calls.every((x) => x.instrument === 'GBP_AUD'));
  });
});
