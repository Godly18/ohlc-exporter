import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DataNotReadyError, DatasetBuildError } from '../backend/lib/errors.js';
import { DayState } from '../backend/lib/time.js';
import { datasetKey } from '../backend/services/r2/keys.js';
import { createHarness } from './helpers/harness.js';

const ID = { instrument: 'EUR_USD', timeframe: 'M1' };
const key = (year) => datasetKey('EUR_USD', 'M1', year);
const ensure = (h, year, through, extra = {}) =>
  h.services.datasetService.ensure({ ...ID, year, through, ...extra });
const meta = (h, year) => h.services.datasetsRepo.get('EUR_USD', 'M1', year);
const raw = (h, year) => h.storage.objects.get(key(year))?.buf;
const callDates = (h) => h.oanda.calls.map((c) => c.date);

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

describe('building and reusing yearly datasets', () => {
  it('builds a missing completed year in full and stores ONE yearly .bin (no monthly files)', async () => {
    h = await createHarness({ withServer: false });
    const res = await ensure(h, 2025, '2025-12-31');
    assert.equal(res.reused, false);
    assert.equal(h.oanda.calls.length, 365);
    assert.deepEqual(h.storage.keys('oanda-data/'), ['oanda-data/EUR_USD/M1/2025.bin']);

    const m = await meta(h, 2025);
    assert.equal(m.status, 'COMPLETE');
    assert.equal(m.lastCompleteDate, '2025-12-31');
    assert.equal(m.firstCompleteDate, '2025-01-01');
    assert.equal(m.fileSize, raw(h, 2025).length);
    assert.ok(m.candleCount > 0 && m.sha256.length === 64);
  });

  it('reuses a valid completed year without contacting OANDA or rewriting the file', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2025, '2025-12-31');
    h.oanda.calls.length = 0;
    h.storage.ops.length = 0;
    const res = await ensure(h, 2025, '2025-12-31');
    assert.equal(res.reused, true);
    assert.equal(h.oanda.calls.length, 0);
    assert.ok(!h.storage.ops.some((o) => o.startsWith('put:') || o.startsWith('copy:')), 'completed year must stay immutable');
  });

  it('current year is COMPLETE_THROUGH_DAY and never contains the in-progress day', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-13');
    const m = await meta(h, 2026);
    assert.equal(m.status, 'COMPLETE_THROUGH_DAY');
    assert.equal(m.lastCompleteDate, '2026-09-13');
    assert.ok(!callDates(h).includes('2026-09-14'));
    assert.ok(m.lastTimestamp < Date.parse('2026-09-14T00:00:00Z') / 1000);
  });

  it('catches up exactly the missing complete days after downtime (Sep 10 -> Sep 13)', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    h.oanda.calls.length = 0;
    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.reused, false);
    assert.deepEqual(callDates(h), ['2026-09-11', '2026-09-12', '2026-09-13']);
    assert.equal((await meta(h, 2026)).lastCompleteDate, '2026-09-13');
  });

  it('does nothing when the dataset is already current', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-13');
    h.oanda.calls.length = 0;
    assert.equal((await ensure(h, 2026, '2026-09-13')).reused, true);
    assert.equal(h.oanda.calls.length, 0);
  });
});

