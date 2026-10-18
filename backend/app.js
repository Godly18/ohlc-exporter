// HTTP request handler (plain node:http, no framework).
//
// /health is dispatched FIRST, synchronously, before any other logic: no body parsing, no session,
// no rate limiting, no HTTPS redirect, no database, no R2, no OANDA, no job lock. It therefore
// answers even while the service is still starting, mid-export, or when dependencies are down.

import { fileURLToPath } from 'node:url';
import { Errors, AppError } from './lib/errors.js';
import { createRoutes } from './api/routes.js';
import { clientIp, createRateLimiter, ensureSession, sendError, sendJson, setSecurityHeaders } from './middleware/http.js';
import { createStaticHandler } from './middleware/static.js';

const FRONTEND_DIR = fileURLToPath(new URL('../frontend/', import.meta.url));

function sendHealth(req, res) {
  try {
    const body = JSON.stringify({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    try {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } catch {
      /* socket already gone */
    }
  }
}

/** Mask secrets in a URL path before logging it. */
const maskPath = (p) => p.replace(/^(\/api\/export\/download\/).+$/, '$1[redacted]');

export function createApp(ctx) {
  const { config, logger } = ctx;
  const routes = createRoutes(ctx);
  const limiter = createRateLimiter({ windowMs: config.rateLimit.windowMs, hops: config.trustProxyHops });
  const serveStatic = createStaticHandler(FRONTEND_DIR);

  async function dispatch(req, res, pathname) {
    setSecurityHeaders(res, { hsts: config.forceHttps });

    if (config.forceHttps && req.headers['x-forwarded-proto'] === 'http') {
      res.writeHead(308, { Location: `https://${req.headers.host}${req.url}` });
      res.end();
      return;
    }

    if (!pathname.startsWith('/api/')) {
      if (!(await serveStatic(req, res, pathname))) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return;
    }

    if (!limiter.allow(req, 'api', config.rateLimit.apiPerWindow)) throw Errors.tooManyRequests();

    let route = null;
    let param = null;
    let pathMatched = false;
    for (const r of routes) {
      const hit = r.path ? r.path === pathname : pathname.startsWith(r.prefix) && pathname.length > r.prefix.length;
      if (!hit) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      route = r;
      param = r.prefix ? pathname.slice(r.prefix.length) : null;
      break;
    }
    if (!route) {
      if (pathMatched) throw new AppError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      throw Errors.notFound();
    }
    if (route.limitBucket && !limiter.allow(req, route.limitBucket, config.rateLimit.exportPerWindow)) {
      throw Errors.tooManyRequests();
    }

    const sessionHash = ensureSession(req, res, { secure: config.forceHttps });
    await route.handle(req, res, { sessionHash, param });
  }

  const handler = function handler(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];

    // ---- liveness: must never depend on anything else --------------------------------------
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendHealth(req, res);
      return;
    }

    const started = Date.now();
    if (pathname.startsWith('/api/')) {
      res.on('finish', () =>
        logger.info('request', {
          method: req.method,
          path: maskPath(pathname),
          status: res.statusCode,
          ms: Date.now() - started,
          ip: clientIp(req, config.trustProxyHops),
        }),
      );
    }
    dispatch(req, res, pathname).catch((err) => sendError(res, err, logger));
  };

  handler.stop = () => limiter.stop();
  return handler;
}
