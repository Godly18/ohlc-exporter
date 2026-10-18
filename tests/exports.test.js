import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { datasetKey } from '../backend/services/r2/keys.js';
import { newJobId } from '../backend/lib/tokens.js';
import { createHarness } from './helpers/harness.js';

const body = (start, end, extra = {}) => ({ instrument: 'EUR_USD', timeframe: 'M1', start_date: start, end_date: end, ...extra });
const parseCsv = (text) => text.trim().split('\n').slice(1).map((l) => l.split(','));
const exportsInStorage = (h) => h.storage.keys('exports/');

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

async function generate(client, start, end) {
  const res = await client.request('/api/export', { method: 'POST', body: body(start, end) });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  return h.waitForJob(client, res.json.jobId);
}

describe('CSV generation', () => {
  it('produces the right columns and only the requested inclusive UTC days', async () => {
    h = await createHarness();
    const c = h.browser();
    const job = await generate(c, '2026-09-01', '2026-09-13');
    assert.equal(job.status, 'READY');
    assert.equal(job.download.filename, 'EUR_USD_M1_2026-09-01_2026-09-13.csv');

    const csv = await c.request(job.download.url);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="EUR_USD_M1_2026-09-01_2026-09-13\.csv"/);
    assert.equal(csv.text.split('\n')[0], 'timestamp,open,high,low,close,volume');

    const rows = parseCsv(csv.text);
    assert.equal(rows.length, job.download.rows);
    assert.equal(rows[0][0], '2026-09-01T00:00:00Z'); // first instant of the start date
    assert.ok(rows.some((r) => r[0].startsWith('2026-09-13T22:')), 'end date is inclusive (Sunday evening candles)');
    assert.ok(rows.every((r) => r[0] >= '2026-09-01T00:00:00Z' && r[0] < '2026-09-14T00:00:00Z'));
    assert.ok(rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]), 'strictly chronological');
    assert.ok(!rows.some((r) => r[0].startsWith('2026-09-12')), 'Saturday has no candles');
  });

  it('a single-year request loads only that year, and reuses stored data without contacting OANDA', async () => {
    h = await createHarness();
    const c = h.browser();
    await generate(c, '2025-06-15', '2025-08-20');
    h.oanda.calls.length = 0;
    h.storage.ops.length = 0;

    const job = await generate(c, '2025-07-01', '2025-07-31');
    assert.equal(job.status, 'READY');
    assert.equal(h.oanda.calls.length, 0);
    const datasetReads = h.storage.ops.filter((o) => o.startsWith('get:oanda-data/'));
    assert.deepEqual(datasetReads, [`get:${datasetKey('EUR_USD', 'M1', 2025)}`]);
  });

  it('a cross-year request merges the intersecting yearly datasets chronologically', async () => {
    h = await createHarness();
    const c = h.browser();
    const job = await generate(c, '2025-12-20', '2026-01-10');
    assert.equal(job.status, 'READY');
    const rows = parseCsv((await c.request(job.download.url)).text);
    assert.equal(rows[0][0], '2025-12-21T22:00:00Z'); // Sat 20th is closed; Sunday 21st opens at 22:00 UTC
    assert.ok(rows.some((r) => r[0].startsWith('2025-12-31')));
    assert.ok(rows.some((r) => r[0].startsWith('2026-01-02')));
    assert.ok(rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]));
    assert.deepEqual(h.storage.keys('oanda-data/'), [datasetKey('EUR_USD', 'M1', 2025), datasetKey('EUR_USD', 'M1', 2026)]);
    assert.ok(!rows.some((r) => r[0] >= '2026-01-11'));
  });

  it('fills the lock-protected catch-up as part of a request (Sep 10 stored, Sep 12 requested)', async () => {
    h = await createHarness();
    await h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2026, through: '2026-09-10' });
    h.oanda.calls.length = 0;
    const c = h.browser();
    const job = await generate(c, '2026-09-08', '2026-09-12');
    assert.equal(job.status, 'READY');
    assert.deepEqual(h.oanda.calls.map((x) => x.date), ['2026-09-11', '2026-09-12']);
  });
});

