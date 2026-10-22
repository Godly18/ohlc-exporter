// Runs the heavy work on GitHub Actions so the web server's outbound bandwidth is not spent on it:
//   generate()        : provider download (retrieval) + CSV build + artifact, for one user export
//   runMaintenance()  : the hourly catch-up of existing datasets
// The web server only dispatches the run, keeps the global lock while it runs, mirrors its status, and can cancel it.

import { AppError, MESSAGES, SourceError } from '../../lib/errors.js';
import { sleep } from '../../lib/yield.js';
import { githubKey } from '../github/client.js';
import { resultToError } from '../../workers/remoteJob.js';
import { exportResultKey } from '../r2/keys.js';

export function createGithubExport({ github, client, storage, logger, sleepFn = sleep }) {
  /**
   * Dispatch a run and wait until it completes. Cancels the run when the caller aborts or the time runs out.
   * @returns {{runId:number, conclusion:string}}
   */
  async function runWorkflow({ exportId, inputs, signal, onStatus, timeoutSeconds }) {
    const title = `export ${exportId}`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let runId = null;
    const fail = async (message, cancel = true) => {
      if (runId && cancel) await client.cancelRun(runId);
      throw new AppError('EXPORT_FAILED', message, 502);
    };
    try {
      onStatus?.('dispatch');
      await client.dispatch({ export_id: exportId, ...inputs });

      // The dispatch API does not return the run id: find our run by its unique run-name.
      let run = null;
      const findDeadline = Date.now() + github.startTimeoutSeconds * 1000;
      while (!run && Date.now() < findDeadline) {
        signal?.throwIfAborted();
        await sleepFn(github.pollMs, signal);
        run = await client.findRun(title);
      }
      if (!run) return await fail('The file builder did not start. Please try again later.', false);
      runId = run.id;

      for (;;) {
        signal?.throwIfAborted();
        const r = await client.getRun(runId);
        if (r.status === 'completed') return { runId, conclusion: r.conclusion };
        onStatus?.(r.status === 'queued' || r.status === 'waiting' || r.status === 'pending' ? 'queued' : 'running');
        if (Date.now() > deadline) return await fail('Building the file took too long. Please try again later.');
        await sleepFn(github.pollMs, signal);
      }
    } catch (err) {
      // aborted by the user / shutdown / lock loss: stop the run so nothing keeps working in the background
      if (runId && !(err instanceof AppError)) await client.cancelRun(runId).catch(() => {});
      if (err instanceof AppError) throw err;
      if (err instanceof SourceError) {
        logger.error('GitHub run failed', { error: err });
        throw new AppError('EXPORT_FAILED', MESSAGES.datasetFailure, 502);
      }
      throw err;
    }
  }

  async function readResult(exportId) {
    const key = exportResultKey(exportId);
    try {
      const buf = await storage.getObjectBuffer(key);
      return buf ? JSON.parse(buf.toString('utf8')) : null;
    } catch {
      return null;
    } finally {
      await storage.deleteObject(key).catch(() => {});
    }
  }

  return {
    runWorkflow,

    /** Retrieve data (if needed), build the CSV and publish the artifact, all on GitHub. */
    async generate({ exportId, jobId, instrument, timeframe, start, end, lastDay, signal, onStatus }) {
      const artifactName = `${instrument}_${timeframe}_${start}_${end}`;
      const { runId, conclusion } = await runWorkflow({
        exportId,
        signal,
        onStatus,
        timeoutSeconds: github.runTimeoutSeconds,
        inputs: { mode: 'export', job_id: jobId, instrument, timeframe, start_date: start, end_date: end, last_day: lastDay, artifact_name: artifactName },
      });
      const result = await readResult(exportId); // the workflow says why it failed (no data / not ready / provider failure)
      if (result && result.ok === false) throw resultToError(result);
      if (conclusion !== 'success' || !result?.ok) {
        // the run died without reporting (crash, timeout inside GitHub, cancelled from the GitHub UI)
        logger.error('GitHub run ended without a result', { runId, conclusion });
        throw new AppError('EXPORT_FAILED', MESSAGES.datasetFailure, 502);
      }
      const artifacts = await client.listRunArtifacts(runId);
      const art = artifacts.find((a) => a.name === artifactName && !a.expired);
      if (!art) throw new AppError('EXPORT_FAILED', 'The file was built but could not be found. Please try again later.', 502);
      return { runId, artifactId: art.id, size: art.size, rows: result.rows, objectKey: githubKey(runId, art.id) };
    },

    /** Hourly dataset catch-up on GitHub. Throws on failure; the next cycle retries. */
    async runMaintenance({ exportId, signal }) {
      const { runId, conclusion } = await runWorkflow({ exportId, signal, timeoutSeconds: github.runTimeoutSeconds, inputs: { mode: 'maintenance' } });
      if (conclusion !== 'success') throw new AppError('EXPORT_FAILED', 'maintenance run did not succeed', 502);
      await client.deleteRun(runId).catch(() => {}); // keep the Actions history tidy; failed runs are kept for their logs
    },
  };
}

