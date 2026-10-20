// Live-infrastructure smoke test. Run it ONCE with your real credentials (locally with a .env file,
// or in the Render Shell):   npm run smoke
//
// It exercises exactly the integrations the automated test-suite replaces with test doubles:
//   1. PostgreSQL  - connect, create the schema, take and release the global lock
//   2. Cloudflare R2 - put / head / copy / get / list / delete round trip (under exports/ only)
//   3. OANDA       - download one real, completed UTC day of M1 candles
//   4. Binance     - one day via the REST API, and one old month via the monthly archive (checksum verified)
//   5. Twelve Data - one XAUUSD window (only when TWELVEDATA_API_KEY is set)
//   6. GitHub      - the token can see the export workflow (only when export mode is "github")
// It never prints secrets and never touches permanent datasets (oanda-data/).

import { loadConfig, secretValues } from '../backend/config/index.js';
import { createDb, migrate } from '../backend/database/index.js';
import { createLogger } from '../backend/lib/logger.js';
import { addDays, isMarketClosedDay, utcDateOf } from '../backend/lib/time.js';
import { newExportId } from '../backend/lib/tokens.js';
import { createGlobalLock } from '../backend/services/jobs/lock.js';
import { createBinanceClient } from '../backend/services/binance/client.js';
import { createGithubClient } from '../backend/services/github/client.js';
import { createOandaClient } from '../backend/services/oanda/client.js';
import { createTwelveDataClient } from '../backend/services/twelvedata/client.js';
import { exportKey } from '../backend/services/r2/keys.js';
import { createR2Storage } from '../backend/services/r2/storage.js';

const { config, missing } = loadConfig();
const logger = createLogger({ level: 'warn', secrets: secretValues(config) });
let failures = 0;

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}  -> ${logger.redact(String(err?.message ?? err))}`);
  }
}

if (missing.length) {
  console.log(`Missing configuration: ${missing.join(', ')}`);
  process.exit(2);
}

let db = null;
let storage = null;

await step('PostgreSQL: connect and migrate', async () => {
  db = await createDb(config);
  await migrate(db);
  return db.dialect;
});

await step('PostgreSQL: global lock acquire / refuse / release', async () => {
  const lock = createGlobalLock(db, { leaseMs: 60_000, clock: Date.now, owner: 'smoke' });
  if (!(await lock.acquire('smoke-a', 'smoke'))) throw new Error('could not acquire (is a real job running?)');
  const second = await lock.acquire('smoke-b', 'smoke');
  await lock.release('smoke-a');
  if (second) throw new Error('second acquire should have been refused');
});

await step('R2: put / head / copy / get / list / delete round trip', async () => {
  storage = await createR2Storage(config.r2);
  const a = exportKey(newExportId());
  const b = exportKey(newExportId());
  const payload = Buffer.from('smoke-test');
  try {
    await storage.putObject(a, payload, { contentType: 'text/plain' });
    const head = await storage.headObject(a);
    if (head?.size !== payload.length) throw new Error('head size mismatch');
    await storage.copyObject(a, b);
    const got = await storage.getObjectBuffer(b);
    if (!got?.equals(payload)) throw new Error('copied content mismatch');
    const listed = await storage.listObjects('exports/');
    if (!listed.some((o) => o.key === b)) throw new Error('list did not return the copied object');
    async function* chunks() {
      yield Buffer.from('chunk-1,');
      yield Buffer.from('chunk-2');
    }
    await storage.putChunks(a, chunks(), { contentType: 'text/csv' });
    if ((await storage.getObjectBuffer(a)).toString() !== 'chunk-1,chunk-2') throw new Error('streamed upload mismatch');
  } finally {
    await storage.deleteObject(a);
    await storage.deleteObject(b);
  }
  if (await storage.headObject(a)) throw new Error('delete did not remove the object');
});

await step('OANDA: download one completed UTC day of M1 candles', async () => {
  const oanda = createOandaClient({ oanda: config.oanda, logger });
  let day = addDays(utcDateOf(Date.now()), -3);
  while (isMarketClosedDay(day)) day = addDays(day, -1);
  const { candles, incompleteCount } = await oanda.fetchDayCandles({ instrument: 'EUR_USD', timeframe: 'M1', date: day });
  if (candles.length === 0) throw new Error(`no candles returned for ${day}`);
  if (incompleteCount > 0) throw new Error(`${incompleteCount} incomplete candles for ${day}`);
  return `${day}: ${candles.length} candles, ${config.oanda.environment} environment`;
});

await step('Binance: one recent day through the REST API (BTCUSDT)', async () => {
  const binance = createBinanceClient({ binance: { ...config.binance, archiveEnabled: false }, logger });
  const date = addDays(utcDateOf(Date.now()), -2);
  const { candles, incompleteCount, via } = await binance.fetchDayCandles({ instrument: 'BTCUSDT', timeframe: 'M1', date });
  if (candles.length < 1000) throw new Error(`only ${candles.length} candles for ${date}`);
  if (incompleteCount > 0) throw new Error(`${incompleteCount} incomplete candles`);
  return `${date}: ${candles.length} candles via ${via}`;
});

await step('Binance: one old month through the monthly archive (BTCUSDT 2024-01)', async () => {
  const binance = createBinanceClient({ binance: config.binance, logger });
  const { candles, via } = await binance.fetchDayCandles({ instrument: 'BTCUSDT', timeframe: 'M1', date: '2024-01-15' });
  if (via !== 'archive') throw new Error(`expected the archive but got ${via}`);
  if (candles.length < 1000) throw new Error(`only ${candles.length} candles`);
  return `${candles.length} candles via archive (SHA-256 verified)`;
});

if (config.twelvedata.apiKey) {
  await step('Twelve Data: XAUUSD window', async () => {
    const td = createTwelveDataClient({ twelvedata: config.twelvedata, logger });
    let day = addDays(utcDateOf(Date.now()), -4);
    while (isMarketClosedDay(day)) day = addDays(day, -1);
    const { candles } = await td.fetchDayCandles({ instrument: 'XAUUSD', timeframe: 'M1', date: day, lastDay: day });
    if (candles.length === 0) throw new Error(`no candles for ${day} (check that your plan includes 1-minute XAU/USD history)`);
    return `${day}: ${candles.length} candles`;
  });
} else {
  console.log('SKIP  Twelve Data (TWELVEDATA_API_KEY not set: XAUUSD will not be offered)');
}

if (config.exportMode === 'github') {
  await step('GitHub: token can see the export workflow', async () => {
    const gh = createGithubClient({ github: config.github, logger });
    const w = await gh.checkWorkflow();
    if (w.state !== 'active') throw new Error(`workflow state is "${w.state}"`);
    await gh.findRun('export smoke-test'); // proves the token may read runs
    return `${config.github.repo} ${w.path}`;
  });
} else {
  console.log('SKIP  GitHub (EXPORT_MODE is "server": downloads will be streamed by this server)');
}

await db?.close().catch(() => {});
await storage?.close?.().catch(() => {});
console.log(failures === 0 ? '\nAll live checks passed.' : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
