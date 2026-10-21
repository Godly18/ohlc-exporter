import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadConfig, secretValues } from '../backend/config/index.js';
import { ExportFileError, writeExportCsv } from '../backend/lib/exportFile.js';
import { createGithubClient, githubKey, parseGithubKey } from '../backend/services/github/client.js';
import { silentLogger } from '../backend/lib/logger.js';
import { createHarness } from './helpers/harness.js';
import { unzipAll, unzipSingle } from './helpers/unzip.js';

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

const body = (instrument, start, end) => ({ instrument, timeframe: 'M1', start_date: start, end_date: end });
async function run(c, b) {
  const s = await c.request('/api/export', { method: 'POST', body: b });
  assert.equal(s.status, 202, JSON.stringify(s.json));
  return h.waitForJob(c, s.json.jobId);
}

describe('export mode and configuration', () => {
  it('defaults to github when GH_* are set, server otherwise; explicit EXPORT_MODE wins; secrets are redacted', () => {
    const base = { EXPORT_TOKEN_SECRET: 'x'.repeat(20) };
    assert.equal(loadConfig(base).config.exportMode, 'server');
    const gh = loadConfig({ ...base, GH_EXPORT_TOKEN: 'ghp_secret_token', GH_REPO: 'me/app' });
    assert.equal(gh.config.exportMode, 'github');
    assert.equal(gh.config.github.workflow, 'export-csv.yml');
    assert.equal(gh.config.github.ref, 'main');
    assert.equal(loadConfig({ ...base, GH_EXPORT_TOKEN: 't', GH_REPO: 'me/app', EXPORT_MODE: 'server' }).config.exportMode, 'server');
    assert.ok(secretValues(gh.config).includes('ghp_secret_token'));
    assert.ok(secretValues(loadConfig({ ...base, TWELVEDATA_API_KEY: 'td-secret-key' }).config).includes('td-secret-key'));
  });

  it('explicit github mode without a token or a valid owner/name is reported as missing configuration', () => {
    const { missing } = loadConfig({ EXPORT_MODE: 'github', GH_REPO: 'not a repo' });
    assert.ok(missing.includes('GH_EXPORT_TOKEN'));
    assert.ok(missing.some((m) => m.startsWith('GH_REPO')));
  });
});

