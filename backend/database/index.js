// Database adapters. Both expose the same tiny interface:
//   query(sql, params) -> { rows, rowCount }     exec(sql)     close()
// SQL uses $1, $2 ... placeholders (PostgreSQL style); the SQLite adapter rewrites them to ?1, ?2.

import { SCHEMA } from './schema.js';

/** Production adapter: PostgreSQL via `pg` (imported lazily). */
export async function createPgDb({ connectionString, ssl = false, onError = () => {} }) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle-client error would otherwise be an unhandled 'error' event and crash the process.
  pool.on('error', (err) => onError(err));

  return {
    dialect: 'postgres',
    async query(text, params = []) {
      const res = await pool.query(text, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/** Test / local-dev adapter: Node's built-in SQLite (data is NOT durable on Render). */
export async function createSqliteDb(path = ':memory:') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  const cache = new Map();

  return {
    dialect: 'sqlite',
    async query(text, params = []) {
      const sql = text.replace(/\$(\d+)/g, '?$1');
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        cache.set(sql, stmt);
      }
      const args = params.map((p) => (p === undefined ? null : p));
      if (/^\s*select\b/i.test(sql) || /\breturning\b/i.test(sql)) {
        const rows = stmt.all(...args).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      const info = stmt.run(...args);
      return { rows: [], rowCount: Number(info.changes) };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}

/** Pick an adapter from DATABASE_URL: `sqlite:<path>` for local dev, otherwise PostgreSQL. */
export async function createDb(config, { onError } = {}) {
  if (config.databaseUrl.startsWith('sqlite:')) {
    const path = config.databaseUrl.slice('sqlite:'.length) || ':memory:';
    if (path !== ':memory:') {
      const { mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(path), { recursive: true });
    }
    return createSqliteDb(path);
  }
  return createPgDb({ connectionString: config.databaseUrl, ssl: config.databaseSsl, onError });
}

export async function migrate(db) {
  for (const statement of SCHEMA) await db.exec(statement);
}
