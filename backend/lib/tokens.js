// Identifier and token helpers. Everything security-relevant is derived from node:crypto.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** 192-bit random id, URL/key safe. Used for export object keys. */
export const newExportId = () => randomBytes(24).toString('base64url');

export const newJobId = () => randomUUID();

/** 256-bit random browser session id (stored hashed server-side). */
export const newSessionId = () => randomBytes(32).toString('base64url');

/**
 * Download token = HMAC-SHA256(secret, exportId), base64url (43 chars). Unguessable without the
 * server secret, deterministic so the server can re-issue it to the owning session after a page
 * refresh WITHOUT storing it: the database only keeps sha256(token).
 */
export function deriveDownloadToken(secret, exportId) {
  return createHmac('sha256', secret).update(`download:${exportId}`).digest('base64url');
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_RE = /^[A-Za-z0-9_-]{32,64}$/;
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EXPORT_ID_RE = /^[A-Za-z0-9_-]{32}$/;

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
