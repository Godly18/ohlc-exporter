// Small HTTP helpers: JSON responses, body parsing, cookies/session, security headers, rate limiting.

import { Errors } from '../lib/errors.js';
import { newSessionId, SESSION_RE, sha256Hex } from '../lib/tokens.js';

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, err, logger) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err && err.name === 'AppError') {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
  }
  logger?.error('unhandled request error', { error: err });
  return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again later.' } });
}

export function setSecurityHeaders(res, { hsts }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Read and parse a small JSON body (hard size cap, JSON content type required). */
export function readJsonBody(req, limitBytes = 4096) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) return reject(Errors.invalidRequest('Content-Type must be application/json.'));
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Errors.invalidRequest('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(Errors.invalidRequest('Request body is not valid JSON.'));
      }
    });
    req.on('error', () => reject(Errors.invalidRequest()));
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Anonymous browser session: random id in an HttpOnly, SameSite=Strict cookie. It lets a page
 * refresh recover that browser's own export without accounts. Only sha256(id) is stored server-side.
 */
export function ensureSession(req, res, { secure }) {
  let sid = parseCookies(req.headers.cookie).sid;
  if (!sid || !SESSION_RE.test(sid)) {
    sid = newSessionId();
    const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${60 * 60 * 24 * 30}`];
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', `sid=${sid}; ${attrs.join('; ')}`);
  }
  return sha256Hex(sid);
}

export function clientIp(req, hops) {
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops > 0 && xff.length > 0) return xff[Math.max(0, xff.length - hops)];
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Fixed-window in-memory rate limiter, keyed per bucket + client IP. Never applied to /health. */
export function createRateLimiter({ windowMs, hops }) {
  const hits = new Map();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  prune.unref?.();

  return {
    /** @returns {boolean} true if the request is allowed */
    allow(req, bucket, limit) {
      const key = `${bucket}:${clientIp(req, hops)}`;
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= limit;
    },
    stop: () => clearInterval(prune),
  };
}
