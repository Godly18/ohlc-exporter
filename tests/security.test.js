import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { createLogger } from '../backend/lib/logger.js';
import { randomBytes } from 'node:crypto';
import { assertSafeKey, datasetKey, exportKey } from '../backend/services/r2/keys.js';
import { createHarness } from './helpers/harness.js';

const body = (o = {}) => ({ instrument: 'EUR_USD', timeframe: 'M1', start_date: '2026-09-01', end_date: '2026-09-03', ...o });
let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

function rawGet(baseUrl, path) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

describe('input validation', () => {
  it('rejects unsupported / malicious instruments and timeframes before anything else happens', async () => {
    h = await createHarness();
    const c = h.browser();
    const bad = [
      { instrument: '../../etc/passwd' },
      { instrument: 'EUR_USD/../../x' },
      { instrument: 'eur_usd' },
      { instrument: 'EUR_USD\u0000' },
      { instrument: '__proto__' },
      { instrument: 'constructor' },
      { instrument: ['EUR_USD'] },
      { instrument: null },
      { timeframe: 'M5' },
      { timeframe: '../M1' },
      { timeframe: 'm1' },
    ];
    for (const patch of bad) {
      const res = await c.request('/api/export', { method: 'POST', body: body(patch) });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.match(res.json.error.code, /INVALID_(INSTRUMENT|TIMEFRAME)/);
    }
    assert.equal(h.oanda.calls.length, 0);
    assert.equal(h.storage.keys().length, 0);
  });

  it('rejects malformed dates and inverted ranges', async () => {
    h = await createHarness();
    const c = h.browser();
    for (const patch of [{ start_date: '2026-9-1' }, { end_date: 'tomorrow' }, { start_date: '2026-02-30' }, { end_date: '2026-09-03T00:00:00Z' }, { start_date: 20260901 }, { start_date: "2026-09-01'; DROP TABLE exports;--" }]) {
      const res = await c.request('/api/export', { method: 'POST', body: body(patch) });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal(res.json.error.code, 'INVALID_DATE');
    }
    const inverted = await c.request('/api/export', { method: 'POST', body: body({ start_date: '2026-09-05', end_date: '2026-09-01' }) });
    assert.equal(inverted.json.error.message, 'Invalid date range. The start date must not be later than the end date.');
    assert.equal((await h.db.query('SELECT COUNT(*) AS n FROM exports')).rows[0].n, 0);
  });

  it('rejects non-JSON, oversized and unparsable bodies', async () => {
    h = await createHarness();
    const url = `${h.baseUrl}/api/export`;
    const plain = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(plain.status, 400);
    const broken = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(broken.status, 400);
    const huge = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(10_000) }) }).catch(() => ({ status: 400 }));
    assert.equal(huge.status, 400);
  });

  it('wrong methods and unknown routes are refused with JSON errors', async () => {
    h = await createHarness();
    const c = h.browser();
    assert.equal((await c.request('/api/export', { method: 'GET' })).status, 405);
    assert.equal((await c.request('/api/nope')).status, 404);
    assert.equal((await c.request('/api/export/status/not-a-uuid')).status, 404);
  });
});

describe('storage key safety (path traversal / arbitrary object access)', () => {
  it('only well-formed keys under the two known prefixes are ever accepted', () => {
    for (const k of ['../x', 'oanda-data/../exports/x', '/oanda-data/a', 'other/a.bin', 'exports/a b', 'exports//a', 'exports/..', '', null, 'exports/a\u0000', `oanda-data/${'a'.repeat(400)}`]) {
      assert.throws(() => assertSafeKey(k), /unsafe/, String(k));
    }
    assert.equal(assertSafeKey('oanda-data/EUR_USD/M1/2025.bin'), 'oanda-data/EUR_USD/M1/2025.bin');
  });

  it('keys are built from allowlisted values only', () => {
    assert.throws(() => datasetKey('../../x', 'M1', 2025));
    assert.throws(() => datasetKey('EUR_USD', '../M1', 2025));
    assert.throws(() => datasetKey('EUR_USD', 'M1', '2025/../../x'));
    assert.throws(() => exportKey('../../oanda-data/EUR_USD/M1/2025.bin'));
    assert.equal(datasetKey('EUR_USD', 'M1', 2025), 'oanda-data/EUR_USD/M1/2025.bin');
  });
});

