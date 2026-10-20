// Wires repositories, lock, services and workers together. Used by server.js and by the tests
// (which inject SQLite, an in-memory object store and a fake OANDA).

import { createDatasetsRepo } from './database/datasetsRepo.js';
import { createExportsRepo } from './database/exportsRepo.js';
import { createDatasetService } from './services/datasets/datasetService.js';
import { createExportService } from './services/exports/exportService.js';
import { createGlobalLock } from './services/jobs/lock.js';
import { createGithubExport } from './services/exports/githubExport.js';
import { createMarketData } from './services/sources/marketData.js';
import { createJobRunner } from './services/jobs/jobRunner.js';
import { createCleanupWorker } from './workers/cleanup.js';
import { createMaintenanceWorker } from './workers/maintenance.js';

export function createServices({ config, logger, clock, db, storage, oanda, binance = null, twelvedata = null, github = null, owner = `pid-${process.pid}` }) {
  const leaseMs = config.lockLeaseSeconds * 1000;
  const datasetsRepo = createDatasetsRepo(db, clock);
  const exportsRepo = createExportsRepo(db, clock);
  const lock = createGlobalLock(db, { leaseMs, clock, owner });
  const runner = createJobRunner({ lock, logger, heartbeatMs: config.lockHeartbeatSeconds * 1000, leaseMs, clock });
  const source = createMarketData({ oanda, binance, twelvedata });
  const datasetService = createDatasetService({ repo: datasetsRepo, storage, source, config, logger, clock });
  const githubExport = github ? createGithubExport({ github: config.github, client: github, logger }) : null;
  const exportService = createExportService({ exportsRepo, datasetService, storage, runner, config, logger, clock, githubExport });
  const cleanup = createCleanupWorker({ exportsRepo, datasetsRepo, lock, storage, github, config, logger, clock });
  const maintenance = createMaintenanceWorker({ datasetsRepo, datasetService, runner, config, logger, clock });

  return { db, storage, github, datasetsRepo, exportsRepo, lock, runner, datasetService, exportService, cleanup, maintenance };
}