describe('availability: never return partial or in-progress data', () => {
  it('rejects the current UTC day without touching OANDA or the lock', async () => {
    h = await createHarness();
    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body('2026-09-14', '2026-09-14') });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'DATA_NOT_AVAILABLE_YET');
    assert.equal(res.json.error.message, 'Data not available yet. The requested date is still in progress. Please retry later.');
    assert.equal(h.oanda.calls.length, 0);
    assert.equal(await h.services.lock.current(), null);
  });

  it('does not shorten Sep 1 -> Sep 14 to Sep 13', async () => {
    h = await createHarness();
    const res = await h.browser().request('/api/export', { method: 'POST', body: body('2026-09-01', '2026-09-14') });
    assert.equal(res.status, 409);
    assert.equal(exportsInStorage(h).length, 0);
  });

  it('rejects a just-ended day that has not settled yet', async () => {
    h = await createHarness({ now: '2026-09-14T00:03:00Z' });
    const res = await h.browser().request('/api/export', { method: 'POST', body: body('2026-09-10', '2026-09-13') });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.message, 'Data not available yet. The requested date has not been fully processed and verified. Please retry later.');
  });

  it('a day OANDA has not completed fails the whole request: no partial CSV, clear message, lock released', async () => {
    h = await createHarness();
    h.oanda.incompleteDays.add('2026-09-13');
    const c = h.browser();
    const job = await generate(c, '2026-09-01', '2026-09-13');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.message, 'Data not available yet. The requested date has not been fully processed and verified. Please retry later.');
    assert.equal(job.download, null);
    assert.equal(exportsInStorage(h).length, 0);
    assert.equal(await h.services.lock.current(), null);
    // The days before it were verified and kept; the unverified day is not claimed.
    const m = await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026);
    assert.ok(!m || m.lastCompleteDate < '2026-09-13');
  });
});

describe('export lifetime: exactly five minutes, server-enforced', () => {
  async function ready() {
    h = await createHarness();
    const c = h.browser();
    const job = await generate(c, '2026-09-01', '2026-09-05');
    assert.equal(job.status, 'READY');
    return { c, job };
  }

  it('expires exactly 5 minutes after creation', async () => {
    const { job } = await ready();
    const row = await h.services.exportsRepo.get(job.jobId);
    assert.equal(row.expiresAt - row.createdAt, 5 * 60_000);
    assert.equal(job.download.expiresInSeconds, 300);
  });

  it('is downloadable until the last second, multiple times, then rejected', async () => {
    const { c, job } = await ready();
    h.clock.advance(60_000);
    assert.equal((await c.request(job.download.url)).status, 200);
    h.clock.advance(3 * 60_000 + 59_000); // 4:59
    assert.equal((await c.request(job.download.url)).status, 200);
    assert.equal((await c.request(job.download.url)).status, 200); // multiple downloads are fine
    h.clock.advance(1_000); // 5:00
    const gone = await c.request(job.download.url);
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.message, 'This download has expired. Please generate the data again.');
  });

  it('rejects an expired token even though the R2 object still exists (not relying on R2)', async () => {
    const { c, job } = await ready();
    h.clock.advance(5 * 60_000 + 1);
    assert.equal(exportsInStorage(h).length, 1);
    assert.equal((await c.request(job.download.url)).status, 410);
    const status = await c.request(`/api/export/status/${job.jobId}`);
    assert.equal(status.json.status, 'EXPIRED');
  });

  it('a page refresh recovers the same still-valid export for that browser only', async () => {
    const { c, job } = await ready();
    h.clock.advance(2 * 60_000);
    const refreshed = await c.request('/api/export/active'); // same cookie = same browser
    assert.equal(refreshed.json.active.status, 'READY');
    assert.equal(refreshed.json.active.download.url, job.download.url);
    assert.equal(refreshed.json.active.download.expiresInSeconds, 180);
    assert.equal((await c.request(refreshed.json.active.download.url)).status, 200);

    const stranger = await h.browser().request('/api/export/active');
    assert.equal(stranger.json.active, null);
  });

  it('after expiry a refresh reports the expired message', async () => {
    const { c } = await ready();
    h.clock.advance(5 * 60_000);
    const res = await c.request('/api/export/active');
    assert.equal(res.json.active.status, 'EXPIRED');
    assert.equal(res.json.active.error.message, 'This download has expired. Please generate the data again.');
  });

  it('only a hash of the token is stored and the token is never logged', async () => {
    const { job } = await ready();
    const token = job.download.url.split('/').pop();
    const row = await h.services.exportsRepo.get(job.jobId);
    assert.notEqual(row.downloadTokenHash, token);
    const dump = JSON.stringify((await h.db.query('SELECT * FROM exports')).rows);
    assert.ok(!dump.includes(token));
    assert.ok(!h.logLines.some((l) => l.line.includes(token)));
  });
});

describe('cleanup of temporary exports', () => {
  it('physically deletes expired CSVs, keeps unexpired ones, and never touches permanent datasets', async () => {
    h = await createHarness();
    const c = h.browser();
    const first = await generate(c, '2026-09-01', '2026-09-03');
    h.clock.advance(3 * 60_000);
    const second = await generate(c, '2026-09-02', '2026-09-04');
    assert.equal(exportsInStorage(h).length, 2);
    const datasets = h.storage.keys('oanda-data/');
    assert.ok(datasets.length === 1);

    h.clock.advance(2 * 60_000); // first: 5:00 old (expired); second: 2:00 old
    const r = await h.services.cleanup.runExpiredCleanup();
    assert.equal(r.deleted, 1);
    assert.equal(exportsInStorage(h).length, 1);
    assert.equal((await c.request(second.download.url)).status, 200);
    assert.equal((await c.request(first.download.url)).status, 410);

    h.clock.advance(3 * 60_000);
    await h.services.cleanup.runExpiredCleanup();
    assert.equal(exportsInStorage(h).length, 0);
    assert.deepEqual(h.storage.keys('oanda-data/'), datasets, 'permanent .bin untouched');
  });

  it('the periodic worker scans on its interval', async () => {
    h = await createHarness({ env: { CLEANUP_INTERVAL_SECONDS: '5' } });
    const c = h.browser();
    await generate(c, '2026-09-01', '2026-09-03');
    h.clock.advance(5 * 60_000);
    await h.services.cleanup.tick();
    assert.equal(exportsInStorage(h).length, 0);
  });
});