describe('download authorization', () => {
  it('unguessable: random, malformed and traversal tokens all get 404; real object keys are not reachable', async () => {
    h = await createHarness();
    const c = h.browser();
    await c.request('/api/export', { method: 'POST', body: body() }).then((r) => h.waitForJob(c, r.json.jobId));
    const guesses = [randomBytes(32).toString('base64url'), 'short', '../../etc/passwd', 'oanda-data/EUR_USD/M1/2026.bin', `exports/${'a'.repeat(32)}.csv`, 'A'.repeat(43)];
    for (const g of guesses) {
      const res = await rawGet(h.baseUrl, `/api/export/download/${g}`);
      assert.equal(res.status, 404, g);
    }
    assert.equal((await rawGet(h.baseUrl, '/api/export/download/')).status, 404);
  });

  it("another browser cannot read someone else's job status", async () => {
    h = await createHarness();
    const owner = h.browser();
    const res = await owner.request('/api/export', { method: 'POST', body: body() });
    await h.waitForJob(owner, res.json.jobId);
    const other = h.browser();
    assert.equal((await other.request(`/api/export/status/${res.json.jobId}`)).status, 404);
    assert.equal((await owner.request(`/api/export/status/${res.json.jobId}`)).status, 200);
  });
});

describe('secrets and hardening', () => {
  it('no secret appears in any page, script, stylesheet, API response or log line', async () => {
    const secrets = { OANDA_API_TOKEN: 'oanda-SECRET-token-123456', R2_ACCESS_KEY_ID: 'r2-ACCESS-key-123456', R2_SECRET_ACCESS_KEY: 'r2-SECRET-key-123456', DATABASE_URL: 'postgres://u:DBPASSWORD123@db/x' };
    h = await createHarness({ env: secrets });
    const c = h.browser();
    const job = await c.request('/api/export', { method: 'POST', body: body() });
    await h.waitForJob(c, job.json.jobId);

    const surfaces = [];
    for (const p of ['/', '/index.html', '/js/app.js', '/css/styles.css', '/api/config', '/health', '/api/export/active', `/api/export/status/${job.json.jobId}`]) {
      surfaces.push((await c.request(p)).text);
    }
    surfaces.push(...h.logLines.map((l) => l.line));
    for (const value of [...Object.values(secrets), 'DBPASSWORD123']) {
      assert.ok(!surfaces.some((s) => s.includes(value)), `leaked ${value}`);
    }
  });

  it('the logger redacts secrets even if they are logged by mistake', () => {
    const lines = [];
    const log = createLogger({ level: 'info', secrets: ['super-secret-token'], sink: (_l, line) => lines.push(line) });
    log.info('token is super-secret-token here', { nested: 'x super-secret-token y' });
    assert.ok(!lines[0].includes('super-secret-token'));
    assert.match(lines[0], /\[redacted\]/);
  });

  it('serves hardened headers and an HttpOnly, SameSite=Strict session cookie', async () => {
    h = await createHarness();
    const res = await h.browser().request('/api/export/active');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    assert.match(res.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('static files cannot escape the frontend directory', async () => {
    h = await createHarness();
    for (const p of ['/..%2fbackend%2fserver.js', '/%2e%2e/backend/config/index.js', '/../package.json', '/js/../../package.json', '/%00.html', '/js/app.js%00.png']) {
      const res = await rawGet(h.baseUrl, p);
      assert.equal(res.status, 404, p);
      assert.ok(!res.data.includes('createServer'));
    }
    assert.equal((await rawGet(h.baseUrl, '/js/app.js')).status, 200);
  });

  it('redirects plain HTTP to HTTPS in production, except /health', async () => {
    h = await createHarness({ env: { FORCE_HTTPS: 'true' } });
    const api = await fetch(`${h.baseUrl}/api/config`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(api.status, 308);
    const health = await fetch(`${h.baseUrl}/health`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(health.status, 200);
    const https = await fetch(`${h.baseUrl}/api/config`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(https.status, 200);
    assert.match(https.headers.get('strict-transport-security'), /max-age/);
  });

  it('rate limits the API (and never /health)', async () => {
    h = await createHarness({ env: { RATE_LIMIT_API_PER_MIN: '10', RATE_LIMIT_EXPORT_PER_MIN: '2' } });
    const c = h.browser();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await c.request('/api/export', { method: 'POST', body: body({ instrument: 'BAD' }) })).status);
    assert.deepEqual(statuses, [400, 400, 429, 429]);
    for (let i = 0; i < 50; i++) assert.equal((await fetch(`${h.baseUrl}/health`)).status, 200);
  });
});