describe('partial retrieval is saved, never lost, and never claims days that were not retrieved', () => {
  it('a failure mid catch-up saves everything retrieved before it, returns it as partial, and resumes later', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');

    h.oanda.failOn = (d) => (d === '2026-09-12' ? new Error('network down') : undefined);
    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.partial.stoppedBefore, '2026-09-12');
    assert.match(String(res.partial.error.message), /network down/);
    assert.equal(res.completeThrough, '2026-09-11');

    const after = await meta(h, 2026);
    assert.equal(after.lastCompleteDate, '2026-09-11', 'day 09-11 was retrieved, so it is saved; 09-12 is not claimed');
    assert.deepEqual(h.storage.keys().filter((k) => k.endsWith('.tmp')), [], 'no staging leftovers');
    assert.equal(await h.services.datasetService.getDayState('EUR_USD', 'M1', '2026-09-12'), DayState.FAILED);
    assert.equal(await h.services.datasetService.getDayState('EUR_USD', 'M1', '2026-09-11'), DayState.AVAILABLE);

    // the saved object verifies on its own and the next request resumes right after it
    h.oanda.failOn = null;
    h.oanda.calls.length = 0;
    const next = await ensure(h, 2026, '2026-09-13');
    assert.equal(next.partial, null);
    assert.deepEqual(callDates(h), ['2026-09-12', '2026-09-13']);
  });

  it('a failed first build still keeps the days that were retrieved before the failure', async () => {
    h = await createHarness({ withServer: false });
    h.oanda.failOn = (d) => (d === '2025-01-20' ? new Error('boom') : undefined);
    const res = await ensure(h, 2025, '2025-12-31');
    assert.equal(res.partial.stoppedBefore, '2025-01-20');
    assert.equal(res.completeThrough, '2025-01-19');
    assert.deepEqual(h.storage.keys('oanda-data/'), ['oanda-data/EUR_USD/M1/2025.bin']);
    assert.equal((await meta(h, 2025)).status, 'COMPLETE_THROUGH_DAY');
  });

  it('when not a single day could be retrieved the failure is thrown and nothing is stored', async () => {
    h = await createHarness({ withServer: false });
    h.oanda.failOn = (d) => (d === '2025-01-01' ? new Error('boom') : undefined);
    await assert.rejects(ensure(h, 2025, '2025-12-31'), /boom/);
    assert.deepEqual(h.storage.keys('oanda-data/'), []);
  });

  it('checkpoints and the partial save only claim what was retrieved; the next run resumes after it', async () => {
    h = await createHarness({ withServer: false });
    h.oanda.failOn = (d) => (d === '2025-03-15' ? new Error('outage') : undefined);
    const res = await ensure(h, 2025, '2025-12-31');
    assert.equal(res.completeThrough, '2025-03-14');
    const m = await meta(h, 2025);
    assert.equal(m.status, 'COMPLETE_THROUGH_DAY');
    assert.equal(m.lastCompleteDate, '2025-03-14');

    h.oanda.failOn = null;
    h.oanda.calls.length = 0;
    await ensure(h, 2025, '2025-12-31');
    assert.equal(callDates(h)[0], '2025-03-15');
    assert.equal((await meta(h, 2025)).status, 'COMPLETE');
  });

  it('an aborted job is still an abort (not a partial result)', async () => {
    h = await createHarness({ withServer: false });
    const ac = new AbortController();
    h.oanda.failOn = (d) => {
      if (d === '2025-01-05') ac.abort();
      return undefined;
    };
    await assert.rejects(ensure(h, 2025, '2025-12-31', { signal: ac.signal }));
  });

  it('atomic replacement: a failed promotion (copy) keeps the old object intact and removes the staging file', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    const before = Buffer.from(raw(h, 2026));
    h.storage.hooks.failOn = (op, k) => {
      if (op === 'copy' && k === key(2026)) throw new Error('copy failed');
    };
    await assert.rejects(ensure(h, 2026, '2026-09-13'), /copy failed/);
    h.storage.hooks.failOn = null;
    assert.ok(raw(h, 2026).equals(before));
    assert.equal((await meta(h, 2026)).lastCompleteDate, '2026-09-10');
    assert.deepEqual(h.storage.keys().filter((k) => k.endsWith('.tmp')), []);
  });

  it('an incomplete staged upload (size mismatch) is never promoted', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    const before = Buffer.from(raw(h, 2026));
    const realHead = h.storage.headObject;
    h.storage.headObject = async (k) => {
      const r = await realHead(k);
      return k.endsWith('.tmp') && r ? { ...r, size: r.size - 1 } : r;
    };
    await assert.rejects(ensure(h, 2026, '2026-09-13'), DatasetBuildError);
    assert.ok(raw(h, 2026).equals(before));
  });

  it('stops (partial) at a day the source reports as still incomplete, keeping everything before it', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    h.oanda.incompleteDays.add('2026-09-11');
    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.partial.stoppedBefore, '2026-09-11');
    assert.ok(res.partial.error instanceof DataNotReadyError);
    assert.equal((await meta(h, 2026)).lastCompleteDate, '2026-09-10');
  });

  it('accepts an empty day anywhere (providers have holes): it is stored as an empty day, not an error', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    h.oanda.emptyDays.add('2026-09-11'); // a Friday with zero candles
    h.oanda.emptyDays.add('2026-09-13'); // a Sunday with zero candles (the real EUR_TRY case)
    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.partial, null);
    assert.equal(res.completeThrough, '2026-09-13');
    assert.equal((await meta(h, 2026)).lastCompleteDate, '2026-09-13');
    const dayOf = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
    const lo = res.set.lowerBound(dayOf('2026-09-11'));
    const hi = res.set.lowerBound(dayOf('2026-09-12'));
    assert.equal(hi - lo, 0, 'no candles for the empty Friday');
  });

  it('stops (partial) at structurally invalid source data (bad OHLC) and never stores it', async () => {
    h = await createHarness({ withServer: false });
    h.oanda.badOhlcDays.add('2026-09-11');
    await ensure(h, 2026, '2026-09-10');
    const res = await ensure(h, 2026, '2026-09-13');
    assert.ok(res.partial.error instanceof DatasetBuildError);
    assert.equal(res.completeThrough, '2026-09-10');
  });
});

