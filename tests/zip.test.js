import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { zipFiles, zipSingleFile } from '../backend/lib/zip.js';
import { createHarness } from './helpers/harness.js';
import { unzipAll, unzipSingle } from './helpers/unzip.js';

let h;
afterEach(async () => {
  const done = h;
  h = null;
  await done?.close();
});

async function collect(gen) {
  const parts = [];
  for await (const p of gen) parts.push(p);
  return Buffer.concat(parts);
}
async function* chunks(...parts) {
  for (const p of parts) yield Buffer.from(p);
}

describe('zip writer', () => {
  it('round-trips content, name and CRC (own reader)', async () => {
    const text = 'timestamp,open\n'.repeat(5000);
    const zip = await collect(zipSingleFile('a_b.csv', chunks(text.slice(0, 1234), text.slice(1234)), Date.UTC(2026, 8, 14, 12, 30, 10)));
    const out = unzipSingle(zip);
    assert.equal(out.entries, 1);
    assert.equal(out.name, 'a_b.csv');
    assert.equal(out.data.toString(), text);
    assert.ok(zip.length < text.length / 10, 'actually compressed');
  });

  it('handles empty and large inputs', async () => {
    assert.equal(unzipSingle(await collect(zipSingleFile('e.csv', chunks(), 0))).data.length, 0);
    const big = Buffer.alloc(30_000_000, 'x');
    async function* many() {
      for (let i = 0; i < big.length; i += 1_000_000) yield big.subarray(i, i + 1_000_000);
    }
    assert.equal(unzipSingle(await collect(zipSingleFile('big.csv', many(), 0))).data.length, big.length);
  });

  it('is readable by independent tools (unzip -t and Python zipfile)', async () => {
    const text = 'timestamp,open,high,low,close,volume\n2026-09-01T00:00:00Z,1.1,1.2,1.0,1.1,5\n';
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'zip-')), 'x.zip');
    writeFileSync(file, await collect(zipSingleFile('EUR_USD_M1_2026-09-01_2026-09-01.csv', chunks(text), Date.now())));
    const py = execFileSync('python3', ['-I', '-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.namelist()[0]);print(z.read(z.namelist()[0]).decode(),end="")', file]).toString();
    assert.equal(py, `EUR_USD_M1_2026-09-01_2026-09-01.csv\n${text}`);
    const unzip = spawnSync('unzip', ['-t', file]);
    if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout?.toString());
  });

  it('a two-entry archive (CSV + missing-data .txt) is valid for independent tools', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'zip2-')), 'two.zip');
    writeFileSync(file, await collect(zipFiles([{ name: 'a.csv', source: chunks('x,y\n1,2\n') }, { name: 'a_missing_data.txt', source: chunks('MISSING DATA REPORT\n') }], Date.now())));
    const py = execFileSync('python3', ['-I', '-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.namelist());print(z.read("a_missing_data.txt").decode(),end="")', file]).toString();
    assert.equal(py, "['a.csv', 'a_missing_data.txt']\nMISSING DATA REPORT\n");
    const unzip = spawnSync('unzip', ['-t', file]);
    if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout?.toString());
    assert.deepEqual(unzipAll(readFileSync(file)).map((f) => f.name), ['a.csv', 'a_missing_data.txt']);
  });

  it('propagates a source failure and releases resources when the consumer stops early', async () => {
    async function* failing() {
      yield Buffer.from('ok');
      throw new Error('source broke');
    }
    await assert.rejects(collect(zipSingleFile('f.csv', failing(), 0)), /source broke/);

    async function* endless() {
      for (;;) yield Buffer.alloc(100_000, 'y');
    }
    const it = zipSingleFile('g.csv', endless(), 0);
    await it.next();
    await it.next();
    await it.return(); // consumer walks away; must not hang
  });
});

describe('exports are always delivered as .zip', () => {
  it('serves a valid zip whose first entry is the CSV named after the request (plus the missing-data .txt when data is missing)', async () => {
    h = await createHarness();
    const c = h.browser();
    const start = await c.request('/api/export', { method: 'POST', body: { instrument: 'EUR_USD', timeframe: 'M1', start_date: '2026-09-01', end_date: '2026-09-03' } });
    const job = await h.waitForJob(c, start.json.jobId);
    assert.equal(job.status, 'READY');
    assert.match(job.download.filename, /\.zip$/);
    const res = await c.request(job.download.url);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(Number(res.headers.get('content-length')), res.body.length);
    assert.equal(res.body.length, job.download.fileSize);
    const zip = unzipSingle(res.body);
    assert.ok(zip.entries === 1 || zip.entries === 2);
    if (zip.entries === 2) assert.deepEqual(unzipAll(res.body).map((f) => f.name), ['EUR_USD_M1_2026-09-01_2026-09-03.csv', 'EUR_USD_M1_2026-09-01_2026-09-03_missing_data.txt']);
    assert.equal(zip.name, 'EUR_USD_M1_2026-09-01_2026-09-03.csv');
    assert.equal(zip.data.toString().split('\n')[0], 'timestamp,open,high,low,close,volume');
    assert.equal(res.body.subarray(0, 2).toString(), 'PK');
  });
});
