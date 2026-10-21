// Export pipeline: validate -> take global lock (or SYSTEM BUSY) -> ensure yearly datasets ->
// filter inclusive UTC days -> stream CSV to R2 -> issue download authorization -> release lock.
// The lock is released as soon as the CSV is stored; downloading never holds it.

import { csvChunks } from '../../lib/csv.js';
import { csvOptionsFor } from '../../lib/exportFile.js';
import { zipFiles } from '../../lib/zip.js';
import { getInstrument, getTimeframe } from '../../config/catalog.js';
import { buildGapReport } from '../../lib/gaps.js';
import {
  AbortedError,
  AppError,
  DataNotReadyError,
  Errors,
  MESSAGES,
} from '../../lib/errors.js';
import { deriveDownloadToken, newExportId, newJobId, sha256Hex, TOKEN_RE } from '../../lib/tokens.js';
import { addDays, dayStartSec, latestFetchableDay, utcDateOf, yearEndDate, yearOf, yearStartDate, yearsInRange } from '../../lib/time.js';
import { validateExportRequest } from '../../lib/validation.js';
import { ExportStatus } from '../../database/exportsRepo.js';
import { exportKey } from '../r2/keys.js';

export function createExportService({ exportsRepo, datasetService, storage, runner, config, logger, clock, githubExport = null }) {
  const inflight = new Set();

  function mapError(err, handle) {
    if (err instanceof AppError) return { code: err.code, message: err.message };
    if (err instanceof DataNotReadyError) return { code: 'DATA_NOT_AVAILABLE_YET', message: MESSAGES.notVerified };
    if (err instanceof AbortedError || err?.name === 'AbortError' || handle.signal.aborted) {
      return { code: 'JOB_INTERRUPTED', message: MESSAGES.interrupted };
    }
    return { code: 'DATASET_FAILURE', message: MESSAGES.datasetFailure };
  }

  async function runJob(handle, job) {
    const { jobId, exportId, instrument, timeframe, start, end } = job;
    let objectKey = null;
    let ghKey = null;
    let lastProgressWrite = 0;
    const onProgress = (p) => {
      const now = Date.now();
      if (now - lastProgressWrite < 1500) return; // do not hammer the database
      lastProgressWrite = now;
      exportsRepo.updateProgress(jobId, p).catch(() => {});
    };

    try {
      const nowYear = yearOf(utcDateOf(clock()));
      const years = yearsInRange(start, end);
      const loaded = [];
      for (const [idx, year] of years.entries()) {
        handle.signal.throwIfAborted();
        await exportsRepo.updateProgress(jobId, {
          stage: 'DATASETS',
          current: idx,
          total: years.length,
          label: `Preparing ${year} data`,
        });
        // Every request works on WHOLE years: a completed year is downloaded in full (if not stored yet) and the
        // user's range is cut out of it. The current year is downloaded through the last completed (and settled)
        // day, never beyond, so a still-open candle is never fetched.
        const lastFetchable = latestFetchableDay(clock(), config.daySettleMinutes);
        const through = year < nowYear ? yearEndDate(year) : lastFetchable < yearEndDate(year) ? lastFetchable : yearEndDate(year);
        const res = await datasetService.ensure({ instrument, timeframe, year, through, signal: handle.signal, onProgress });
        loaded.push({ year, set: res.set, skipped: [...(await datasetService.loadSkipped(instrument, timeframe, year)).values()] });
      }

      handle.signal.throwIfAborted();
      await exportsRepo.setGenerating(jobId);

      const segments = [];
      let rows = 0;
      for (const { year, set } of loaded) {
        const from = start > yearStartDate(year) ? start : yearStartDate(year);
        const to = end < yearEndDate(year) ? end : yearEndDate(year);
        const i0 = set.lowerBound(dayStartSec(from));
        const i1 = set.lowerBound(dayStartSec(addDays(to, 1))); // inclusive end date
        segments.push({ set, from: i0, to: i1 });
        rows += i1 - i0;
      }

      if (rows === 0) throw Errors.noData(); // e.g. a pair that was not listed yet, or a range the provider has no candles for

      let fileSize;
      if (config.exportMode === 'github' && githubExport) {
        // Production: GitHub Actions reads the datasets from R2, builds and zips the CSV, and the user
        // downloads it from GitHub (the download link redirects there). Nothing is streamed by this server.
        loaded.length = 0; // free the in-memory datasets while GitHub works
        segments.length = 0;
        const art = await githubExport.generate({
          exportId,
          instrument,
          timeframe,
          start,
          end,
          signal: handle.signal,
          onProgress: (p) => exportsRepo.updateProgress(jobId, p).catch(() => {}),
        });
        objectKey = null; // nothing to clean up in R2
        ghKey = art.objectKey;
        fileSize = art.size;
      } else {
        // Local/development mode: the server builds the ZIP into R2 and streams it itself.
        objectKey = exportKey(exportId);
        const inst = getInstrument(instrument);
        const base = `${instrument}_${timeframe}_${start}_${end}`;
        const report = await buildGapReport({
          skipped: loaded.flatMap((l) => l.skipped),
          segments,
          start,
          end,
          stepSeconds: getTimeframe(timeframe).seconds,
          calendar: inst.calendar,
          extraClosedDates: config.extraClosedDates,
          instrumentLabel: inst.label,
          instrument,
          timeframe,
          nowMs: clock(),
        });
        const entries = [{ name: `${base}.csv`, source: csvChunks(segments, csvOptionsFor(inst)) }];
        if (report) entries.push({ name: `${base}_missing_data.txt`, source: [Buffer.from(report.text, 'utf8')] });
        await storage.putChunks(objectKey, zipFiles(entries, clock()), { contentType: 'application/zip' });
        handle.signal.throwIfAborted();
        const head = await storage.headObject(objectKey);
        if (!head) throw new Error('stored ZIP not found');
        fileSize = head.size;
      }
      handle.signal.throwIfAborted();

      const createdAt = clock();
      const expiresAt = createdAt + config.exportExpirationMinutes * 60_000;
      const token = deriveDownloadToken(config.exportTokenSecret, exportId);
      const ok = await exportsRepo.markReady(jobId, {
        objectKey: ghKey ?? objectKey,
        fileSize,
        rowCount: rows,
        tokenHash: sha256Hex(token),
        createdAt,
        expiresAt,
      });
      if (!ok) throw new AbortedError('job was no longer active');
      logger.info('export ready', { jobId, rows, bytes: fileSize, mode: ghKey ? 'github' : 'server', expiresAt: new Date(expiresAt).toISOString() });
    } catch (err) {
      const mapped = mapError(err, handle);
      logger.error('export failed', { jobId, code: mapped.code, error: err });
      if (objectKey) await storage.deleteObject(objectKey).catch(() => {}); // never leave a partial CSV behind
      await exportsRepo.markFailed(jobId, mapped).catch((e) => logger.error('could not mark export failed', { jobId, error: e }));
    } finally {
      await handle.finish(); // lock released only AFTER the row reached READY/FAILED
    }
  }

  function view(row) {
    const now = clock();
    let status = row.status;
    let error = null;
    if (status === ExportStatus.READY && row.expiresAt <= now) status = ExportStatus.EXPIRED; // server is authoritative
    if (status === ExportStatus.EXPIRED) error = { code: 'EXPORT_EXPIRED', message: MESSAGES.expired };
    if (status === ExportStatus.FAILED) error = { code: row.errorCode, message: row.errorMessage };

    let download = null;
    if (status === ExportStatus.READY) {
      const token = deriveDownloadToken(config.exportTokenSecret, row.exportId);
      download = {
        url: `/api/export/download/${token}`,
        expiresAt: new Date(row.expiresAt).toISOString(),
        expiresInSeconds: Math.max(0, Math.ceil((row.expiresAt - now) / 1000)),
        fileSize: row.fileSize,
        rows: row.rowCount,
        filename: `${row.instrument}_${row.timeframe}_${row.startDate}_${row.endDate}.zip`,
      };
    }
    return {
      jobId: row.jobId,
      status,
      stage: row.stage,
      progress: row.progressTotal ? { current: row.progressCurrent, total: row.progressTotal, label: row.progressLabel } : null,
      request: { instrument: row.instrument, timeframe: row.timeframe, startDate: row.startDate, endDate: row.endDate },
      error,
      download,
      serverTime: new Date(now).toISOString(),
    };
  }

  return {
    /** Validate, take the global lock (never queue), start the job in the background. */
    async createExport({ sessionHash, body }) {
      const params = validateExportRequest(body, clock(), config);
      const jobId = newJobId();
      const exportId = newExportId();

      const handle = await runner.tryStart('export', jobId);
      if (!handle) throw Errors.busy();
      try {
        await exportsRepo.create({
          jobId,
          exportId,
          sessionHash,
          instrument: params.instrument,
          timeframe: params.timeframe,
          startDate: params.start,
          endDate: params.end,
        });
      } catch (err) {
        await handle.finish();
        throw err;
      }

      const task = runJob(handle, { jobId, exportId, ...params }).catch((err) =>
        logger.error('unexpected job error', { jobId, error: err }),
      );
      inflight.add(task);
      task.finally(() => inflight.delete(task));
      return { jobId, status: ExportStatus.PROCESSING };
    },

    /** Resolves when no export job is running (used by tests and graceful shutdown). */
    async whenIdle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    async getStatus(jobId, sessionHash) {
      const row = await exportsRepo.get(jobId);
      if (!row || row.sessionHash !== sessionHash) throw Errors.notFound(); // never reveal other sessions' jobs
      return view(row);
    },

    /** Recover the browser's latest job after a refresh. */
    async getActive(sessionHash) {
      const row = await exportsRepo.latestForSession(sessionHash);
      if (!row) return { active: null, serverTime: new Date(clock()).toISOString() };
      const v = view(row);
      const age = clock() - (row.updatedAt ?? row.requestedAt);
      const keep =
        v.status === ExportStatus.PROCESSING ||
        v.status === ExportStatus.GENERATING ||
        v.status === ExportStatus.READY ||
        (v.status === ExportStatus.EXPIRED && age < 30 * 60_000) ||
        (v.status === ExportStatus.FAILED && age < 10 * 60_000);
      return { active: keep ? v : null, serverTime: v.serverTime };
    },

    /** Token -> export row, or throws. Expiry is enforced here, not by R2. */
    async authorizeDownload(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw Errors.notFound();
      const row = await exportsRepo.getByTokenHash(sha256Hex(token));
      if (!row) throw Errors.notFound();
      if (row.status !== ExportStatus.READY || row.expiresAt <= clock()) throw Errors.expired();
      return row;
    },
  };
}