describe('GitHub Actions offload', () => {
  it('builds the ZIP on GitHub, never in R2, and the download is a redirect to GitHub (no bytes through the server)', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    const job = await run(c, body('EUR_USD', '2026-09-01', '2026-09-13'));
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    assert.equal(job.download.filename, 'EUR_USD_M1_2026-09-01_2026-09-13.zip');

    // the workflow was asked for exactly this export
    assert.equal(h.github.dispatched.length, 1);
    const inputs = h.github.dispatched[0];
    assert.deepEqual(
      { i: inputs.instrument, t: inputs.timeframe, s: inputs.start_date, e: inputs.end_date, a: inputs.artifact_name },
      { i: 'EUR_USD', t: 'M1', s: '2026-09-01', e: '2026-09-13', a: 'EUR_USD_M1_2026-09-01_2026-09-13' },
    );
    assert.match(inputs.export_id, /^[A-Za-z0-9_-]{16,}$/);

    // no ZIP/CSV was written to R2 by the server (only the tiny missing-data report, if any)
    assert.deepEqual((await h.storage.listObjects('exports/')).filter((o) => !o.key.endsWith('_missing.txt')), []);
    const row = (await h.db.query('SELECT object_key, file_size FROM exports WHERE job_id = $1', [job.jobId])).rows[0];
    assert.match(row.object_key, /^gh:\d+:\d+$/);
    const [artifact] = [...h.github.artifacts.values()];
    assert.equal(row.file_size, artifact.zip.length);
    assert.equal(job.download.fileSize, artifact.zip.length);

    // the artifact is a zip with the CSV inside
    const zip = unzipSingle(artifact.zip);
    assert.equal(zip.name, 'EUR_USD_M1_2026-09-01_2026-09-13.csv');
    const lines = zip.data.toString().trimEnd().split('\n');
    assert.equal(lines[0], 'timestamp,open,high,low,close,volume');
    assert.equal(lines[1].split(',')[0], '2026-09-01T00:00:00Z');
    assert.ok(lines.some((l) => l.startsWith('2026-09-13T22:')), 'end date inclusive');
    assert.equal(lines.length - 1, job.download.rows);

    // the download endpoint only redirects
    const dl = await c.request(job.download.url);
    assert.equal(dl.status, 302);
    assert.equal(dl.headers.get('location'), h.github.downloadUrls.at(-1));
    assert.match(dl.headers.get('location'), /^https:\/\/blob\.example\.test\/artifact\/\d+/);
    assert.equal(dl.headers.get('cache-control'), 'no-store');
    assert.equal(dl.body.length, 0, 'zero download bytes through our server');
  });

  it('crypto and gold are offloaded the same way, with exact decimals', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    const btc = await run(c, body('BTCUSDT', '2026-09-01', '2026-09-02'));
    assert.equal(btc.status, 'READY', JSON.stringify(btc.error));
    const art = [...h.github.artifacts.values()].at(-1);
    const row = unzipSingle(art.zip).data.toString().split('\n')[1].split(',');
    assert.match(row[1], /^65000\.\d{2,}$/);
    assert.match(row[5], /^\d+\.\d+$/);
    const xau = await run(c, body('XAUUSD', '2026-09-08', '2026-09-10'));
    assert.equal(xau.status, 'READY', JSON.stringify(xau.error));
  });

  it('enforces the 5-minute expiry on the server and then deletes the artifact and run on GitHub', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    const job = await run(c, body('EUR_USD', '2026-09-01', '2026-09-03'));
    assert.equal((await c.request(job.download.url)).status, 302);

    h.clock.advance(5 * 60_000 - 1000);
    assert.equal((await c.request(job.download.url)).status, 302, 'still valid at 4:59');

    h.clock.advance(1000);
    const expired = await c.request(job.download.url);
    assert.equal(expired.status, 410);
    assert.equal(expired.json.error.message, 'This download has expired. Please generate the data again.');
    const urlsBefore = h.github.downloadUrls.length;
    await c.request(job.download.url);
    assert.equal(h.github.downloadUrls.length, urlsBefore, 'an expired token never reaches GitHub');

    const cleaned = await h.services.cleanup.runExpiredCleanup();
    assert.equal(cleaned.deleted, 1);
    assert.equal(h.github.artifacts.size, 0, 'artifact deleted');
    assert.equal(h.github.deletedRuns.length, 1, 'run deleted');
    const status = await c.request(`/api/export/status/${job.jobId}`);
    assert.equal(status.json.status, 'EXPIRED');
  });

  it('recovers the ready download after a page refresh (same browser) and not for another browser', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    const job = await run(c, body('EUR_USD', '2026-09-01', '2026-09-02'));
    const active = await c.request('/api/export/active');
    assert.equal(active.json.active.status, 'READY');
    assert.equal(active.json.active.download.url, job.download.url);
    assert.equal((await h.browser().request('/api/export/active')).json.active, null);
  });

  it('rejects wrong or guessed tokens without contacting GitHub', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    await run(c, body('EUR_USD', '2026-09-01', '2026-09-02'));
    const calls = h.github.downloadUrls.length;
    for (const t of ['short', 'A'.repeat(43), '../../etc/passwd']) assert.equal((await c.request(`/api/export/download/${t}`)).status, 404);
    assert.equal(h.github.downloadUrls.length, calls);
  });

  it('holds the global lock until the artifact exists: a second request is SYSTEM BUSY', async () => {
    h = await createHarness({ useGithub: true });
    h.config.github.runTimeoutSeconds = 0.4;
    h.github.mode = 'hang'; // the workflow never finishes
    const first = h.browser();
    const s = await first.request('/api/export', { method: 'POST', body: body('EUR_USD', '2026-09-01', '2026-09-02') });
    assert.equal(s.status, 202);
    await new Promise((r) => setTimeout(r, 100));
    const second = await h.browser().request('/api/export', { method: 'POST', body: body('EUR_USD', '2026-09-03', '2026-09-04') });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'SYSTEM_BUSY');

    const done = await h.waitForJob(first, s.json.jobId); // times out, run is cancelled, lock released
    assert.equal(done.status, 'FAILED');
    assert.match(done.error.message, /took too long/);
    assert.equal(h.github.cancelled.length, 1);

    h.github.mode = 'success';
    const retry = await run(h.browser(), body('EUR_USD', '2026-09-03', '2026-09-04'));
    assert.equal(retry.status, 'READY', 'lock was released after the failure');
  });

  it('reports a failed workflow run clearly (and keeps the run for debugging)', async () => {
    h = await createHarness({ useGithub: true });
    h.github.mode = 'fail';
    const job = await run(h.browser(), body('EUR_USD', '2026-09-01', '2026-09-02'));
    assert.equal(job.status, 'FAILED');
    assert.match(job.error.message, /could not be built/);
    assert.equal(h.github.deletedRuns.length, 0);
    assert.deepEqual(await h.storage.listObjects('exports/'), []);
  });

  it('fails cleanly when GitHub never starts the workflow', async () => {
    h = await createHarness({ useGithub: true });
    h.config.github.startTimeoutSeconds = 0.05;
    h.github.mode = 'never-starts';
    const job = await run(h.browser(), body('EUR_USD', '2026-09-01', '2026-09-02'));
    assert.equal(job.status, 'FAILED');
    assert.match(job.error.message, /did not start/);
  });

  it('the GitHub artifact ZIP contains the CSV and, when candles are missing, the missing-data .txt', async () => {
    h = await createHarness({ useGithub: true });
    h.oanda.emptyDays.add('2026-09-09');
    const job = await run(h.browser(), body('EUR_USD', '2026-09-08', '2026-09-10'));
    assert.equal(job.status, 'READY', JSON.stringify(job.error));
    const [artifact] = [...h.github.artifacts.values()];
    const names = unzipAll(artifact.zip).map((f) => f.name);
    assert.deepEqual(names, ['EUR_USD_M1_2026-09-08_2026-09-10.csv', 'EUR_USD_M1_2026-09-08_2026-09-10_missing_data.txt']);
    assert.match(unzipAll(artifact.zip)[1].data.toString(), /2026-09-09 \(Wed\)/);
  });

  it('reports "no data" before ever calling GitHub', async () => {
    h = await createHarness({ useGithub: true, binanceOpts: { listedFrom: '2026-09-10' } });
    const job = await run(h.browser(), body('LINKBTC', '2026-09-01', '2026-09-05'));
    assert.equal(job.error.code, 'NO_DATA');
    assert.equal(h.github.dispatched.length, 0);
  });

  it('keeps dataset building (R2) on the server and never leaks the token', async () => {
    h = await createHarness({ useGithub: true });
    const c = h.browser();
    await run(c, body('EUR_USD', '2026-09-01', '2026-09-02'));
    assert.ok((await h.storage.listObjects('oanda-data/')).some((o) => o.key.endsWith('/2026.bin')));
    const logs = h.logLines.map((l) => l.line).join('\n');
    assert.ok(!logs.includes('gh-test-token'));
  });
});

