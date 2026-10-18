// Test harness: real services + real HTTP server, with SQLite, in-memory R2 and fake OANDA.

import http from 'node:http';
import { createApp } from '../../backend/app.js';
import { createServices } from '../../backend/bootstrap.js';
import { loadConfig } from '../../backend/config/index.js';
import { createSqliteDb, migrate } from '../../backend/database/index.js';
import { createLogger } from '../../backend/lib/logger.js';
import { createFakeOanda } from './fakeOanda.js';
import { createMemoryStorage } from './memoryStorage.js';

export const TOKEN_SECRET = 'test-secret-0123456789-abcdefghijkl';

export function createClock(iso) {
  const c = { t: Date.parse(iso) };
  c.now = () => c.t;
  c.advance = (ms) => {
    c.t += ms;
  };
  c.set = (value) => {
    c.t = Date.parse(value);
  };
  return c;
}

export async function createHarness({ now = '2026-09-14T12:00:00Z', env = {}, oanda: oandaOpts, withServer = true, db: existingDb, storage: existingStorage } = {}) {
  const clock = createClock(now);
  const { config } = loadConfig({
    EXPORT_TOKEN_SECRET: TOKEN_SECRET,
    OANDA_REQUEST_DELAY_MS: '0',
    LOCK_HEARTBEAT_SECONDS: '1',
    LOCK_LEASE_SECONDS: '90',
    MIN_DATA_YEAR: '2020',
    MAX_EXPORT_DAYS: '2000',
    CHECKPOINT_DAYS: '30',
    MAINTENANCE_ENABLED: 'false',
    RATE_LIMIT_API_PER_MIN: '100000',
    RATE_LIMIT_EXPORT_PER_MIN: '100000',
    NODE_ENV: 'test',
    ...env,
  });

  const logLines = [];
  const logger = createLogger({ level: 'debug', sink: (lvl, line) => logLines.push({ lvl, line }) });
  const db = existingDb ?? (await createSqliteDb(':memory:'));
  await migrate(db);
  const storage = existingStorage ?? createMemoryStorage(clock.now);
  const oanda = createFakeOanda(oandaOpts);
  const services = createServices({ config, logger, clock: clock.now, db, storage, oanda, owner: 'test' });

  const state = { ready: true, shuttingDown: false, missing: [], startedAt: clock.now() };
  const ctx = { config, logger, state, clock: clock.now, services };
  const handler = createApp(ctx);

  let server = null;
  let baseUrl = null;
  if (withServer) {
    server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  /** Minimal browser: keeps the session cookie between requests. */
  function browser() {
    let cookie = '';
    return {
      get cookie() {
        return cookie;
      },
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const res = await fetch(baseUrl + path, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'manual',
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON (CSV, HTML) */
        }
        return { status: res.status, json, text, headers: res.headers };
      },
    };
  }

  async function close() {
    services.runner.abortAll('test over');
    await services.exportService.whenIdle();
    handler.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!existingDb) await db.close();
  }

  /** Poll a job until it leaves PROCESSING/GENERATING. */
  async function waitForJob(client, jobId) {
    for (let i = 0; i < 400; i++) {
      const { json } = await client.request(`/api/export/status/${jobId}`);
      if (json && !['PROCESSING', 'GENERATING'].includes(json.status)) return json;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not finish');
  }

  return { clock, config, logger, logLines, db, storage, oanda, services, ctx, state, handler, server, baseUrl, browser, close, waitForJob };
}

export const ymd = (v) => v;
