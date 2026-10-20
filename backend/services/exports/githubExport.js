// Offloads "read the verified datasets from R2, build the CSV, zip it" to a GitHub Actions run, then waits
// for the run to publish its artifact. The global job lock is held by the caller for the whole time, so the
// "one job at a time" rule still covers generation.

import { AppError, MESSAGES, SourceError } from '../../lib/errors.js';
import { sleep } from '../../lib/yield.js';
import { githubKey } from '../github/client.js';

export function createGithubExport({ github, client, logger, sleepFn = sleep }) {
  return {
    async generate({ exportId, instrument, timeframe, start, end, signal, onProgress }) {
      const artifactName = `${instrument}_${timeframe}_${start}_${end}`;
      const title = `export ${exportId}`;
      const deadline = Date.now() + github.runTimeoutSeconds * 1000;
      let runId = null;

      const stop = async (message, cancel = true) => {
        if (runId && cancel) await client.cancelRun(runId);
        throw new AppError('EXPORT_FAILED', message, 502);
      };

      try {
        onProgress?.({ stage: 'GENERATING', label: 'Asking GitHub to build your ZIP…' });
        await client.dispatch({ export_id: exportId, instrument, timeframe, start_date: start, end_date: end, artifact_name: artifactName });

        // The dispatch API does not return the run id: find our run by its unique run-name.
        let run = null;
        const findDeadline = Date.now() + github.startTimeoutSeconds * 1000;
        while (!run && Date.now() < findDeadline) {
          signal?.throwIfAborted();
          await sleepFn(github.pollMs, signal);
          run = await client.findRun(title);
        }
        if (!run) return await stop('The file builder did not start. Please try again later.', false);
        runId = run.id;

        for (;;) {
          signal?.throwIfAborted();
          const r = await client.getRun(runId);
          if (r.status === 'completed') {
            if (r.conclusion !== 'success') return await stop('The file could not be built. Please try again later.', false);
            break;
          }
          onProgress?.({
            stage: 'GENERATING',
            label: r.status === 'queued' || r.status === 'waiting' || r.status === 'pending' ? 'Waiting for GitHub to start…' : 'Building and zipping your CSV on GitHub…',
          });
          if (Date.now() > deadline) return await stop('Building the file took too long. Please try again later.');
          await sleepFn(github.pollMs, signal);
        }

        const artifacts = await client.listRunArtifacts(runId);
        const art = artifacts.find((a) => a.name === artifactName && !a.expired);
        if (!art) return await stop('The file was built but could not be found. Please try again later.', false);
        return { runId, artifactId: art.id, size: art.size, objectKey: githubKey(runId, art.id) };
      } catch (err) {
        if (runId && !(err instanceof AppError)) await client.cancelRun(runId).catch(() => {});
        // A failed run is deliberately kept in the Actions history so its logs can be read.
        if (err instanceof AppError) throw err;
        if (err instanceof SourceError) {
          logger.error('GitHub export failed', { error: err });
          throw new AppError('EXPORT_FAILED', MESSAGES.datasetFailure, 502);
        }
        throw err;
      }
    },
  };
}