describe('export builder shared with the workflow script', () => {
  it('writes the CSV only from verified datasets that cover the requested days', async () => {
    h = await createHarness({ useGithub: true });
    await run(h.browser(), body('EUR_USD', '2026-09-01', '2026-09-03'));
    const dir = mkdtempSync(path.join(tmpdir(), 'exp-'));
    const out = path.join(dir, 'a.csv');
    const res = await writeExportCsv({ storage: h.storage, instrument: 'EUR_USD', timeframe: 'M1', start: '2026-09-02', end: '2026-09-03', outFile: out });
    assert.ok(res.rows > 0);
    assert.equal(readFileSync(out, 'utf8').split('\n')[1].split(',')[0], '2026-09-02T00:00:00Z');

    // retrieved only through Sep 13 (the whole year so far): the CSV holds what exists and the notes say so (no error)
    const part = await writeExportCsv({ storage: h.storage, instrument: 'EUR_USD', timeframe: 'M1', start: '2026-09-02', end: '2026-09-20', outFile: out });
    assert.ok(part.rows > res.rows);
    assert.ok(part.notes.some((n) => /retrieved only through 2026-09-13/.test(n)));
    // a year that was never built has nothing to write
    await assert.rejects(writeExportCsv({ storage: h.storage, instrument: 'EUR_USD', timeframe: 'M1', start: '2025-09-02', end: '2025-09-05', outFile: out }), /no candles/);
    // a tampered dataset is refused
    const key = 'oanda-data/EUR_USD/M1/2026.bin';
    const buf = Buffer.from(await h.storage.getObjectBuffer(key));
    buf[buf.length - 3] ^= 0xff;
    await h.storage.putObject(key, buf, {});
    await assert.rejects(writeExportCsv({ storage: h.storage, instrument: 'EUR_USD', timeframe: 'M1', start: '2026-09-02', end: '2026-09-03', outFile: out }), ExportFileError);
    await assert.rejects(writeExportCsv({ storage: h.storage, instrument: 'NOPE', timeframe: 'M1', start: '2026-09-02', end: '2026-09-03', outFile: out }), /unsupported/);
  });
});

