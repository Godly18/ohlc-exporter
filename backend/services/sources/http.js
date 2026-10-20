// Shared polite HTTP requester for the market-data providers: spaced-out requests, timeouts and bounded
// retries (network errors, 429/418 and 5xx only; Retry-After honoured). No infinite loops, never retries
// once the caller has cancelled.

import { SourceError } from '../../lib/errors.js';
import { sleep } from '../../lib/yield.js';

export function createRequester({ name, delayMs, timeoutMs, maxRetries, logger, fetchImpl = globalThis.fetch, sleepFn = sleep, clock = Date.now }) {
  let lastRequestAt = 0;

  async function throttle(signal) {
    const wait = lastRequestAt + delayMs - clock();
    if (wait > 0) await sleepFn(wait, signal);
    lastRequestAt = clock();
  }

  /**
   * @param {string} url
   * @param {{signal?: AbortSignal, headers?: object, as?: 'json'|'text'|'buffer', notFoundOk?: boolean, maxBytes?: number}} opts
   * @returns parsed body, or null for a tolerated 404
   */
  async function get(url, { signal, headers = {}, as = 'json', notFoundOk = false, maxBytes = 100 * 1024 * 1024 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await throttle(signal);
      let retryAfterMs = 0;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const res = await fetchImpl(url, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        if (res.ok) {
          if (as === 'json') return await res.json();
          if (as === 'text') return await res.text();
          const declared = Number(res.headers?.get?.('content-length'));
          if (Number.isFinite(declared) && declared > maxBytes) throw new SourceError(`${name} response too large`, { retryable: false });
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) throw new SourceError(`${name} response too large`, { retryable: false });
          return buf;
        }
        if (res.status === 404 && notFoundOk) return null;

        const retryable = res.status === 429 || res.status === 418 || res.status >= 500;
        const header = Number(res.headers?.get?.('retry-after'));
        if (Number.isFinite(header) && header > 0) retryAfterMs = Math.min(header * 1000, 60_000);
        throw new SourceError(`${name} responded with HTTP ${res.status}`, { status: res.status, retryable });
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err; // caller cancelled: never retry
        const retryable = err instanceof SourceError ? err.retryable : true; // network error / timeout / bad body
        if (!retryable || attempt >= maxRetries) {
          if (err instanceof SourceError) throw err;
          throw new SourceError(`${name} request failed after ${attempt + 1} attempt(s): ${err?.name ?? 'error'}`, { retryable: false });
        }
        const backoff = retryAfterMs || Math.min(500 * 2 ** attempt, 10_000);
        logger?.warn(`${name} request failed; retrying`, { attempt: attempt + 1, of: maxRetries, backoffMs: backoff, error: err });
        await sleepFn(backoff, signal);
      }
    }
  }

  return { get };
}
