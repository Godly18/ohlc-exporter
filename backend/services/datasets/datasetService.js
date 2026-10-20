// Yearly dataset lifecycle: verify -> catch up missing COMPLETE UTC days -> stage -> validate ->
// atomically promote. Callers must hold the global lock; this service never takes it itself.
//
// Guarantees:
//  * An incomplete / failed download can never become the permanent <year>.bin.
//  * The previous known-good object stays untouched until the replacement is validated and
//    promoted with a single server-side copy (atomic object replacement).
//  * Every load re-verifies header identity, body SHA-256, ordering, duplicates and OHLC rules.
//  * Coverage (`last_complete_date`) never claims a day that was not downloaded and verified.

import { CandleSet } from '../../lib/candles.js';
import { decodeDataset, encodeDataset, sha256Async } from '../../lib/binformat.js';
import { DataNotReadyError, DatasetBuildError, FormatError } from '../../lib/errors.js';
import {
  addDays,
  computeDayState,
  daysInclusive,
  isMarketClosedDay,
  yearEndDate,
  yearStartDate,
} from '../../lib/time.js';
import { limitsFor, validateCandleSet, validateDayCandles } from '../../lib/validation.js';
import { getInstrument, getTimeframe } from '../../config/catalog.js';
import { Activity, DatasetStatus } from '../../database/datasetsRepo.js';
import { datasetKey, datasetQuarantineKey, datasetTmpKey } from '../r2/keys.js';

