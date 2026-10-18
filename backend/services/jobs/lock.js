// Global processing lock: a single row (id = 1) in job_lock acting as a lease.
//
//  - acquire(): atomic. The PRIMARY KEY makes INSERT ... ON CONFLICT DO NOTHING a compare-and-set:
//    exactly one concurrent caller gets a row back, everyone else gets nothing -> SYSTEM BUSY.
//  - A lease that has not been renewed (heartbeat) within `leaseMs` is stale (crashed worker) and is
//    removed automatically on the next acquire/startup. No manual DB editing is ever needed.
//  - There is no waiting and no queue: acquire() returns immediately.

export function createGlobalLock(db, { leaseMs, clock, owner }) {
  const staleCutoff = () => clock() - leaseMs;

  return {
    async acquire(jobId, kind) {
      const now = clock();
      await db.query('DELETE FROM job_lock WHERE id = 1 AND heartbeat_at < $1', [staleCutoff()]);
      const res = await db.query(
        `INSERT INTO job_lock (id, job_id, kind, status, owner, started_at, heartbeat_at)
         VALUES (1, $1, $2, 'RUNNING', $3, $4, $4)
         ON CONFLICT (id) DO NOTHING RETURNING job_id`,
        [jobId, kind, owner, now],
      );
      return res.rows.length === 1 && res.rows[0].job_id === jobId;
    },

    /** Renew the lease. Returns false if we no longer own the lock (it was lost or taken over). */
    async heartbeat(jobId) {
      const res = await db.query('UPDATE job_lock SET heartbeat_at = $2 WHERE id = 1 AND job_id = $1', [jobId, clock()]);
      return res.rowCount === 1;
    },

    async release(jobId) {
      const res = await db.query('DELETE FROM job_lock WHERE id = 1 AND job_id = $1', [jobId]);
      return res.rowCount === 1;
    },

    /** Remove an abandoned lease, if any. Returns the removed row for logging. */
    async recoverStale() {
      const res = await db.query('SELECT * FROM job_lock WHERE id = 1 AND heartbeat_at < $1', [staleCutoff()]);
      if (res.rows.length === 0) return null;
      await db.query('DELETE FROM job_lock WHERE id = 1 AND heartbeat_at < $1', [staleCutoff()]);
      const r = res.rows[0];
      return { jobId: r.job_id, kind: r.kind, startedAt: Number(r.started_at), heartbeatAt: Number(r.heartbeat_at) };
    },

    async current() {
      const res = await db.query('SELECT * FROM job_lock WHERE id = 1');
      const r = res.rows[0];
      if (!r) return null;
      return {
        jobId: r.job_id,
        kind: r.kind,
        owner: r.owner,
        startedAt: Number(r.started_at),
        heartbeatAt: Number(r.heartbeat_at),
        stale: Number(r.heartbeat_at) < staleCutoff(),
      };
    },
  };
}
