// Export / job metadata. A row is both the processing job and (once READY) the download authorization.
// Only sha256(token) is stored, never the token itself.

const num = (v) => (v === null || v === undefined ? null : Number(v));

export const ExportStatus = Object.freeze({
  PROCESSING: 'PROCESSING',
  GENERATING: 'GENERATING',
  READY: 'READY',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

function mapExport(r) {
  if (!r) return null;
  return {
    jobId: r.job_id,
    exportId: r.export_id,
    sessionHash: r.session_hash,
    instrument: r.instrument,
    timeframe: r.timeframe,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    stage: r.stage,
    progressCurrent: num(r.progress_current),
    progressTotal: num(r.progress_total),
    progressLabel: r.progress_label,
    objectKey: r.object_key,
    fileSize: num(r.file_size),
    rowCount: num(r.row_count),
    downloadTokenHash: r.download_token_hash,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    requestedAt: num(r.requested_at),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    updatedAt: num(r.updated_at),
  };
}

export function createExportsRepo(db, clock) {
  const one = async (sql, params) => mapExport((await db.query(sql, params)).rows[0]);

  return {
    async create(row) {
      const now = clock();
      await db.query(
        `INSERT INTO exports
           (job_id, export_id, session_hash, instrument, timeframe, start_date, end_date, status, stage,
            requested_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PROCESSING','STARTING',$8,$8)`,
        [row.jobId, row.exportId, row.sessionHash, row.instrument, row.timeframe, row.startDate, row.endDate, now],
      );
    },

    get: (jobId) => one('SELECT * FROM exports WHERE job_id = $1', [jobId]),

    getByTokenHash: (hash) => one('SELECT * FROM exports WHERE download_token_hash = $1', [hash]),

    async updateProgress(jobId, { stage, current = null, total = null, label = null }) {
      await db.query(
        `UPDATE exports SET stage = $2, progress_current = $3, progress_total = $4, progress_label = $5, updated_at = $6
         WHERE job_id = $1 AND status IN ('PROCESSING', 'GENERATING')`,
        [jobId, stage, current, total, label, clock()],
      );
    },

    async setGenerating(jobId) {
      await db.query(
        `UPDATE exports SET status = 'GENERATING', stage = 'GENERATING', updated_at = $2
         WHERE job_id = $1 AND status = 'PROCESSING'`,
        [jobId, clock()],
      );
    },

    /** Returns true only if the row was still in flight (so a job already failed by recovery cannot become READY). */
    async markReady(jobId, { objectKey, fileSize, rowCount, tokenHash, createdAt, expiresAt }) {
      const res = await db.query(
        `UPDATE exports SET status = 'READY', stage = 'READY', object_key = $2, file_size = $3, row_count = $4,
           download_token_hash = $5, created_at = $6, expires_at = $7, updated_at = $6
         WHERE job_id = $1 AND status IN ('PROCESSING', 'GENERATING')`,
        [jobId, objectKey, fileSize, rowCount, tokenHash, createdAt, expiresAt],
      );
      return res.rowCount === 1;
    },

    async markFailed(jobId, { code, message }) {
      await db.query(
        `UPDATE exports SET status = 'FAILED', stage = 'FAILED', error_code = $2, error_message = $3, updated_at = $4
         WHERE job_id = $1 AND status IN ('PROCESSING', 'GENERATING')`,
        [jobId, code, message, clock()],
      );
    },

    /** The user cancelled: works for a running job and for a finished (READY) export that has not expired yet. */
    async markCancelled(jobId) {
      const res = await db.query(
        `UPDATE exports SET status = 'CANCELLED', stage = 'CANCELLED', error_code = 'CANCELLED', error_message = 'The request was cancelled.', updated_at = $2
         WHERE job_id = $1 AND status IN ('PROCESSING', 'GENERATING', 'READY')`,
        [jobId, clock()],
      );
      return res.rowCount === 1;
    },

    async markExpired(jobId) {
      await db.query(`UPDATE exports SET status = 'EXPIRED', stage = 'EXPIRED', updated_at = $2 WHERE job_id = $1 AND status = 'READY'`, [
        jobId,
        clock(),
      ]);
    },

    /** Most recent job for a browser session. */
    latestForSession: (sessionHash) =>
      one('SELECT * FROM exports WHERE session_hash = $1 ORDER BY requested_at DESC LIMIT 1', [sessionHash]),

    async listInFlight() {
      const res = await db.query("SELECT * FROM exports WHERE status IN ('PROCESSING', 'GENERATING')");
      return res.rows.map(mapExport);
    },

    /** READY exports whose expires_at has passed: the cleanup worker deletes their objects. */
    async listReadyExpired(nowMs) {
      const res = await db.query("SELECT * FROM exports WHERE status = 'READY' AND expires_at <= $1", [nowMs]);
      return res.rows.map(mapExport);
    },

    /** Forget finished rows after a grace period so the table cannot grow forever. */
    async purgeOlderThan(cutoffMs) {
      const res = await db.query("DELETE FROM exports WHERE status IN ('EXPIRED', 'FAILED', 'CANCELLED') AND updated_at < $1", [cutoffMs]);
      return res.rowCount;
    },
  };
}
