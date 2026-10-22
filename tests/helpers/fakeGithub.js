// Fake GitHub Actions: same interface as services/github/client.js. A "dispatch" really runs the export
// builder (the same code scripts/export-csv.js runs) against the in-memory R2 and stores the result as an
// artifact (a zip containing the CSV, like GitHub delivers).

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipFiles } from '../../backend/lib/zip.js';
import { runRemoteExport, runRemoteMaintenance } from '../../backend/workers/remoteJob.js';

/**
 * A "dispatch" really runs what scripts/workflow-job.js runs on GitHub (retrieval from the fake providers into
 * the in-memory R2, then the CSV build) and stores the output as an artifact (a zip, like GitHub delivers).
 * Call attach() once the services exist (the harness does).
 */
export function createFakeGithub({ storage }) {
  let nextRun = 1000;
  let nextArtifact = 5000;
  let env = null;
  const fake = {
    attach(e) {
      env = e;
    },
    runs: new Map(), // id -> { id, title, status, conclusion, inputs, controller }
    artifacts: new Map(), // id -> { id, name, zip: Buffer, runId }
    dispatched: [],
    calls: [],
    downloadUrls: [],
    mode: 'success', // 'success' | 'fail' (crashes without a result) | 'hang' | 'never-starts'
    pollsUntilDone: 1,
    startDelayMs: 0, // delay before the "workflow" starts working (lets tests cancel mid-run)
    deletedArtifacts: [],
    deletedRuns: [],
    cancelled: [],

    async dispatch(inputs) {
      fake.calls.push('dispatch');
      fake.dispatched.push(inputs);
      if (fake.mode === 'never-starts') return;
      const controller = new AbortController();
      const run = { id: nextRun++, title: `export ${inputs.export_id}`, status: 'queued', conclusion: null, polls: 0, inputs, controller };
      fake.runs.set(run.id, run);
      const work = async () => {
        if (fake.mode === 'hang') return;
        if (fake.startDelayMs) await new Promise((r) => setTimeout(r, fake.startDelayMs));
        try {
          if (fake.mode === 'fail') throw new Error('simulated crash');
          if (controller.signal.aborted) throw new Error('cancelled');
          if (inputs.mode === 'maintenance') {
            await runRemoteMaintenance({ maintenance: env.services.maintenance, signal: controller.signal, logger: env.logger });
            run.conclusion = 'success';
            return;
          }
          const dir = mkdtempSync(path.join(tmpdir(), 'gh-'));
          const result = await runRemoteExport({
            job: {
              jobId: inputs.job_id,
              exportId: inputs.export_id,
              artifactName: inputs.artifact_name,
              lastDay: inputs.last_day,
              instrument: inputs.instrument,
              timeframe: inputs.timeframe,
              start: inputs.start_date,
              end: inputs.end_date,
            },
            datasetService: env.services.datasetService,
            exportsRepo: env.services.exportsRepo,
            storage,
            config: { ...env.config, extraClosedDates: new Set() },
            logger: env.logger,
            signal: controller.signal,
            outDir: dir,
          });
          if (!result.ok) throw new Error(`workflow reported ${result.code}`);
          const entries = readdirSync(dir).map((name) => ({ name, source: [readFileSync(path.join(dir, name))] }));
          const parts = [];
          for await (const p of zipFiles(entries, Date.now())) parts.push(p);
          const id = nextArtifact++;
          fake.artifacts.set(id, { id, name: inputs.artifact_name, zip: Buffer.concat(parts), runId: run.id });
          run.conclusion = 'success';
        } catch (err) {
          run.error = err;
          run.conclusion = controller.signal.aborted ? 'cancelled' : 'failure';
        }
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
      fake.runs.get(id)?.controller.abort(new Error('cancelled'));
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
