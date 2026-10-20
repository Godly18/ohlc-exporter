// Minimal GitHub REST client for the export offload (Actions workflow dispatch, run status, artifacts).
// Needs a fine-grained token limited to the one repository with "Actions: Read and write".

import { SourceError } from '../../lib/errors.js';

export function createGithubClient({ github, logger, fetchImpl = globalThis.fetch }) {
  const base = `${github.apiBase}/repos/${github.repo}`;
  const workflow = encodeURIComponent(github.workflow);

  async function call(method, path, { body, manual = false, okStatuses = [] } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(`${base}${path}`, {
          method,
          redirect: manual ? 'manual' : 'follow',
          headers: {
            Authorization: `Bearer ${github.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'oanda-ohlc-exporter',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(github.requestTimeoutMs),
        });
        if (res.status >= 500 || res.status === 429) {
          lastErr = new SourceError(`GitHub responded with HTTP ${res.status}`, { status: res.status, retryable: true });
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        if (res.ok || manual && res.status === 302 || okStatuses.includes(res.status)) return res;
        throw new SourceError(`GitHub responded with HTTP ${res.status}`, { status: res.status });
      } catch (err) {
        if (err instanceof SourceError && !err.retryable) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr instanceof SourceError ? lastErr : new SourceError('GitHub request failed');
  }

  return {
    /** Start the export workflow. */
    async dispatch(inputs) {
      await call('POST', `/actions/workflows/${workflow}/dispatches`, { body: { ref: github.ref, inputs } });
    },

    /** Find the run whose run-name is `title` (the workflow sets run-name: "export <id>"). */
    async findRun(title) {
      const res = await call('GET', `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`);
      const json = await res.json();
      return (json.workflow_runs ?? []).find((r) => r.display_title === title) ?? null;
    },

    async getRun(runId) {
      const res = await call('GET', `/actions/runs/${Number(runId)}`);
      const r = await res.json();
      return { id: r.id, status: r.status, conclusion: r.conclusion };
    },

    async listRunArtifacts(runId) {
      const res = await call('GET', `/actions/runs/${Number(runId)}/artifacts`);
      const json = await res.json();
      return (json.artifacts ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size_in_bytes, expired: !!a.expired }));
    },

    /** Short-lived signed download URL for an artifact (GitHub answers 302; we hand the URL to the browser). */
    async getArtifactDownloadUrl(artifactId) {
      let res;
      try {
        res = await call('GET', `/actions/artifacts/${Number(artifactId)}/zip`, { manual: true, okStatuses: [404, 410] });
      } catch (err) {
        if (err?.status === 404 || err?.status === 410) return null;
        throw err;
      }
      if (res.status === 404 || res.status === 410) return null;
      const location = res.headers.get('location');
      return location && location.startsWith('https://') ? location : null;
    },

    async cancelRun(runId) {
      await call('POST', `/actions/runs/${Number(runId)}/cancel`, { okStatuses: [409, 404] }).catch((err) =>
        logger.warn('could not cancel workflow run', { runId, error: err }),
      );
    },

    async deleteArtifact(artifactId) {
      await call('DELETE', `/actions/artifacts/${Number(artifactId)}`, { okStatuses: [404, 410] });
    },

    async deleteRun(runId) {
      await call('DELETE', `/actions/runs/${Number(runId)}`, { okStatuses: [404, 409] });
    },

    /** Smoke check: can the token see the workflow? */
    async checkWorkflow() {
      const res = await call('GET', `/actions/workflows/${workflow}`);
      const w = await res.json();
      return { state: w.state, path: w.path };
    },
  };
}

/** Object keys for GitHub-hosted exports are stored in exports.object_key as gh:<runId>:<artifactId>. */
export const githubKey = (runId, artifactId) => `gh:${Number(runId)}:${Number(artifactId)}`;
export function parseGithubKey(key) {
  const m = typeof key === 'string' ? /^gh:(\d{1,20}):(\d{1,20})$/.exec(key) : null;
  return m ? { runId: Number(m[1]), artifactId: Number(m[2]) } : null;
}
