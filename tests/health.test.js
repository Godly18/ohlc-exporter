import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../backend/app.js';
import { loadConfig } from '../backend/config/index.js';
import { CandleSet } from '../backend/lib/candles.js';
import { decodeDataset, encodeDataset } from '../backend/lib/binformat.js';
import { csvChunks } from '../backend/lib/csv.js';
import { silentLogger } from '../backend/lib/logger.js';
import { dayStartSec } from '../backend/lib/time.js';
import { validateCandleSet } from '../backend/lib/validation.js';
import { createHarness } from './helpers/harness.js';

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

const ping = async (base) => {
  const t = performance.now();
  const res = await fetch(`${base}/health`);
  const json = await res.json();
  return { status: res.status, json, ms: performance.now() - t };
};

describe('/health', () => {
  it('returns 200 {status:"ok"} for GET and HEAD', async () => {
    h = await createHarness();
    const res = await ping(h.baseUrl);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.equal(typeof res.json.uptimeSeconds, 'number');
    const head = await fetch(`${h.baseUrl}/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'no-store');
  });

  it('answers while the service is still starting (no database, no storage, no services at all)', async () => {
    const { config } = loadConfig({});
    const state = { ready: false, missing: ['DATABASE_URL'], shuttingDown: false };
    const handler = createApp({ config, logger: silentLogger(), state, clock: Date.now, services: {} });
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await ping(base)).status, 200);
    assert.equal((await fetch(`${base}/api/export/active`)).status, 503); // API is unavailable, health is not
    handler.stop();
    await new Promise((r) => server.close(r));
  });

  it('keeps answering when the database is down', async () => {
    h = await createHarness();
    h.db.query = async () => {
      throw new Error('connection refused: postgres://secret-host');
    };
    assert.equal((await ping(h.baseUrl)).status, 200);
    const api = await h.browser().request('/api/export/active');
    assert.equal(api.status, 500); // API fails safely...
    assert.ok(!JSON.stringify(api.json).includes('secret-host'), '...without leaking internals');
    assert.equal((await ping(h.baseUrl)).status, 200); // ...and health is unaffected
  });

  it('keeps answering while a job holds the global lock and while shutting down', async () => {
    h = await createHarness();
    let release;
    h.oanda.gate = new Promise((r) => (release = r));
    const c = h.browser();
    const job = await c.request('/api/export', {
      method: 'POST',
      body: { instrument: 'EUR_USD', timeframe: 'M1', start_date: '2026-09-01', end_date: '2026-09-03' },
    });
    assert.equal((await ping(h.baseUrl)).status, 200);
    h.state.shuttingDown = true;
    assert.equal((await ping(h.baseUrl)).status, 200);
    release();
    await h.waitForJob(c, job.json.jobId);
  });

  it('is never rate limited, never redirected and never needs a cookie', async () => {
    h = await createHarness({ env: { FORCE_HTTPS: 'true', RATE_LIMIT_API_PER_MIN: '1' } });
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${h.baseUrl}/health`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('set-cookie'), null);
    }
  });

  it('stays responsive (low latency) while the server does heavy CPU work: encode, validate, decode and CSV of 480k candles', async () => {
    h = await createHarness();
    const set = new CandleSet(480_000);
    const t0 = dayStartSec('2026-01-01');
    for (let i = 0; i < 480_000; i++) set.push(t0 + i * 60, 100_000 + (i % 97), 100_200 + (i % 97), 99_900 + (i % 97), 100_050 + (i % 97), 1 + (i % 40));
    const completeThrough = '2026-12-31';

    let working = true;
    const latencies = [];
    const poller = (async () => {
      while (working) {
        latencies.push((await ping(h.baseUrl)).ms);
        await sleep(2);
      }
    })();

    const started = performance.now();
    const buf = await encodeDataset(set, { instrument: 'EUR_USD', timeframe: 'M1', year: 2026, completeThrough });
    const { set: decoded, header } = await decodeDataset(buf, { instrument: 'EUR_USD', timeframe: 'M1', year: 2026 });
    const problem = await validateCandleSet(decoded, { year: 2026, stepSeconds: 60, completeThrough: header.completeThrough });
    let bytes = 0;
    for await (const chunk of csvChunks([{ set: decoded, from: 0, to: decoded.length }], { displayDecimals: 5 })) bytes += chunk.length;
    const busyMs = performance.now() - started;
    working = false;
    await poller;

    assert.equal(problem, null);
    assert.ok(bytes > 10_000_000);
    const max = Math.max(...latencies);
    console.log(`    heavy work ${busyMs.toFixed(0)} ms; ${latencies.length} /health pings; max latency ${max.toFixed(1)} ms`);
    assert.ok(latencies.length > 20, 'health was polled throughout the heavy work');
    assert.ok(max < 250, `max /health latency ${max.toFixed(1)}ms`);
  });
});

describe('real process: server.js', () => {
  it('boots with NO configuration, serves /health immediately, and shuts down gracefully on SIGTERM', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['backend/server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH, PORT: String(port), LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    let res = null;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (!res) await sleep(100);
    }
    assert.ok(res, `server did not start: ${output}`);
    assert.equal(res.status, 200);
    assert.match(output, /configuration incomplete/);

    const api = await fetch(`http://127.0.0.1:${port}/api/export/active`);
    assert.equal(api.status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200); // frontend is served

    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0);
    assert.match(output, /shutdown requested/);
  });
});
