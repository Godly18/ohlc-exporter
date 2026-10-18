// Holds the global lock for the duration of one job: renews the lease with a heartbeat and exposes
// an AbortSignal that fires if the lock is lost (so two workers can never both keep going) or the
// process is shutting down.

import { AbortedError } from '../../lib/errors.js';

export function createJobRunner({ lock, logger, heartbeatMs, leaseMs, clock }) {
  const running = new Map(); // jobId -> handle

  return {
    isBusyLocally: () => running.size > 0,

    /**
     * Try to take the global lock. Returns a handle ({ jobId, signal, finish() }) or null when
     * another job holds it. NEVER waits.
     */
    async tryStart(kind, jobId) {
      const acquired = await lock.acquire(jobId, kind);
      if (!acquired) return null;

      logger.info('job lock acquired', { jobId, kind });
      const controller = new AbortController();
      let lastOk = clock();
      let finished = false;

      const timer = setInterval(async () => {
        if (finished) return;
        try {
          const stillOwner = await lock.heartbeat(jobId);
          if (stillOwner) {
            lastOk = clock();
          } else if (!controller.signal.aborted) {
            logger.error('job lock lost; aborting job', { jobId, kind });
            controller.abort(new AbortedError('lock lost'));
          }
        } catch (err) {
          logger.warn('heartbeat failed', { jobId, error: err });
          // If we cannot renew for a full lease, someone else may legitimately have taken over.
          if (clock() - lastOk >= leaseMs && !controller.signal.aborted) {
            controller.abort(new AbortedError('lease expired while heartbeats were failing'));
          }
        }
      }, heartbeatMs);

      const handle = {
        jobId,
        kind,
        signal: controller.signal,
        abort: (reason = 'aborted') => controller.abort(new AbortedError(reason)),
        async finish() {
          if (finished) return;
          finished = true;
          clearInterval(timer);
          running.delete(jobId);
          try {
            await lock.release(jobId);
            logger.info('job lock released', { jobId, kind });
          } catch (err) {
            // Not fatal: the lease expires on its own if the release could not be written.
            logger.error('failed to release job lock (lease will expire)', { jobId, error: err });
          }
        },
      };
      running.set(jobId, handle);
      return handle;
    },

    abortAll(reason) {
      for (const h of running.values()) h.abort(reason);
    },

    activeJobIds: () => [...running.keys()],
  };
}