describe('corruption detection and recovery', () => {
  const corrupt = (h, year) => {
    const b = h.storage.objects.get(key(year));
    b.buf = Buffer.from(b.buf);
    b.buf[b.buf.length - 5] ^= 0xff;
  };

  it('detects corruption, quarantines the file, rebuilds and serves valid data', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-13');
    const good = Buffer.from(raw(h, 2026));
    corrupt(h, 2026);
    h.oanda.calls.length = 0;

    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.reused, false);
    assert.equal(h.oanda.calls.length, 256); // Jan 1 .. Sep 13, rebuilt from scratch
    assert.ok(raw(h, 2026).equals(good), 'rebuilt dataset is identical to the original');
    assert.equal(h.storage.keys('oanda-data/_quarantine/').length, 1);
    assert.equal((await meta(h, 2026)).status, 'COMPLETE_THROUGH_DAY');
  });

  it('a failed rebuild never serves the corrupted file; a later rebuild succeeds', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-13');
    corrupt(h, 2026);
    h.oanda.failOn = () => new Error('oanda unavailable');
    await assert.rejects(ensure(h, 2026, '2026-09-13'), /oanda unavailable/);
    assert.equal(raw(h, 2026), undefined, 'corrupted file removed from the live key');
    assert.equal((await meta(h, 2026)).status, 'CORRUPTED');

    h.oanda.failOn = null;
    await ensure(h, 2026, '2026-09-13');
    assert.equal((await meta(h, 2026)).status, 'COMPLETE_THROUGH_DAY');
  });

  it('treats a recorded-hash mismatch as corruption', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-13');
    await h.db.query("UPDATE datasets SET sha256 = 'deadbeef' WHERE id = $1", ['EUR_USD/M1/2026']);
    h.oanda.calls.length = 0;
    await ensure(h, 2026, '2026-09-13');
    assert.equal(h.oanda.calls.length, 256);
    assert.equal(h.storage.keys('oanda-data/_quarantine/').length, 1);
  });

  it('treats a file with the wrong instrument / timeframe / year as corrupt', async () => {
    h = await createHarness({ withServer: false });
    const other = await createHarness({ withServer: false });
    await other.services.datasetService.ensure({ instrument: 'GBP_USD', timeframe: 'M1', year: 2026, through: '2026-01-20' });
    h.storage.objects.set(key(2026), { buf: other.storage.objects.get(datasetKey('GBP_USD', 'M1', 2026)).buf, lastModified: 0 });
    await other.close();
    await ensure(h, 2026, '2026-01-20');
    assert.equal(h.storage.keys('oanda-data/_quarantine/').length, 1);
    assert.equal((await meta(h, 2026)).lastCompleteDate, '2026-01-20');
  });

  it('rebuilds when metadata exists but the object is gone', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-02-10');
    h.storage.objects.delete(key(2026));
    h.oanda.calls.length = 0;
    await ensure(h, 2026, '2026-02-10');
    assert.equal(h.oanda.calls.length, 41);
    assert.ok(raw(h, 2026));
  });
});

describe('metadata reconciliation', () => {
  it('adopts a fully verified object when the crash happened after the atomic copy but before the commit', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2026, '2026-09-10');
    const old = await meta(h, 2026);
    await ensure(h, 2026, '2026-09-13');
    const fresh = await meta(h, 2026);
    // Simulate the crash window: object is NEW, DB still says OLD, pending marker names the NEW hash.
    await h.db.query(
      'UPDATE datasets SET sha256 = $2, last_complete_date = $3, pending_sha256 = $4, pending_complete_date = $5 WHERE id = $1',
      ['EUR_USD/M1/2026', old.sha256, old.lastCompleteDate, fresh.sha256, '2026-09-13'],
    );
    h.oanda.calls.length = 0;
    const res = await ensure(h, 2026, '2026-09-13');
    assert.equal(res.reused, true);
    assert.equal(h.oanda.calls.length, 0);
    const healed = await meta(h, 2026);
    assert.equal(healed.sha256, fresh.sha256);
    assert.equal(healed.lastCompleteDate, '2026-09-13');
    assert.equal(healed.pendingSha256, null);
  });

  it('rebuilds metadata from a verified object after the database was lost (no re-download)', async () => {
    h = await createHarness({ withServer: false });
    await ensure(h, 2025, '2025-12-31');
    await h.db.query('DELETE FROM datasets');
    h.oanda.calls.length = 0;
    const res = await ensure(h, 2025, '2025-12-31');
    assert.equal(res.reused, true);
    assert.equal(h.oanda.calls.length, 0);
    assert.equal((await meta(h, 2025)).status, 'COMPLETE');
  });
});
