// The work that runs INSIDE the GitHub Actions workflow (scripts/workflow-job.js) so that provider downloads
// never use the web server's outbound bandwidth:
//   runRemoteExport      : retrieve/verify the yearly datasets (OANDA / Binance / Twelve Data -> R2), then build the
//                          CSV (+ missing-data report) from R2 and leave it in `outDir` for the artifact upload.
//   runRemoteMaintenance : the hourly catch-up of existing datasets.
// The web server only holds the global lock, dispatches the run, mirrors its progress (the workflow writes progress
// straight to the same database) and hands the finished artifact to the user. Result of an export is reported
// through a tiny JSON object in R2 (exports/<id>.json) so the server can show rows / the right error message.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describeError, Errors } from '../lib/errors.js';
import { ExportFileError, writeExportCsv } from '../lib/exportFile.js';
import { yearEndDate, yearsInRange } from '../lib/time.js';
import { exportResultKey } from '../services/r2/keys.js';

const ALLOWED_CODES = new Set(['NO_DATA', 'DATA_NOT_AVAILABLE_YET', 'DATASET_FAILURE', 'JOB_INTERRUPTED']);

/** What the server will accept from the workflow's result file (never trusts free text). */
export function resultToError(result) {
  if (result?.code === 'NO_DATA') return Errors.noData();
  if (result?.code === 'DATA_NOT_AVAILABLE_YET') return Errors.notVerified();
  if (result?.code === 'JOB_INTERRUPTED') return Errors.interrupted();
  return Errors.datasetFailure();
}

export async function runRemoteExport({ job, datasetService, exportsRepo, storage, config, logger, signal, outDir }) {
  const { jobId, exportId, instrument, timeframe, start, end, lastDay, artifactName } = job;
  const publish = (result) => storage.putObject(exportResultKey(exportId), Buffer.from(JSON.stringify(result)), { contentType: 'application/json' });

  let lastProgressWrite = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (now - lastProgressWrite < 1500) return; // do not hammer the database
    lastProgressWrite = now;
    exportsRepo.updateProgress(jobId, p).catch(() => {});
  };

  try {
    const years = yearsInRange(start, end);
    for (const [idx, year] of years.entries()) {
      signal?.throwIfAborted();
      await exportsRepo.updateProgress(jobId, { stage: 'DATASETS', current: idx, total: years.length, label: `Preparing ${year} data` });
      // Whole years: completed years in full, the current year through the last completed day.
      const yearEnd = yearEndDate(year);
      const through = lastDay < yearEnd ? lastDay : yearEnd;
      await datasetService.ensure({ instrument, timeframe, year, through, signal, onProgress });
    }

    signal?.throwIfAborted();
    await exportsRepo.setGenerating(jobId);
    await exportsRepo.updateProgress(jobId, { stage: 'GENERATING', label: 'Generating your CSV…' });
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${artifactName}.csv`);
    const reportFile = path.join(outDir, `${artifactName}_missing_data.txt`); // only written when data is missing
    const { rows, bytes, notes, reported } = await writeExportCsv({
      storage,
      instrument,
      timeframe,
      start,
      end,
      outFile,
      reportFile,
      extraClosedDates: config.extraClosedDates,
    });
    for (const n of notes) logger.warn('export note', { note: n });
    const result = { ok: true, rows, bytes, reported };
    await publish(result);
    logger.info('remote export built', { jobId, instrument, timeframe, rows, bytes, reported });
    return result;
  } catch (err) {
    let mapped;
    if (err instanceof ExportFileError && /no candles/.test(err.message)) mapped = { code: 'NO_DATA' };
    else mapped = describeError(err, { aborted: signal?.aborted });
    const code = ALLOWED_CODES.has(mapped.code) ? mapped.code : 'DATASET_FAILURE';
    logger.error('remote export failed', { jobId, code, error: err });
    const result = { ok: false, code };
    await publish(result).catch((e) => logger.error('could not publish the failure result', { error: e }));
    return result;
  }
}

export async function runRemoteMaintenance({ maintenance, signal, logger }) {
  logger.info('remote maintenance started');
  await maintenance.runAll({ signal });
  logger.info('remote maintenance finished');
  return { ok: true };
}

