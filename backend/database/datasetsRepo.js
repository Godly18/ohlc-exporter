// Dataset metadata + transient per-day state.

const num = (v) => (v === null || v === undefined ? null : Number(v));

export const DatasetStatus = Object.freeze({
  MISSING: 'MISSING',
  COMPLETE: 'COMPLETE',
  COMPLETE_THROUGH_DAY: 'COMPLETE_THROUGH_DAY',
  CORRUPTED: 'CORRUPTED',
  FAILED: 'FAILED',
});

export const Activity = Object.freeze({ IDLE: 'IDLE', DOWNLOADING: 'DOWNLOADING', VERIFYING: 'VERIFYING' });

export const datasetId = (instrument, timeframe, year) => `${instrument}/${timeframe}/${year}`;

function mapDataset(r) {
  if (!r) return null;
  return {
    id: r.id,
    instrument: r.instrument,
    timeframe: r.timeframe,
    year: Number(r.year),
    status: r.status,
    activity: r.activity,
    objectKey: r.object_key,
    fileSize: num(r.file_size),
    candleCount: num(r.candle_count),
    firstTimestamp: num(r.first_timestamp),
    lastTimestamp: num(r.last_timestamp),
    firstCompleteDate: r.first_complete_date,
    lastCompleteDate: r.last_complete_date,
    sha256: r.sha256,
    pendingSha256: r.pending_sha256,
    pendingCompleteDate: r.pending_complete_date,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

export function createDatasetsRepo(db, clock) {
  const repo = {
    async get(instrument, timeframe, year) {
      const res = await db.query('SELECT * FROM datasets WHERE id = $1', [datasetId(instrument, timeframe, year)]);
      return mapDataset(res.rows[0]);
    },

    async list({ minYear = 0 } = {}) {
      const res = await db.query('SELECT * FROM datasets WHERE year >= $1 ORDER BY instrument, timeframe, year', [minYear]);
      return res.rows.map(mapDataset);
    },

    /** Make sure a row exists (status MISSING) so activity/pending markers have somewhere to live. */
    async touch(instrument, timeframe, year) {
      const now = clock();
      await db.query(
        `INSERT INTO datasets (id, instrument, timeframe, year, status, activity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'MISSING', 'IDLE', $5, $5)
         ON CONFLICT (id) DO NOTHING`,
        [datasetId(instrument, timeframe, year), instrument, timeframe, year, now],
      );
    },

    async setActivity(instrument, timeframe, year, activity) {
      await repo.touch(instrument, timeframe, year);
      await db.query('UPDATE datasets SET activity = $2, updated_at = $3 WHERE id = $1', [
        datasetId(instrument, timeframe, year),
        activity,
        clock(),
      ]);
    },

    async resetActivities() {
      const res = await db.query("UPDATE datasets SET activity = 'IDLE', updated_at = $1 WHERE activity <> 'IDLE'", [clock()]);
      return res.rowCount;
    },

    /** Record the sha/coverage we are ABOUT to promote, so a crash between copy and commit is recoverable. */
    async setPending(instrument, timeframe, year, { sha256, completeThrough }) {
      await repo.touch(instrument, timeframe, year);
      await db.query('UPDATE datasets SET pending_sha256 = $2, pending_complete_date = $3, updated_at = $4 WHERE id = $1', [
        datasetId(instrument, timeframe, year),
        sha256,
        completeThrough,
        clock(),
      ]);
    },

    async clearPending(instrument, timeframe, year) {
      await db.query('UPDATE datasets SET pending_sha256 = NULL, pending_complete_date = NULL, updated_at = $2 WHERE id = $1', [
        datasetId(instrument, timeframe, year),
        clock(),
      ]);
    },

    /** Commit a validated, durably stored dataset. Clears any pending marker. */
    async upsertComplete(d) {
      const now = clock();
      await db.query(
        `INSERT INTO datasets
           (id, instrument, timeframe, year, status, activity, object_key, file_size, candle_count,
            first_timestamp, last_timestamp, first_complete_date, last_complete_date, sha256,
            pending_sha256, pending_complete_date, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'IDLE',$6,$7,$8,$9,$10,$11,$12,$13,NULL,NULL,$14,$14)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, activity = 'IDLE', object_key = excluded.object_key,
           file_size = excluded.file_size, candle_count = excluded.candle_count,
           first_timestamp = excluded.first_timestamp, last_timestamp = excluded.last_timestamp,
           first_complete_date = excluded.first_complete_date, last_complete_date = excluded.last_complete_date,
           sha256 = excluded.sha256, pending_sha256 = NULL, pending_complete_date = NULL,
           updated_at = excluded.updated_at`,
        [
          datasetId(d.instrument, d.timeframe, d.year),
          d.instrument,
          d.timeframe,
          d.year,
          d.status,
          d.objectKey,
          d.fileSize,
          d.candleCount,
          d.firstTimestamp,
          d.lastTimestamp,
          d.firstCompleteDate,
          d.lastCompleteDate,
          d.sha256,
          now,
        ],
      );
    },

    async markCorrupted(instrument, timeframe, year) {
      await repo.touch(instrument, timeframe, year);
      await db.query(
        `UPDATE datasets SET status = 'CORRUPTED', activity = 'IDLE', pending_sha256 = NULL,
           pending_complete_date = NULL, updated_at = $2 WHERE id = $1`,
        [datasetId(instrument, timeframe, year), clock()],
      );
    },

    /** (instrument, timeframe) pairs that have a recent dataset and should be kept current. */
    async listMaintenanceTargets(minYear) {
      const res = await db.query(
        `SELECT DISTINCT instrument, timeframe FROM datasets
         WHERE (year >= $1 AND status IN ('COMPLETE', 'COMPLETE_THROUGH_DAY')) OR status = 'COMPLETE_THROUGH_DAY' ORDER BY instrument, timeframe`,
        [minYear],
      );
      return res.rows.map((r) => ({ instrument: r.instrument, timeframe: r.timeframe }));
    },

    // --- transient per-day state -------------------------------------------------------------

    async setDay(instrument, timeframe, day, status, detail = null) {
      await db.query(
        `INSERT INTO day_status (id, instrument, timeframe, day, status, detail, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`,
        [`${instrument}|${timeframe}|${day}`, instrument, timeframe, day, status, detail, clock()],
      );
    },

    async getDay(instrument, timeframe, day) {
      const res = await db.query('SELECT status FROM day_status WHERE id = $1', [`${instrument}|${timeframe}|${day}`]);
      return res.rows[0]?.status ?? null;
    },

    async clearDays(instrument, timeframe, fromDay, toDay) {
      await db.query('DELETE FROM day_status WHERE instrument = $1 AND timeframe = $2 AND day >= $3 AND day <= $4', [
        instrument,
        timeframe,
        fromDay,
        toDay,
      ]);
    },

    /** After a restart nothing can be mid-download any more: drop transient markers. */
    async clearTransientDays() {
      const res = await db.query("DELETE FROM day_status WHERE status IN ('DOWNLOADING', 'VERIFYING')");
      return res.rowCount;
    },
  };
  return repo;
}
