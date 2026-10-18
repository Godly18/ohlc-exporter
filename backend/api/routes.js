// API route handlers. Each returns after writing the response; thrown AppErrors become JSON errors.

import { pipeline } from 'node:stream/promises';
import { listInstruments, listTimeframes } from '../config/catalog.js';
import { Errors } from '../lib/errors.js';
import { JOB_ID_RE } from '../lib/tokens.js';
import { latestCompletedDay } from '../lib/time.js';
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
          instruments: listInstruments(),
          timeframes: listTimeframes(),
          exportExpirationMinutes: config.exportExpirationMinutes,
          minDataYear: config.minDataYear,
          maxExportDays: config.maxExportDays,
          latestSelectableDate: latestCompletedDay(ctx.clock()),
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
        const obj = await svc().storage.getObjectStream(row.objectKey);
        if (!obj) throw Errors.expired();
        const filename = `${row.instrument}_${row.timeframe}_${row.startDate}_${row.endDate}.csv`;
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
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
