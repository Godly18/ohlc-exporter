// Process entry point.
//
// Order matters for Render's free tier: bind the port and answer /health IMMEDIATELY, then connect
// to the database / R2 in the background (retrying forever). A slow or failing dependency can
// delay the API, but can never make /health unavailable.

import http from 'node:http';
import { createApp } from './app.js';
import { createServices } from './bootstrap.js';
import { loadConfig, secretValues } from './config/index.js';
import { createDb, migrate } from './database/index.js';
import { createLogger } from './lib/logger.js';
import { sleep } from './lib/yield.js';
import { createBinanceClient } from './services/binance/client.js';
import { createGithubClient } from './services/github/client.js';
import { createOandaClient } from './services/oanda/client.js';
import { createTwelveDataClient } from './services/twelvedata/client.js';
import { createR2Storage } from './services/r2/storage.js';
import { createKeepAlive } from './workers/keepalive.js';

const { config, missing } = loadConfig();
const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', secrets: secretValues(config) });
const clock = () => Date.now();
const state = { ready: false, shuttingDown: false, missing, startedAt: clock() };
const ctx = { config, logger, state, clock, services: {} };

// Keep the process alive no matter what a stray rejection does; all real work is wrapped and
// recoverable (persistent lock lease, startup recovery), so logging is the right response.
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { error: reason }));
process.on('uncaughtException', (err) => logger.error('uncaught exception', { error: err }));

const handler = createApp(ctx);
const server = http.createServer(handler);
server.keepAliveTimeout = 125_000; // longer than Render's proxy idle timeout (avoids spurious 502s)
server.headersTimeout = 126_000;
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, config.host, () => {
  logger.info('server listening', { port: config.port, env: config.nodeEnv });
});

const keepAlive = createKeepAlive({ config, logger });

async function init() {
  if (missing.length > 0) {
    logger.error('configuration incomplete: API disabled, /health still available', { missing });
    return;
  }
  for (let attempt = 1; !state.shuttingDown; attempt++) {
    let db = null;
    try {
      db = await createDb(config, { onError: (err) => logger.warn('database pool error', { error: err }) });
      await migrate(db);
      const storage = await createR2Storage(config.r2);
      const oanda = createOandaClient({ oanda: config.oanda, logger });
      const binance = createBinanceClient({ binance: config.binance, logger, clock });
      const twelvedata = config.twelvedata.apiKey ? createTwelveDataClient({ twelvedata: config.twelvedata, logger, clock }) : null;
      const github = config.exportMode === 'github' ? createGithubClient({ github: config.github, logger }) : null;
      logger.info('export mode', { mode: config.exportMode, xauusd: !!twelvedata });
      const services = createServices({ config, logger, clock, db, storage, oanda, binance, twelvedata, github });
      await services.cleanup.startupRecovery(); // stale lock, orphaned jobs, expired exports
      ctx.services = services;
      services.cleanup.start();
      services.maintenance.start();
      keepAlive.start();
      state.ready = true;
      logger.info('service ready');
      return;
    } catch (err) {
      logger.error('startup failed; retrying in 15s', { attempt, error: err });
      await db?.close().catch(() => {});
      await sleep(15_000);
    }
  }
}
init();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  state.shuttingDown = true;
  logger.info('shutdown requested', { signal });
  try {
    ctx.services.cleanup?.stop();
    ctx.services.maintenance?.stop();
    keepAlive.stop();
    ctx.services.runner?.abortAll('shutdown'); // job marks itself failed and releases the lock
    await Promise.race([ctx.services.exportService?.whenIdle(), sleep(8000)]);
  } catch (err) {
    logger.error('error during shutdown', { error: err });
  }
  handler.stop();
  server.close(() => process.exit(0)); // /health keeps answering until here
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
