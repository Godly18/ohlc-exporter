// Background maintenance of recent datasets. Obeys the SAME global lock as user requests:
// if anything is running, maintenance skips this cycle (no hidden queue; the next cycle retries).
// It only touches (instrument, timeframe) pairs that already have a dataset, and catches up every
// missing complete UTC day, including after downtime and across a year boundary.

import { newExportId, newJobId } from '../lib/tokens.js';
import { latestFetchableDay, utcDateOf, yearEndDate, yearOf, yearStartDate } from '../lib/time.js';
import { DatasetStatus } from '../database/datasetsRepo.js';

export function createMaintenanceWorker({ datasetsRepo, datasetService, runner, config, logger, clock, githubExport = null }) {
  let timer = null;
  let starter = null;
  let running = false;

  /** What one (instrument, timeframe) pair still needs: [{ year, through }] (empty when it is current). */
  async function planPair({ instrument, timeframe }) {
    const now = clock();
    const currentYear = yearOf(utcDateOf(now));
    const fetchable = latestFetchableDay(now, config.daySettleMinutes);
    const existing = new Map((await datasetsRepo.list({ minYear: 0 })).filter((d) => d.instrument === instrument && d.timeframe === timeframe).map((d) => [d.year, d]));

    // Last year and this year are kept current. Any OLDER year that was only partly retrieved (an interrupted
    // request, e.g. a slow XAU/USD build) is also continued here, so users do not have to re-request it.
    const unfinished = [...existing.values()].filter((d) => d.year < currentYear - 1 && d.status === DatasetStatus.COMPLETE_THROUGH_DAY).map((d) => d.year);
    const plan = [];
    for (const year of [...new Set([...unfinished, currentYear - 1, currentYear])].sort((a, b) => a - b)) {
      const meta = existing.get(year);
      if (meta?.status === DatasetStatus.CORRUPTED) continue; // rebuilt on demand, not in the background
      if (!meta && !(year === currentYear && existing.get(currentYear - 1))) continue;

      const through = year < currentYear ? yearEndDate(year) : fetchable;
      if (through < yearStartDate(year)) continue; // e.g. Jan 1: nothing of this year is complete yet
      const target = through > yearEndDate(year) ? yearEndDate(year) : through;
      if (meta && meta.lastCompleteDate && meta.lastCompleteDate >= target) continue; // already current
      plan.push({ year, through: target });
    }
    return plan;
  }

  async function maintainPair(signal, pair) {
    for (const { year, through } of await planPair(pair)) {
      logger.info('maintenance: updating dataset', { ...pair, year, through });
      await datasetService.ensure({ ...pair, year, through, signal });
    }
  }

  const listTargets = () => datasetsRepo.listMaintenanceTargets(yearOf(utcDateOf(clock())) - 1);

  const worker = {
    planPair,

    /** Everything, with NO lock handling: used inside the GitHub workflow (the web server holds the lock). */
    async runAll({ signal } = {}) {
      const targets = await listTargets();
      for (const pair of targets) {
        signal?.throwIfAborted();
        try {
          await maintainPair(signal, pair);
        } catch (err) {
          if (signal?.aborted) throw err;
          logger.warn('maintenance failed for dataset (will retry next cycle)', { ...pair, error: err });
        }
      }
      return { pairs: targets.length };
    },

    async runOnce() {
      if (running) return { skipped: 'already running' };
      running = true;
      try {
        const targets = await listTargets();

        if (githubExport) {
          // Retrieval happens on GitHub Actions: look (cheaply, database only) whether anything is due, then hand
          // the whole catch-up to ONE workflow run while this server holds the global lock.
          let due = false;
          for (const pair of targets) if ((await planPair(pair)).length) due = true;
          if (!due) return { skipped: null, pairs: targets.length, remote: false };
          const handle = await runner.tryStart('maintenance', newJobId());
          if (!handle) {
            logger.info('maintenance skipped: another job holds the global lock');
            return { skipped: 'busy' };
          }
          try {
            await githubExport.runMaintenance({ exportId: newExportId(), signal: handle.signal });
          } catch (err) {
            logger.warn('remote maintenance failed (will retry next cycle)', { error: err });
          } finally {
            await handle.finish();
          }
          return { skipped: null, pairs: targets.length, remote: true };
        }

        for (const pair of targets) {
          const handle = await runner.tryStart('maintenance', newJobId());
          if (!handle) {
            logger.info('maintenance skipped: another job holds the global lock');
            return { skipped: 'busy' };
          }
          try {
            await maintainPair(handle.signal, pair);
          } catch (err) {
            logger.warn('maintenance failed for dataset (will retry next cycle)', { ...pair, error: err });
          } finally {
            await handle.finish();
          }
        }
        return { skipped: null, pairs: targets.length };
      } finally {
        running = false;
      }
    },

    start() {
      if (!config.maintenance.enabled) return;
      const run = () => worker.runOnce().catch((err) => logger.error('maintenance cycle failed', { error: err }));
      starter = setTimeout(run, config.maintenance.startDelaySeconds * 1000);
      timer = setInterval(run, config.maintenance.intervalMinutes * 60_000);
      starter.unref?.();
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      if (starter) clearTimeout(starter);
      timer = starter = null;
    },
  };
  return worker;
}
