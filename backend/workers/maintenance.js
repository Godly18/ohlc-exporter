// Background maintenance of recent datasets. Obeys the SAME global lock as user requests:
// if anything is running, maintenance skips this cycle (no hidden queue; the next cycle retries).
// It only touches (instrument, timeframe) pairs that already have a dataset, and catches up every
// missing complete UTC day, including after downtime and across a year boundary.

import { newJobId } from '../lib/tokens.js';
import { latestFetchableDay, utcDateOf, yearEndDate, yearOf, yearStartDate } from '../lib/time.js';
import { DatasetStatus } from '../database/datasetsRepo.js';

export function createMaintenanceWorker({ datasetsRepo, datasetService, runner, config, logger, clock }) {
  let timer = null;
  let starter = null;
  let running = false;

  async function maintainPair(handle, { instrument, timeframe }) {
    const now = clock();
    const currentYear = yearOf(utcDateOf(now));
    const fetchable = latestFetchableDay(now, config.daySettleMinutes);
    const existing = new Map((await datasetsRepo.list({ minYear: 0 })).filter((d) => d.instrument === instrument && d.timeframe === timeframe).map((d) => [d.year, d]));

    // Last year and this year are kept current. Any OLDER year that was only partly retrieved (an interrupted
    // request, e.g. a slow XAU/USD build) is also continued here, so users do not have to re-request it.
    const unfinished = [...existing.values()].filter((d) => d.year < currentYear - 1 && d.status === DatasetStatus.COMPLETE_THROUGH_DAY).map((d) => d.year);
    for (const year of [...new Set([...unfinished, currentYear - 1, currentYear])].sort((a, b) => a - b)) {
      const meta = existing.get(year);
      const prior = existing.get(year - 1);
      if (meta?.status === DatasetStatus.CORRUPTED) continue; // rebuilt on demand, not in the background
      if (!meta && !(year === currentYear && existing.get(currentYear - 1))) continue;

      const through = year < currentYear ? yearEndDate(year) : fetchable;
      if (through < yearStartDate(year)) continue; // e.g. Jan 1: nothing of this year is complete yet
      const target = through > yearEndDate(year) ? yearEndDate(year) : through;
      if (meta && meta.lastCompleteDate && meta.lastCompleteDate >= target) continue; // already current
      void prior;

      logger.info('maintenance: updating dataset', { instrument, timeframe, year, through: target });
      await datasetService.ensure({ instrument, timeframe, year, through: target, signal: handle.signal });
    }
  }

  const worker = {
    async runOnce() {
      if (running) return { skipped: 'already running' };
      running = true;
      try {
        const targets = await datasetsRepo.listMaintenanceTargets(yearOf(utcDateOf(clock())) - 1);
        for (const pair of targets) {
          const handle = await runner.tryStart('maintenance', newJobId());
          if (!handle) {
            logger.info('maintenance skipped: another job holds the global lock');
            return { skipped: 'busy' };
          }
          try {
            await maintainPair(handle, pair);
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
