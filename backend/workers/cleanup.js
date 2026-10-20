// Export cleanup + crash recovery.
//  - runExpiredCleanup(): physically deletes expired CSVs (expires_at <= now) and marks them EXPIRED.
//  - reconcile(): recovers stale locks, fails jobs orphaned by a crash, clears transient markers.
//  - sweepOrphans(): removes untracked old CSVs and abandoned *.tmp staging objects.
//  - startupRecovery(): all of the above, once, before the API accepts traffic.
// Cleanup only ever deletes keys under exports/ (plus *.tmp staging); permanent *.bin data is never touched.

import { MESSAGES } from '../lib/errors.js';
import { parseGithubKey } from '../services/github/client.js';
import { DATA_PREFIX, EXPORT_PREFIX, isExportKey } from '../services/r2/keys.js';

const ORPHAN_GRACE_MS = 15 * 60_000;
const ROW_RETENTION_MS = 60 * 60_000;

export function createCleanupWorker({ exportsRepo, datasetsRepo, lock, storage, github = null, config, logger, clock }) {
  let timer = null;
  let running = false;
  let ticks = 0;

  const worker = {
    async runExpiredCleanup() {
      const now = clock();
      const expired = await exportsRepo.listReadyExpired(now);
      let deleted = 0;
      for (const row of expired) {
        try {
          const gh = parseGithubKey(row.objectKey);
          if (gh) {
            // GitHub-hosted export: delete the artifact (the run too, to keep the Actions history tidy).
            if (github) {
              await github.deleteArtifact(gh.artifactId);
              await github.deleteRun(gh.runId).catch(() => {});
            } else {
              logger.warn('GitHub is not configured; artifact will expire on its own retention', { jobId: row.jobId });
            }
          } else if (row.objectKey && isExportKey(row.objectKey)) {
            await storage.deleteObject(row.objectKey);
          }
          await exportsRepo.markExpired(row.jobId);
          deleted++;
          logger.info('expired export deleted', { jobId: row.jobId });
        } catch (err) {
          logger.warn('could not delete expired export (will retry)', { jobId: row.jobId, error: err });
        }
      }
      const purged = await exportsRepo.purgeOlderThan(now - ROW_RETENTION_MS);
      return { deleted, purged };
    },

    async reconcile() {
      const stale = await lock.recoverStale();
      if (stale) logger.warn('recovered stale lock', stale);
      const current = await lock.current();

      let failed = 0;
      for (const row of await exportsRepo.listInFlight()) {
        if (current && current.jobId === row.jobId) continue; // genuinely running
        await exportsRepo.markFailed(row.jobId, { code: 'JOB_INTERRUPTED', message: MESSAGES.interrupted });
        failed++;
      }
      if (failed) logger.warn('marked orphaned exports as failed', { failed });

      if (!current) {
        const resetActivities = await datasetsRepo.resetActivities();
        const clearedDays = await datasetsRepo.clearTransientDays();
        if (resetActivities || clearedDays) logger.warn('reset transient dataset state', { resetActivities, clearedDays });
      }
      return { failed, staleRecovered: !!stale };
    },

    async sweepOrphans() {
      const now = clock();
      const cutoff = now - config.exportExpirationMinutes * 60_000 - ORPHAN_GRACE_MS;
      let removed = 0;
      for (const obj of await storage.listObjects(EXPORT_PREFIX)) {
        if (obj.lastModified < cutoff) {
          await storage.deleteObject(obj.key);
          removed++;
        }
      }
      for (const obj of await storage.listObjects(DATA_PREFIX)) {
        // Only abandoned staging files; finalized datasets (*.bin) are never removed here.
        if (obj.key.endsWith('.bin.tmp') && obj.lastModified < now - ORPHAN_GRACE_MS) {
          await storage.deleteObject(obj.key);
          removed++;
        }
      }
      if (removed) logger.info('removed orphaned objects', { removed });
      return removed;
    },

    async startupRecovery() {
      await worker.reconcile();
      const cleanup = await worker.runExpiredCleanup();
      const orphans = await worker.sweepOrphans().catch((err) => {
        logger.warn('orphan sweep failed', { error: err });
        return 0;
      });
      logger.info('startup recovery complete', { ...cleanup, orphans });
    },

    async tick() {
      if (running) return;
      running = true;
      try {
        ticks++;
        await worker.reconcile();
        await worker.runExpiredCleanup();
        if (ticks % 15 === 0) await worker.sweepOrphans();
      } catch (err) {
        logger.error('cleanup tick failed', { error: err });
      } finally {
        running = false;
      }
    },

    start() {
      timer = setInterval(() => worker.tick(), config.cleanupIntervalSeconds * 1000);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return worker;
}