describe('GitHub REST client', () => {
  const cfg = { token: 'ghp_tok', repo: 'octo/app', workflow: 'export-csv.yml', ref: 'main', apiBase: 'https://api.github.test', requestTimeoutMs: 2000 };
  const resp = (status, json = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => json });

  it('dispatches with the token, API version and the expected body', async () => {
    const seen = [];
    const client = createGithubClient({ github: cfg, logger: silentLogger(), fetchImpl: async (url, init) => (seen.push({ url, init }), resp(204)) });
    await client.dispatch({ export_id: 'abc', instrument: 'EUR_USD' });
    assert.equal(seen[0].url, 'https://api.github.test/repos/octo/app/actions/workflows/export-csv.yml/dispatches');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer ghp_tok');
    assert.equal(seen[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.deepEqual(JSON.parse(seen[0].init.body), { ref: 'main', inputs: { export_id: 'abc', instrument: 'EUR_USD' } });
  });

  it('finds a run by its run-name, reads status, and lists artifacts', async () => {
    const client = createGithubClient({
      github: cfg,
      logger: silentLogger(),
      fetchImpl: async (url) => {
        if (url.includes('/workflows/export-csv.yml/runs')) return resp(200, { workflow_runs: [{ id: 1, display_title: 'export other' }, { id: 2, display_title: 'export abc' }] });
        if (url.endsWith('/actions/runs/2')) return resp(200, { id: 2, status: 'completed', conclusion: 'success' });
        if (url.endsWith('/actions/runs/2/artifacts')) return resp(200, { artifacts: [{ id: 9, name: 'n', size_in_bytes: 123, expired: false }] });
        throw new Error(url);
      },
    });
    assert.equal((await client.findRun('export abc')).id, 2);
    assert.equal(await client.findRun('export nope'), null);
    assert.deepEqual(await client.getRun(2), { id: 2, status: 'completed', conclusion: 'success' });
    assert.deepEqual(await client.listRunArtifacts(2), [{ id: 9, name: 'n', size: 123, expired: false }]);
  });

  it('returns the signed URL from the 302 (without following it), and null when the artifact is gone', async () => {
    let redirect;
    const client = createGithubClient({
      github: cfg,
      logger: silentLogger(),
      fetchImpl: async (url, init) => {
        redirect = init.redirect;
        if (url.endsWith('/artifacts/7/zip')) return resp(302, {}, { location: 'https://pipelines.example/blob?sig=1' });
        if (url.endsWith('/artifacts/8/zip')) return resp(410);
        if (url.endsWith('/artifacts/6/zip')) return resp(302, {}, { location: 'http://insecure.example/x' });
        return resp(404);
      },
    });
    assert.equal(await client.getArtifactDownloadUrl(7), 'https://pipelines.example/blob?sig=1');
    assert.equal(redirect, 'manual');
    assert.equal(await client.getArtifactDownloadUrl(8), null);
    assert.equal(await client.getArtifactDownloadUrl(404), null);
    assert.equal(await client.getArtifactDownloadUrl(6), null, 'only https URLs are ever handed to a browser');
  });

  it('tolerates already-deleted artifacts/runs and retries transient 5xx', async () => {
    let n = 0;
    const client = createGithubClient({
      github: cfg,
      logger: silentLogger(),
      fetchImpl: async (url, init) => {
        if (init.method === 'DELETE') return resp(404);
        n++;
        return n < 2 ? resp(502) : resp(200, { id: 1, status: 'queued', conclusion: null });
      },
    });
    await client.deleteArtifact(1);
    await client.deleteRun(1);
    assert.equal((await client.getRun(1)).status, 'queued');
    assert.equal(n, 2);
    const broken = createGithubClient({ github: cfg, logger: silentLogger(), fetchImpl: async () => resp(401) });
    await assert.rejects(broken.getRun(1), /HTTP 401/);
  });

  it('keys round-trip and reject anything else', () => {
    assert.equal(githubKey(12, 34), 'gh:12:34');
    assert.deepEqual(parseGithubKey('gh:12:34'), { runId: 12, artifactId: 34 });
    for (const bad of ['exports/abc.zip', 'gh:1', 'gh:a:b', 'gh:1:2:3', '', null, undefined, 'x gh:1:2']) assert.equal(parseGithubKey(bad), null);
  });
});