describe('single global job, no queue', () => {
  it('second request gets SYSTEM BUSY immediately; nothing is queued; lock frees afterwards', async () => {
    h = await createHarness();
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const a = h.browser();
    const b = h.browser();

    const first = await a.request('/api/export', { method: 'POST', body: body('2026-09-01', '2026-09-05') });
    assert.equal(first.status, 202);

    const t0 = Date.now();
    const second = await b.request('/api/export', { method: 'POST', body: body('2026-09-02', '2026-09-03') });
    assert.ok(Date.now() - t0 < 500, 'busy must be immediate');
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'SYSTEM_BUSY');
    assert.equal(second.json.error.message, 'System busy. Another data request is currently being processed. Please try again shortly.');
    assert.equal((await h.db.query('SELECT COUNT(*) AS n FROM exports')).rows[0].n, 1, 'busy request left no hidden job');

    release();
    const done = await h.waitForJob(a, first.json.jobId);
    assert.equal(done.status, 'READY');
    assert.equal(await h.services.lock.current(), null, 'lock released once the CSV is ready');
    await h.services.exportService.whenIdle();
    assert.equal((await h.db.query('SELECT COUNT(*) AS n FROM exports')).rows[0].n, 1, 'the refused request was not retried automatically');

    const third = await b.request('/api/export', { method: 'POST', body: body('2026-09-02', '2026-09-03') });
    assert.equal(third.status, 202);
  });

  it('a failed job releases the lock', async () => {
    h = await createHarness();
    h.oanda.failOn = () => new Error('upstream exploded');
    const c = h.browser();
    const job = await generate(c, '2026-09-01', '2026-09-05');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error.message, 'The requested historical data could not be prepared at this time. Please try again later.');
    assert.ok(!JSON.stringify(job).includes('exploded'), 'internal details are never exposed');
    assert.equal(await h.services.lock.current(), null);
  });

  it('maintenance and a user job can never run at the same time (either order)', async () => {
    h = await createHarness();
    await h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2026, through: '2026-09-10' });

    // user job holds the lock -> maintenance skips, nothing queued
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const c = h.browser();
    const started = await c.request('/api/export', { method: 'POST', body: body('2026-09-11', '2026-09-12') });
    assert.equal(started.status, 202);
    assert.deepEqual(await h.services.maintenance.runOnce(), { skipped: 'busy' });
    release();
    await h.waitForJob(c, started.json.jobId);

    // maintenance holds the lock -> a user request is told SYSTEM BUSY
    const handle = await h.services.runner.tryStart('maintenance', newJobId());
    const refused = await c.request('/api/export', { method: 'POST', body: body('2026-09-01', '2026-09-02') });
    assert.equal(refused.json.error.code, 'SYSTEM_BUSY');
    await handle.finish();
  });
});

describe('maintenance of current-year data', () => {
  it('catches up every missing complete day after downtime', async () => {
    h = await createHarness();
    await h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2026, through: '2026-09-10' });
    h.oanda.calls.length = 0;
    await h.services.maintenance.runOnce();
    assert.deepEqual(h.oanda.calls.map((x) => x.date), ['2026-09-11', '2026-09-12', '2026-09-13']);
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).lastCompleteDate, '2026-09-13');
    assert.equal(await h.services.lock.current(), null);

    h.oanda.calls.length = 0;
    await h.services.maintenance.runOnce(); // already current: no OANDA traffic
    assert.equal(h.oanda.calls.length, 0);
  });

  it('is limited to what is fetchable (never the in-progress day, never inside the settle window)', async () => {
    h = await createHarness({ now: '2026-09-14T00:04:00Z' });
    await h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2026, through: '2026-09-10' });
    h.oanda.calls.length = 0;
    await h.services.maintenance.runOnce();
    assert.deepEqual(h.oanda.calls.map((x) => x.date), ['2026-09-11', '2026-09-12']); // 09-13 just ended: not yet
  });

  it('completes the old year and starts the new one at a year transition', async () => {
    h = await createHarness({ now: '2027-01-02T12:00:00Z' });
    await h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2026, through: '2026-12-30' });
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).status, 'COMPLETE_THROUGH_DAY');
    await h.services.maintenance.runOnce();
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).status, 'COMPLETE');
    const next = await h.services.datasetsRepo.get('EUR_USD', 'M1', 2027);
    assert.equal(next.status, 'COMPLETE_THROUGH_DAY');
    assert.equal(next.lastCompleteDate, '2027-01-01');
  });
});
