import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { datasetKey } from '../backend/services/r2/keys.js';
import { newExportId, newJobId, sha256Hex } from '../backend/lib/tokens.js';
import { createHarness } from './helpers/harness.js';

const body = (start = '2026-09-01', end = '2026-09-03') => ({ instrument: 'EUR_USD', timeframe: 'M1', start_date: start, end_date: end });
const exportRows = async (h) => (await h.db.query('SELECT * FROM exports ORDER BY requested_at')).rows;

const harnesses = [];
const make = async (opts) => {
  const h = await createHarness(opts);
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  // close in reverse so restarted instances (which share a db) go first
  while (harnesses.length) await harnesses.pop().close();
});

describe('stale lock and orphaned job recovery', () => {
  it('a crashed holder leaves a lock + a PROCESSING export; startup recovery frees both without manual DB edits', async () => {
    const h = await make();
    const crashedJob = newJobId();
    assert.equal(await h.services.lock.acquire(crashedJob, 'export'), true);
    await h.services.exportsRepo.create({
      jobId: crashedJob,
      exportId: newExportId(),
      sessionHash: 'x',
      instrument: 'EUR_USD',
      timeframe: 'M1',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    });
    await h.services.datasetsRepo.setActivity('EUR_USD', 'M1', 2026, 'DOWNLOADING');
    await h.services.datasetsRepo.setDay('EUR_USD', 'M1', '2026-09-02', 'DOWNLOADING');

    // restart shortly after the crash: the lease is still valid, so the job might be alive -> leave it
    await h.services.cleanup.startupRecovery();
    assert.equal((await h.services.lock.current())?.jobId, crashedJob);
    assert.equal((await h.services.exportsRepo.get(crashedJob)).status, 'PROCESSING');

    // once the lease has lapsed the job is provably dead
    h.clock.advance(91_000);
    await h.services.cleanup.startupRecovery();
    assert.equal(await h.services.lock.current(), null);
    const failed = await h.services.exportsRepo.get(crashedJob);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'JOB_INTERRUPTED');
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).activity, 'IDLE');
    assert.equal(await h.services.datasetsRepo.getDay('EUR_USD', 'M1', '2026-09-02'), null);

    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    assert.equal(res.status, 202, 'the system accepts work again');
    assert.equal((await h.waitForJob(c, res.json.jobId)).status, 'READY');
  });

  it('never fails a job that is genuinely running', async () => {
    const h = await make();
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    await h.services.cleanup.reconcile();
    assert.equal((await h.services.exportsRepo.get(res.json.jobId)).status, 'PROCESSING');
    release();
    assert.equal((await h.waitForJob(c, res.json.jobId)).status, 'READY');
  });

  it('a job that lost its lock cannot later publish a READY export', async () => {
    const h = await make();
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    // another instance declares the job dead and fails it
    await h.services.exportsRepo.markFailed(res.json.jobId, { code: 'JOB_INTERRUPTED', message: 'x' });
    release();
    await h.services.exportService.whenIdle();
    const row = await h.services.exportsRepo.get(res.json.jobId);
    assert.equal(row.status, 'FAILED');
    assert.equal(h.storage.keys('exports/').length, 0, 'the orphaned CSV was removed');
  });
});

describe('restart and export expiry', () => {
  async function readyThenRestart(afterMs) {
    const h1 = await make();
    const c = h1.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    const job = await h1.waitForJob(c, res.json.jobId);
    assert.equal(job.status, 'READY');
    // "crash": the old process just stops; a new one starts later against the same database + R2
    const h2 = await make({ now: new Date(h1.clock.now() + afterMs).toISOString(), db: h1.db, storage: h1.storage });
    await h2.services.cleanup.startupRecovery();
    return { h1, h2, job, c, c2: { request: (p, o) => h2.browser().request(p, o) } };
  }

  it('restart AFTER expiry (10:00 -> 10:20): the export is deleted and its token rejected', async () => {
    const { h2, job } = await readyThenRestart(20 * 60_000);
    assert.equal(h2.storage.keys('exports/').length, 0);
    const res = await h2.browser().request(job.download.url);
    assert.equal(res.status, 410);
  });

  it('restart BEFORE expiry (10:00 -> 10:03): the export is retained and still downloadable until 10:05', async () => {
    const { h2, job } = await readyThenRestart(3 * 60_000);
    assert.equal(h2.storage.keys('exports/').filter((k) => k.endsWith('.zip')).length, 1);
    assert.equal((await h2.browser().request(job.download.url)).status, 200);
    h2.clock.advance(2 * 60_000);
    assert.equal((await h2.browser().request(job.download.url)).status, 410);
  });
});

