// Runs inside the GitHub Actions workflow (.github/workflows/export-csv.yml). Two modes (JOB_MODE):
//   export       : retrieve/verify the yearly datasets (provider -> R2), then build the CSV (+ missing-data report)
//                  into out/ for the artifact upload. Progress goes to the same database the web app reads.
//   maintenance  : the hourly catch-up of existing datasets.
// All provider downloads therefore happen on GitHub's network, not on the web server.
// Inputs arrive as environment variables (never interpolated into shell code).

import path from 'node:path';
import { createServices } from '../backend/bootstrap.js';
import { loadConfig, secretValues } from '../backend/config/index.js';
import { createDb, migrate } from '../backend/database/index.js';
import { createLogger } from '../backend/lib/logger.js';
import { validateExportRequest } from '../backend/lib/validation.js';
import { createBinanceClient } from '../backend/services/binance/client.js';
import { createOandaClient } from '../backend/services/oanda/client.js';
import { createR2Storage } from '../backend/services/r2/storage.js';
import { createTwelveDataClient } from '../backend/services/twelvedata/client.js';
import { runRemoteExport, runRemoteMaintenance } from '../backend/workers/remoteJob.js';
import { EXPORT_ID_RE, JOB_ID_RE } from '../backend/lib/tokens.js';

function fail(message) {
  console.error(`job failed: ${message}`);
  process.exit(1);
}

// The web app already enforced the range / settle-time limits before it dispatched this run; only the
// instrument, date and per-instrument first-year rules are re-checked here.
const { config } = loadConfig({
  EXPORT_TOKEN_SECRET: 'x'.repeat(16),
  MIN_DATA_YEAR: '1970',
  MAX_EXPORT_YEARS: '10',
  DAY_SETTLE_MINUTES: '0',
  ...process.env,
  GH_EXPORT_TOKEN: '', // this process never talks to the GitHub API
  EXPORT_MODE: 'server',
});
for (const key of ['DATABASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  if (!process.env[key]) fail(`missing secret ${key} (add it under the repository's Actions secrets)`);
}

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', secrets: secretValues(config) });
const mode = process.env.JOB_MODE === 'maintenance' ? 'maintenance' : 'export';
const abort = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => abort.abort(new Error(`received ${sig} (the run was cancelled)`)));

const db = await createDb(config, { onError: (err) => logger.warn('database pool error', { error: err }) });
await migrate(db);
const storage = await createR2Storage(config.r2);
const clock = () => Date.now();
const services = createServices({
  config,
  logger,
  clock,
  db,
  storage,
  oanda: config.oanda.token ? createOandaClient({ oanda: config.oanda, logger }) : null,
  binance: createBinanceClient({ binance: config.binance, logger, clock }),
  twelvedata: config.twelvedata.apiKey ? createTwelveDataClient({ twelvedata: config.twelvedata, logger, clock }) : null,
  github: null,
  owner: 'workflow',
});

let exitCode = 0;
try {
  if (mode === 'maintenance') {
    await runRemoteMaintenance({ maintenance: services.maintenance, signal: abort.signal, logger });
  } else {
    const exportId = process.env.EXPORT_ID ?? '';
    const jobId = process.env.JOB_ID ?? '';
    const artifactName = process.env.ARTIFACT_NAME ?? '';
    if (!EXPORT_ID_RE.test(exportId) || !JOB_ID_RE.test(jobId)) fail('invalid export or job id');
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(artifactName)) fail('invalid artifact name');
    const lastDay = process.env.LAST_DAY ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) fail('invalid last day');

    let request;
    try {
      request = validateExportRequest(
        { instrument: process.env.INSTRUMENT, timeframe: process.env.TIMEFRAME, start_date: process.env.START_DATE, end_date: process.env.END_DATE },
        Date.now(),
        config,
      );
    } catch (err) {
      fail(err?.message ?? 'invalid request');
    }
    const result = await runRemoteExport({
      job: { jobId, exportId, artifactName, lastDay, ...request },
      datasetService: services.datasetService,
      exportsRepo: services.exportsRepo,
      storage,
      config,
      logger,
      signal: abort.signal,
      outDir: path.resolve('out'),
    });
    if (!result.ok) exitCode = 1; // the reason was published for the web app; the run is marked failed in the Actions history
  }
} catch (err) {
  logger.error('job crashed', { error: err });
  exitCode = 1;
} finally {
  await storage.close?.();
  await db.close?.();
}
process.exit(exitCode);
