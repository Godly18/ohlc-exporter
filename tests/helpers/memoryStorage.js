// In-memory object store implementing the same interface as the R2 adapter, with failure injection.
// It enforces the same key safety rules as production (assertSafeKey).

import { Readable } from 'node:stream';
import { assertSafeKey } from '../../backend/services/r2/keys.js';

export function createMemoryStorage(clock = () => Date.now()) {
  const objects = new Map(); // key -> { buf, lastModified }
  const hooks = { failOn: null }; // (op, key) => void, may throw to simulate an outage / crash
  const ops = [];

  const guard = (op, key) => {
    assertSafeKey(key);
    ops.push(`${op}:${key}`);
    hooks.failOn?.(op, key);
  };

  return {
    kind: 'memory',
    objects,
    hooks,
    ops,

    async putObject(key, body) {
      guard('put', key);
      objects.set(key, { buf: Buffer.from(body), lastModified: clock() });
    },

    async putChunks(key, iterable) {
      guard('putChunks', key);
      const chunks = [];
      for await (const chunk of iterable) {
        chunks.push(Buffer.from(chunk));
        hooks.failOn?.('putChunks:chunk', key);
      }
      objects.set(key, { buf: Buffer.concat(chunks), lastModified: clock() });
    },

    async getObjectBuffer(key) {
      guard('get', key);
      const o = objects.get(key);
      return o ? Buffer.from(o.buf) : null;
    },

    async getObjectStream(key) {
      guard('getStream', key);
      const o = objects.get(key);
      return o ? { stream: Readable.from([o.buf]), size: o.buf.length } : null;
    },

    async headObject(key) {
      guard('head', key);
      const o = objects.get(key);
      return o ? { size: o.buf.length, lastModified: o.lastModified } : null;
    },

    async copyObject(src, dst) {
      guard('copy', dst);
      assertSafeKey(src);
      const o = objects.get(src);
      if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      objects.set(dst, { buf: Buffer.from(o.buf), lastModified: clock() });
    },

    async deleteObject(key) {
      guard('delete', key);
      objects.delete(key);
    },

    async listObjects(prefix) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.buf.length, lastModified: o.lastModified }));
    },

    keys: (prefix = '') => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}
