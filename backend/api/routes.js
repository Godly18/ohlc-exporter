// API route handlers. Each returns after writing the response; thrown AppErrors become JSON errors.

import { pipeline } from 'node:stream/promises';
import { effectiveMinYear, listInstrumentEntries, listTimeframes, providerAvailable } from '../config/catalog.js';
import { Errors } from '../lib/errors.js';
import { parseGithubKey } from '../services/github/client.js';
import { JOB_ID_RE } from '../lib/tokens.js';
import { latestFetchableDay } from '../lib/time.js';
import { readJsonBody, sendJson } from '../middleware/http.js';

export function createRoutes(ctx) {
  const { config, state } = ctx;
  const svc = () => ctx.services;

  /** Everything except /api/config needs the backing services. */
  const requireReady = () => {
    if (state.ready) return;
    throw state.missing.length > 0 ? Errors.misconfigured() : Errors.starting();
  };

  return [
    {
      method: 'GET',
      path: '/api/config',
      async handle(_req, res) {
        // Public, non-secret configuration only.
        sendJson(res, 200, {
          instruments: listInstrumentEntries()
            .filter((i) => providerAvailable(i, config))
            .map((i) => ({ code: i.code, label: i.label, group: i.group, minYear: effectiveMinYear(i, config) })),
          timeframes: listTimeframes(),
          exportExpirationMinutes: config.exportExpirationMinutes,
          minDataYear: config.minDataYear,
          maxExportYears: config.maxExportYears,
          // The newest day the server will accept: yesterday (UTC), once it has settled. Today is never offered.
          latestSelectableDate: latestFetchableDay(ctx.clock(), config.daySettleMinutes),
          serverTime: new Date(ctx.clock()).toISOString(),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/status',
      async handle(_req, res) {
        requireReady();
        const current = await svc().lock.current();
        sendJson(res, 200, { busy: !!current && !current.stale, serverTime: new Date(ctx.clock()).toISOString() });
      },
    },
    {
      method: 'POST',
      path: '/api/export',
      limitBucket: 'export',
      async handle(req, res, { sessionHash }) {
        requireReady();
        const body = await readJsonBody(req);
        const job = await svc().exportService.createExport({ sessionHash, body });
        sendJson(res, 202, job);
      },
    },
    {
      method: 'GET',
      path: '/api/export/active',
      async handle(_req, res, { sessionHash }) {
        requireReady();
        sendJson(res, 200, await svc().exportService.getActive(sessionHash));
      },
    },
    {
      method: 'POST',
      prefix: '/api/export/cancel/',
      async handle(req, res, { sessionHash, param }) {
        requireReady();
        if (!JOB_ID_RE.test(param)) throw Errors.notFound();
        sendJson(res, 200, await svc().exportService.cancel(param, sessionHash));
      },
    },
    {
      method: 'GET',
      prefix: '/api/export/status/',
      async handle(_req, res, { sessionHash, param }) {
        requireReady();
        if (!JOB_ID_RE.test(param)) throw Errors.notFound();
        sendJson(res, 200, await svc().exportService.getStatus(param, sessionHash));
      },
    },
    {
      method: 'GET',
      prefix: '/api/export/download/',
      async handle(_req, res, { param }) {
        requireReady();
        const row = await svc().exportService.authorizeDownload(param); // enforces token + expiry
        const gh = parseGithubKey(row.objectKey);
        if (gh) {
          // GitHub-hosted export: the token and the 5-minute expiry were verified above; now send the browser
          // straight to GitHub's short-lived signed URL, so the file never passes through this server.
          const url = await svc().github?.getArtifactDownloadUrl(gh.artifactId);
          if (!url) throw Errors.expired();
          res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          res.end();
          return;
        }
        const obj = await svc().storage.getObjectStream(row.objectKey);
        if (!obj) throw Errors.expired();
        const filename = `${row.instrument}_${row.timeframe}_${row.startDate}_${row.endDate}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
          ...(obj.size != null ? { 'Content-Length': obj.size } : {}),
        });
        try {
          await pipeline(obj.stream, res);
        } catch (err) {
          ctx.logger.warn('download stream interrupted', { error: err });
          res.destroy();
        }
      },
    },
  ];
}