describe('crash safety of generation and storage', () => {
  it('a crash/outage while the CSV is being written never produces a READY export or leaves a partial object', async () => {
    const h = await make();
    h.storage.hooks.failOn = (op) => {
      if (op === 'putChunks:chunk') throw new Error('disk full');
    };
    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    const job = await h.waitForJob(c, res.json.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(h.storage.keys('exports/').length, 0);
    assert.ok((await exportRows(h)).every((r) => r.status !== 'READY'));
    assert.equal(await h.services.lock.current(), null);
  });

  it('a crash that leaves a partially staged dataset is cleaned up and never used', async () => {
    const h = await make();
    const tmp = `${datasetKey('EUR_USD', 'M1', 2026)}.tmp`;
    h.storage.objects.set(tmp, { buf: Buffer.from('half-written'), lastModified: h.clock.now() - 60 * 60_000 });
    await h.services.cleanup.startupRecovery();
    assert.equal(h.storage.objects.has(tmp), false);

    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body() });
    assert.equal((await h.waitForJob(c, res.json.jobId)).status, 'READY');
  });

  it('orphan sweep removes old untracked CSVs and abandoned staging files but spares fresh files and permanent data', async () => {
    const h = await make();
    const old = h.clock.now() - 60 * 60_000;
    const put = (key, lastModified) => h.storage.objects.set(key, { buf: Buffer.from('x'), lastModified });
    put(`exports/${'a'.repeat(32)}.csv`, old); // untracked + old -> delete
    put(`exports/${'b'.repeat(32)}.csv`, h.clock.now() - 60_000); // fresh -> keep
    put('oanda-data/EUR_USD/M1/2024.bin.tmp', old); // abandoned staging -> delete
    put('oanda-data/EUR_USD/M1/2024.bin', old); // permanent, however old -> NEVER delete
    put('oanda-data/_quarantine/EUR_USD/M1/2023.123.bin', old); // quarantine -> keep
    await h.services.cleanup.sweepOrphans();
    assert.deepEqual(h.storage.keys(), [
      `exports/${'b'.repeat(32)}.csv`,
      'oanda-data/EUR_USD/M1/2024.bin',
      'oanda-data/_quarantine/EUR_USD/M1/2023.123.bin',
    ]);
  });

  it('an outage during an OANDA download fails the request, saves what was retrieved, and the next run completes it', async () => {
    const h = await make();
    h.oanda.failOn = (d) => (d === '2026-01-10' ? new Error('connection reset') : undefined);
    const c = h.browser();
    const res = await c.request('/api/export', { method: 'POST', body: body('2026-01-05', '2026-01-20') });
    const job = await h.waitForJob(c, res.json.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.download, null);
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).lastCompleteDate, '2026-01-09');

    h.oanda.failOn = null;
    h.oanda.calls.length = 0;
    const again = await c.request('/api/export', { method: 'POST', body: body('2026-01-05', '2026-01-20') });
    assert.equal((await h.waitForJob(c, again.json.jobId)).status, 'READY');
    assert.equal(h.oanda.calls[0].date, '2026-01-10', 'resumes right after the saved day');
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).lastCompleteDate, '2026-09-13');
  });

  it('the job keeps running on the server when the browser goes away; the data is then in R2 for a later request', async () => {
    const h = await make();
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const gone = h.browser();
    const res = await gone.request('/api/export', { method: 'POST', body: body('2026-09-01', '2026-09-03') });
    assert.equal(res.status, 202); // ... and this browser never polls again
    release();
    await h.services.exportService.whenIdle();
    assert.equal(await h.services.lock.current(), null);
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2026)).lastCompleteDate, '2026-09-13');
    h.oanda.calls.length = 0;
    const later = h.browser();
    const again = await later.request('/api/export', { method: 'POST', body: body('2026-09-01', '2026-09-03') });
    assert.equal((await h.waitForJob(later, again.json.jobId)).status, 'READY');
    assert.equal(h.oanda.calls.length, 0, 'served from R2 without downloading anything');
  });

  it('hourly maintenance continues an interrupted OLDER year, not just the current one', async () => {
    const h = await make();
    h.oanda.failOn = (d) => (d === '2024-06-01' ? new Error('outage') : undefined);
    await assert.rejects(h.services.datasetService.ensure({ instrument: 'EUR_USD', timeframe: 'M1', year: 2024, through: '2024-12-31' }));
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2024)).lastCompleteDate, '2024-05-31');
    h.oanda.failOn = null;
    await h.services.maintenance.runOnce();
    assert.equal((await h.services.datasetsRepo.get('EUR_USD', 'M1', 2024)).status, 'COMPLETE');
  });

  it('corrupted datasets are rebuilt transparently while serving a user request', async () => {
    const h = await make();
    const c = h.browser();
    const first = await h.waitForJob(c, (await c.request('/api/export', { method: 'POST', body: body() })).json.jobId);
    const csv1 = (await c.request(first.download.url)).text;

    const obj = h.storage.objects.get(datasetKey('EUR_USD', 'M1', 2026));
    obj.buf = Buffer.from(obj.buf);
    obj.buf[100] ^= 0xff;

    const second = await h.waitForJob(c, (await c.request('/api/export', { method: 'POST', body: body() })).json.jobId);
    assert.equal(second.status, 'READY');
    assert.equal((await c.request(second.download.url)).text, csv1, 'never serves corrupted data; output identical to the clean build');
    assert.equal(h.storage.keys('oanda-data/_quarantine/').length, 1);
  });
});

describe('metadata hygiene', () => {
  it('purges old finished export rows but keeps recent ones', async () => {
    const h = await make();
    const c = h.browser();
    const job = await h.waitForJob(c, (await c.request('/api/export', { method: 'POST', body: body() })).json.jobId);
    h.clock.advance(6 * 60_000);
    await h.services.cleanup.runExpiredCleanup();
    assert.equal((await exportRows(h)).length, 1);
    h.clock.advance(61 * 60_000);
    await h.services.cleanup.runExpiredCleanup();
    assert.equal((await exportRows(h)).length, 0);
    assert.equal(sha256Hex(job.jobId).length, 64);
  });
});
