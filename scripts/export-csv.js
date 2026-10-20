// Runs inside the GitHub Actions workflow (.github/workflows/export-csv.yml).
// Reads the verified yearly datasets from Cloudflare R2, writes ONE csv file, and exits. GitHub then zips it
// as a workflow artifact, which the app's download link redirects to (no download bytes through the server).
//
// Inputs come from environment variables (never interpolated into shell code):
//   INSTRUMENT, TIMEFRAME, START_DATE, END_DATE, ARTIFACT_NAME, R2_* (read-only token recommended)

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../backend/config/index.js';
import { writeExportCsv } from '../backend/lib/exportFile.js';
import { validateExportRequest } from '../backend/lib/validation.js';
import { createR2Storage } from '../backend/services/r2/storage.js';

function fail(message) {
  console.error(`export failed: ${message}`);
  process.exit(1);
}

// The web app already enforced its own limits (range size, settle time, global minimum year) before it
// dispatched this run; only the instrument/date rules and the per-instrument first year are re-checked here.
const { config } = loadConfig({
  ...process.env,
  EXPORT_TOKEN_SECRET: 'x'.repeat(16),
  TWELVEDATA_API_KEY: 'unused', // only so XAUUSD passes the "provider configured" check; this script never calls Twelve Data
  MIN_DATA_YEAR: '1970',
  MAX_EXPORT_DAYS: '100000',
  DAY_SETTLE_MINUTES: '0',
});
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  if (!process.env[key]) fail(`missing secret ${key} (add it under the repository's Actions secrets)`);
}

const artifactName = process.env.ARTIFACT_NAME ?? '';
if (!/^[A-Za-z0-9_.-]{1,120}$/.test(artifactName)) fail('invalid artifact name');

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

const outDir = path.resolve('out');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${artifactName}.csv`);

try {
  const storage = await createR2Storage(config.r2);
  const { rows, bytes } = await writeExportCsv({ storage, ...request, outFile });
  await storage.close?.();
  console.log(`wrote ${rows} rows (${bytes} bytes) for ${request.instrument} ${request.timeframe} ${request.start}..${request.end}`);
} catch (err) {
  fail(err?.message ?? String(err));
}
