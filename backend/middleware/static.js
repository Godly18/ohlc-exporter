// Static file server for the frontend. Path-traversal safe: the resolved path must stay inside root,
// and only known file types are served.

import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function createStaticHandler(rootDir) {
  const root = resolve(rootDir);
  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = resolve(root, `.${rel}`);
    if (full !== root && !full.startsWith(root + sep)) return false;
    const type = TYPES[extname(full).toLowerCase()];
    if (!type) return false;
    let data;
    try {
      data = await readFile(full);
    } catch {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  };
}
