// Portable schema: the same statements run on PostgreSQL (production) and on node:sqlite (tests
// and optional local dev). Rules that keep it portable: TEXT/INTEGER/BIGINT only, timestamps are
// epoch milliseconds in UTC (BIGINT), no vendor functions, no SERIAL.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    year INTEGER NOT NULL,
    status TEXT NOT NULL,
    activity TEXT NOT NULL,
    object_key TEXT,
    file_size BIGINT,
    candle_count BIGINT,
    first_timestamp BIGINT,
    last_timestamp BIGINT,
    first_complete_date TEXT,
    last_complete_date TEXT,
    sha256 TEXT,
    pending_sha256 TEXT,
    pending_complete_date TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS datasets_year_idx ON datasets (year)`,

  // Transient per-day processing state. DAY_AVAILABLE is implicit: covered by datasets.last_complete_date.
  `CREATE TABLE IF NOT EXISTS day_status (
    id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    day TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS day_status_lookup_idx ON day_status (instrument, timeframe, day)`,

  // Exactly one row (id = 1) can exist: the global processing lock / lease.
  `CREATE TABLE IF NOT EXISTS job_lock (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    owner TEXT,
    started_at BIGINT NOT NULL,
    heartbeat_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS exports (
    job_id TEXT PRIMARY KEY,
    export_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    progress_current INTEGER,
    progress_total INTEGER,
    progress_label TEXT,
    object_key TEXT,
    file_size BIGINT,
    row_count BIGINT,
    download_token_hash TEXT,
    error_code TEXT,
    error_message TEXT,
    requested_at BIGINT NOT NULL,
    created_at BIGINT,
    expires_at BIGINT,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS exports_token_idx ON exports (download_token_hash)`,
  `CREATE INDEX IF NOT EXISTS exports_session_idx ON exports (session_hash, requested_at)`,
  `CREATE INDEX IF NOT EXISTS exports_status_idx ON exports (status)`,
];
