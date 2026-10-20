// Fake GitHub Actions: same interface as services/github/client.js. A "dispatch" really runs the export
// builder (the same code scripts/export-csv.js runs) against the in-memory R2 and stores the result as an
// artifact (a zip containing the CSV, like GitHub delivers).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeExportCsv } from '../../backend/lib/exportFile.js';
import { zipSingleFile } from '../../backend/lib/zip.js';

export function createFakeGithub({ storage }) {
  let nextRun = 1000;
  let nextArtifact = 5000;
  const fake = {
    runs: new Map(), // id -> { id, title, status, conclusion, artifactName, artifactId, error }
    artifacts: new Map(), // id -> { id, name, zip: Buffer, runId }
    dispatched: [],
    calls: [],
    downloadUrls: [],
    mode: 'success', // 'success' | 'fail' | 'hang' | 'never-starts'
    pollsUntilDone: 1,
    deletedArtifacts: [],
    deletedRuns: [],
    cancelled: [],

    async dispatch(inputs) {
      fake.calls.push('dispatch');
      fake.dispatched.push(inputs);
      if (fake.mode === 'never-starts') return;
      const run = { id: nextRun++, title: `export ${inputs.export_id}`, status: 'queued', conclusion: null, polls: 0, inputs };
      fake.runs.set(run.id, run);
      const work = async () => {
        if (fake.mode === 'hang') return;
        try {
          if (fake.mode === 'fail') throw new Error('simulated failure');
          const dir = mkdtempSync(path.join(tmpdir(), 'gh-'));
          const outFile = path.join(dir, `${inputs.artifact_name}.csv`);
          await writeExportCsv({
            storage,
            instrument: inputs.instrument,
            timeframe: inputs.timeframe,
            start: inputs.start_date,
            end: inputs.end_date,
            outFile,
          });
          const csv = readFileSync(outFile);
          const parts = [];
          async function* one() {
            yield csv;
          }
          for await (const p of zipSingleFile(`${inputs.artifact_name}.csv`, one(), Date.now())) parts.push(p);
          const id = nextArtifact++;
          fake.artifacts.set(id, { id, name: inputs.artifact_name, zip: Buffer.concat(parts), runId: run.id });
          run.conclusion = 'success';
        } catch (err) {
          run.error = err;
          run.conclusion = 'failure';
        }
        run.ready = true;
      };
      run.done = work();
    },

    async findRun(title) {
      fake.calls.push('findRun');
      for (const r of fake.runs.values()) if (r.title === title) return { id: r.id, display_title: r.title };
      return null;
    },

    async getRun(id) {
      fake.calls.push('getRun');
      const r = fake.runs.get(id);
      if (!r) throw new Error('unknown run');
      if (fake.mode === 'hang') {
        r.status = 'in_progress';
        return { id, status: r.status, conclusion: null };
      }
      r.polls++;
      await r.done;
      r.status = r.polls > fake.pollsUntilDone ? 'completed' : r.polls === 1 ? 'queued' : 'in_progress';
      return { id, status: r.status, conclusion: r.status === 'completed' ? r.conclusion : null };
    },

    async listRunArtifacts(runId) {
      return [...fake.artifacts.values()].filter((a) => a.runId === runId).map((a) => ({ id: a.id, name: a.name, size: a.zip.length, expired: false }));
    },

    async getArtifactDownloadUrl(id) {
      const a = fake.artifacts.get(id);
      if (!a) return null;
      const url = `https://blob.example.test/artifact/${id}?sig=abc`;
      fake.downloadUrls.push(url);
      return url;
    },

    async cancelRun(id) {
      fake.cancelled.push(id);
    },
    async deleteArtifact(id) {
      fake.deletedArtifacts.push(id);
      fake.artifacts.delete(id);
    },
    async deleteRun(id) {
      fake.deletedRuns.push(id);
      fake.runs.delete(id);
    },
  };
  return fake;
}
