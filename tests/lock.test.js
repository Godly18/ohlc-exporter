import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate, createSqliteDb } from '../backend/database/index.js';
import { silentLogger } from '../backend/lib/logger.js';
import { createGlobalLock } from '../backend/services/jobs/lock.js';
import { createJobRunner } from '../backend/services/jobs/jobRunner.js';
import { createClock } from './helpers/harness.js';

async function setup({ heartbeatMs = 20 } = {}) {
  const db = await createSqliteDb(':memory:');
  await migrate(db);
  const clock = createClock('2026-09-14T12:00:00Z');
  const lock = createGlobalLock(db, { leaseMs: 90_000, clock: clock.now, owner: 't' });
  const runner = createJobRunner({ lock, logger: silentLogger(), heartbeatMs, leaseMs: 90_000, clock: clock.now });
  return { db, clock, lock, runner };
}

describe('global lock', () => {
  it('the first request acquires; everyone else is refused immediately (no waiting, no queue)', async () => {
    const { lock } = await setup();
    assert.equal(await lock.acquire('job-a', 'export'), true);
    const started = Date.now();
    assert.equal(await lock.acquire('job-b', 'export'), false);
    assert.equal(await lock.acquire('job-c', 'maintenance'), false);
    assert.ok(Date.now() - started < 200, 'refusal must be immediate');
    assert.equal((await lock.current()).jobId, 'job-a');
  });

  it('exactly one of many concurrent acquirers wins (two workers can never own it)', async () => {
    const { lock } = await setup();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => lock.acquire(`job-${i}`, 'export')));
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('release frees the lock; only the owner can release or renew it', async () => {
    const { lock } = await setup();
    await lock.acquire('job-a', 'export');
    assert.equal(await lock.release('job-b'), false);
    assert.equal(await lock.heartbeat('job-b'), false);
    assert.equal(await lock.heartbeat('job-a'), true);
    assert.equal(await lock.release('job-a'), true);
    assert.equal(await lock.acquire('job-b', 'export'), true);
  });

  it('a crashed holder (no heartbeat for a full lease) is recovered automatically', async () => {
    const { lock, clock } = await setup();
    await lock.acquire('crashed', 'export');
    clock.advance(60_000);
    assert.equal(await lock.acquire('other', 'export'), false, 'lease still valid: active job');
    clock.advance(31_000);
    const stale = await lock.recoverStale();
    assert.equal(stale.jobId, 'crashed');
    assert.equal(await lock.acquire('other', 'export'), true);
    assert.equal(await lock.heartbeat('crashed'), false, 'the old owner has lost the lock');
  });

  it('acquire itself replaces a stale lease without manual cleanup', async () => {
    const { lock, clock } = await setup();
    await lock.acquire('crashed', 'maintenance');
    clock.advance(91_000);
    assert.equal(await lock.acquire('fresh', 'export'), true);
    assert.equal((await lock.current()).jobId, 'fresh');
  });

  it('heartbeats keep a long job alive past the lease', async () => {
    const { runner, lock, clock } = await setup({ heartbeatMs: 10 });
    const h = await runner.tryStart('export', 'long');
    clock.advance(80_000);
    await new Promise((r) => setTimeout(r, 40)); // heartbeat renews using the fake clock
    clock.advance(80_000);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await lock.current()).stale, false);
    assert.equal(await runner.tryStart('export', 'intruder'), null);
    await h.finish();
  });

  it('a job that loses the lock is told to abort', async () => {
    const { runner, db } = await setup({ heartbeatMs: 10 });
    const h = await runner.tryStart('export', 'victim');
    await db.query('DELETE FROM job_lock WHERE id = 1'); // taken over / wiped
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.signal.aborted, true);
    await h.finish();
  });

  it('the runner never queues: busy returns null, and finish() always releases', async () => {
    const { runner, lock } = await setup();
    const a = await runner.tryStart('export', 'a');
    assert.ok(a);
    assert.equal(await runner.tryStart('export', 'b'), null);
    assert.equal(await runner.tryStart('maintenance', 'm'), null);
    await a.finish();
    assert.equal(await lock.current(), null);
    const b = await runner.tryStart('maintenance', 'm');
    assert.ok(b);
    await b.finish();
  });
});