export function createDatasetService({ repo, storage, source, config, logger, clock }) {
  const stepOf = (timeframe) => getTimeframe(timeframe).seconds;

  /** Decode + fully validate a dataset file. Throws FormatError when it is not trustworthy. */
  async function verifyBuffer(buf, identity) {
    const inst = getInstrument(identity.instrument);
    const expected = inst ? { ...identity, priceScale: inst.priceScale, volumeScale: inst.volumeScale } : identity;
    const { header, set } = await decodeDataset(buf, expected);
    if (!header.completeThrough) throw new FormatError('no coverage recorded');
    const reason = await validateCandleSet(set, {
      year: identity.year,
      stepSeconds: stepOf(identity.timeframe),
      completeThrough: header.completeThrough,
    });
    if (reason) throw new FormatError(reason);
    return { header, set };
  }

  const metaFromFile = (identity, header, set, sha, size) => ({
    ...identity,
    status: header.completeThrough === yearEndDate(identity.year) ? DatasetStatus.COMPLETE : DatasetStatus.COMPLETE_THROUGH_DAY,
    objectKey: datasetKey(identity.instrument, identity.timeframe, identity.year),
    fileSize: size,
    candleCount: set.length,
    firstTimestamp: set.firstTs,
    lastTimestamp: set.lastTs,
    firstCompleteDate: yearStartDate(identity.year),
    lastCompleteDate: header.completeThrough,
    sha256: sha,
  });

  /**
   * Load the stored object for an identity and decide whether it can be trusted.
   * @returns {{state:'absent'} | {state:'corrupt', reason} | {state:'ok', set, header, adopted}}
   */
  async function loadExisting(identity, meta) {
    const key = datasetKey(identity.instrument, identity.timeframe, identity.year);
    const buf = await storage.getObjectBuffer(key);
    if (!buf) return { state: 'absent' };

    if (meta?.status === DatasetStatus.CORRUPTED) return { state: 'corrupt', reason: 'previously marked corrupted' };

    let decoded;
    try {
      decoded = await verifyBuffer(buf, identity);
    } catch (err) {
      if (err instanceof FormatError) return { state: 'corrupt', reason: err.message };
      throw err;
    }

    const sha = await sha256Async(buf);
    let adopted = false;
    if (meta?.sha256) {
      if (meta.sha256 !== sha) {
        // A crash between "copy to final key" and "commit metadata" leaves a valid NEW object whose
        // hash equals the pending marker we wrote beforehand. Anything else is a real mismatch.
        if (meta.pendingSha256 !== sha) return { state: 'corrupt', reason: 'sha256 does not match recorded hash' };
        adopted = true;
      }
    } else {
      adopted = true; // fully self-validated object without committed metadata (e.g. database was reset)
    }

    if (adopted) {
      logger.warn('reconciling dataset metadata from a fully verified object', { id: `${identity.instrument}/${identity.timeframe}/${identity.year}` });
      await repo.upsertComplete(metaFromFile(identity, decoded.header, decoded.set, sha, buf.length));
    }
    return { state: 'ok', set: decoded.set, header: decoded.header, adopted };
  }

  async function quarantine(identity, reason) {
    const key = datasetKey(identity.instrument, identity.timeframe, identity.year);
    const qKey = datasetQuarantineKey(identity.instrument, identity.timeframe, identity.year, clock());
    logger.error('dataset failed verification; quarantining', { key, reason });
    try {
      await storage.copyObject(key, qKey);
    } catch (err) {
      logger.warn('could not copy corrupted dataset to quarantine', { key, error: err });
    }
    await storage.deleteObject(key);
    await repo.markCorrupted(identity.instrument, identity.timeframe, identity.year);
  }

  /** Validate -> stage (.tmp) -> verify staged size -> atomic copy to final key -> commit metadata. */
  async function promote(identity, set, completeThrough, signal) {
    const { instrument, timeframe, year } = identity;
    const key = datasetKey(instrument, timeframe, year);
    const tmpKey = datasetTmpKey(instrument, timeframe, year);

    await repo.setActivity(instrument, timeframe, year, Activity.VERIFYING);
    await repo.setDay(instrument, timeframe, completeThrough, 'VERIFYING');

    const buf = await encodeDataset(set, { ...identity, completeThrough });
    const { header } = await verifyBuffer(buf, identity); // what we are about to store must itself verify
    const sha = await sha256Async(buf);

    // Recovery marker: if we crash after the copy but before the commit, the next load recognises it.
    await repo.setPending(instrument, timeframe, year, { sha256: sha, completeThrough });
    try {
      await storage.putObject(tmpKey, buf, { contentType: 'application/octet-stream' });
      const head = await storage.headObject(tmpKey);
      if (!head || head.size !== buf.length) throw new DatasetBuildError('staged dataset size mismatch');
      signal?.throwIfAborted(); // last chance to stop before the old dataset is replaced
      await storage.copyObject(tmpKey, key);
    } catch (err) {
      await storage.deleteObject(tmpKey).catch(() => {});
      throw err;
    }
    await storage.deleteObject(tmpKey).catch((err) => logger.warn('could not delete staging object', { tmpKey, error: err }));

    await repo.upsertComplete(metaFromFile(identity, header, set, sha, buf.length));
    await repo.clearDays(instrument, timeframe, yearStartDate(year), completeThrough);
    logger.info('dataset promoted', {
      id: `${instrument}/${timeframe}/${year}`,
      completeThrough,
      candles: set.length,
      bytes: buf.length,
    });
  }

  /**
   * One complete, validated UTC day from the instrument's provider.
   * Empty days: 'fx' calendars (forex, gold) may be empty only when the market is closed; 'always'
   * calendars (crypto) may be empty only BEFORE the pair's first candle (not yet listed). Anything else
   * means the source does not have the day yet, so the build stops rather than leaving a silent gap.
   */
  async function fetchValidatedDay(identity, day, signal, { lastDay, haveCandles }) {
    const inst = getInstrument(identity.instrument);
    const { candles, incompleteCount } = await source.fetchDayCandles({
      instrument: identity.instrument,
      timeframe: identity.timeframe,
      date: day,
      lastDay,
      signal,
    });
    if (incompleteCount > 0) throw new DataNotReadyError(`source still reports incomplete candles for ${day}`, day);
    if (candles.length === 0) {
      const legitimate = inst?.calendar === 'always' ? !haveCandles : isMarketClosedDay(day, config.extraClosedDates);
      if (legitimate) return candles;
      throw new DataNotReadyError(`source returned no candles for trading day ${day}`, day);
    }
    const reason = validateDayCandles(candles, day, stepOf(identity.timeframe), limitsFor(inst));
    if (reason) throw new DatasetBuildError(`invalid data for ${day}: ${reason}`);
    return candles;
  }

  return {
    verifyBuffer,

    /** Cheap metadata-only look (no object download). */
    peek: (instrument, timeframe, year) => repo.get(instrument, timeframe, year),

    /**
     * Make sure the yearly dataset covers every complete UTC day up to `through`, then return it.
     * Reuses valid data; downloads only the missing days; rebuilds if corrupted.
     * @returns {Promise<{set: CandleSet, completeThrough: string, reused: boolean}>}
     */
    async ensure({ instrument, timeframe, year, through, signal, onProgress }) {
      const identity = { instrument, timeframe, year };
      const yearStart = yearStartDate(year);
      const target = through > yearEndDate(year) ? yearEndDate(year) : through;
      if (target < yearStart) throw new DatasetBuildError('target precedes the dataset year');
      const id = `${instrument}/${timeframe}/${year}`;

      const meta = await repo.get(instrument, timeframe, year);
      const loaded = await loadExisting(identity, meta);

      let set = null;
      let completeThrough = null;
      if (loaded.state === 'ok') {
        set = loaded.set;
        completeThrough = loaded.header.completeThrough;
        logger.info('dataset discovered', { id, completeThrough });
      } else if (loaded.state === 'corrupt') {
        await quarantine(identity, loaded.reason);
      } else if (meta?.sha256) {
        logger.error('dataset object is missing although metadata exists; rebuilding', { id });
        await repo.markCorrupted(instrument, timeframe, year);
      }

      if (completeThrough && completeThrough >= target) {
        return { set, completeThrough, reused: true };
      }

      // ---- catch up: every missing complete day, in order -----------------------------------
      const from = completeThrough ? addDays(completeThrough, 1) : yearStart;
      const total = daysInclusive(from, target);
      logger.info('missing complete days detected', { id, from, to: target, days: total, rebuild: !completeThrough });

      const working = set ?? new CandleSet(1 << 16);
      let lastPromoted = completeThrough;
      let lastGood = completeThrough;
      let sinceCheckpoint = 0;
      let done = 0;

      await repo.setActivity(instrument, timeframe, year, Activity.DOWNLOADING);
      let day = from;
      try {
        for (; day <= target; day = addDays(day, 1)) {
          signal?.throwIfAborted();
          await repo.setDay(instrument, timeframe, day, 'DOWNLOADING');
          const candles = await fetchValidatedDay(identity, day, signal, { lastDay: target, haveCandles: working.length > 0 });
          working.pushAll(candles);
          lastGood = day;
          done++;
          sinceCheckpoint++;
          onProgress?.({ stage: 'DOWNLOADING', current: done, total, label: `${year}: downloaded ${day}` });

          // Periodic checkpoint: a fully validated, contiguous dataset promoted atomically. It only
          // ever claims coverage through `day`, so a later failure cannot make it look complete.
          if (sinceCheckpoint >= config.checkpointDays && day < target) {
            await promote(identity, working, lastGood, signal);
            lastPromoted = lastGood;
            sinceCheckpoint = 0;
          }
        }
        await promote(identity, working, target, signal);
        lastPromoted = target;
      } catch (err) {
        // Days downloaded in memory but never promoted are simply "missing" again; only the day that
        // actually failed is marked FAILED.
        await repo.clearDays(instrument, timeframe, from, day <= target ? day : target).catch(() => {});
        if (!signal?.aborted && day <= target) {
          await repo.setDay(instrument, timeframe, day, 'FAILED', String(err?.message ?? err).slice(0, 200)).catch(() => {});
        }
        logger.error('dataset update failed; previous known-good dataset preserved', {
          id,
          failedDay: day,
          preservedThrough: lastPromoted,
          error: err,
        });
        throw err;
      } finally {
        await repo.setActivity(instrument, timeframe, year, Activity.IDLE).catch(() => {});
      }
      return { set: working, completeThrough: target, reused: false };
    },

    /** Day availability state (DAY_NOT_COMPLETE / MISSING / DOWNLOADING / VERIFYING / AVAILABLE / FAILED). */
    async getDayState(instrument, timeframe, date) {
      const year = Number(date.slice(0, 4));
      const meta = await repo.get(instrument, timeframe, year);
      const covered = meta && [DatasetStatus.COMPLETE, DatasetStatus.COMPLETE_THROUGH_DAY].includes(meta.status) ? meta.lastCompleteDate : null;
      const transient = await repo.getDay(instrument, timeframe, date);
      return computeDayState({
        date,
        nowMs: clock(),
        settleMinutes: config.daySettleMinutes,
        completeThrough: covered,
        transient,
      });
    },
  };
}
