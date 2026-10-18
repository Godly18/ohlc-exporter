# OANDA OHLC Exporter

A web app that retrieves historical **M1 OHLC candles from OANDA**, keeps them permanently in
**Cloudflare R2** as compact yearly binary files, and lets a user pick an instrument and a date range
and **download a CSV**. Built from scratch to run on **Render's free tier**.

You choose **dates only**. Every request means **complete UTC calendar days**, end date inclusive:

```
Start 2025-06-15, End 2025-08-20  =  2025-06-15 00:00:00 UTC  through  2025-08-20 23:59:59 UTC
```

---

## 1. Exactly what was built

### The user-facing app
* A single page (`frontend/`): Instrument dropdown, Timeframe (M1), Start date, End date, **Generate CSV**.
  No time pickers. The date picker stops at yesterday (UTC), but the server re-checks everything.
* Live progress while the server works, then a **Download CSV** button with an **"Expires in mm:ss"** countdown.
* **Refresh-safe:** reload the page and your running job or still-valid CSV comes back (per-browser, via an anonymous
  HttpOnly cookie). If it has expired you see *"This download has expired. Please generate the data again."*

### The backend (Node.js 22, no web framework)
| Area | What it does |
|---|---|
| `GET /health` | Liveness endpoint. See section 3. **Never touches the database, R2, OANDA or the job lock.** |
| `POST /api/export` | Validates the request, takes the global lock (or answers **SYSTEM BUSY** immediately), starts a background job, returns `202 {jobId}`. |
| `GET /api/export/status/:jobId` | Job progress / result (only for the browser that created it). |
| `GET /api/export/active` | Recovers this browser's latest job after a refresh. |
| `GET /api/export/download/:token` | Streams the CSV after checking the token **and** the server-side expiry. |
| `GET /api/config`, `GET /api/status` | Public non-secret settings (instrument list, latest selectable date), and busy/idle. |
| OANDA client | One request per UTC day, spaced out, 30 s timeout, max 3 retries with backoff, only transient errors retried. |
| Dataset service | Verifies, catches up missing days, stages, validates, atomically promotes yearly `.bin` files. |
| Export service | Builds the CSV straight into R2 as a stream, issues the 5-minute download authorization. |
| Global lock | One row in Postgres used as a lease with a heartbeat. First request wins, everyone else gets SYSTEM BUSY. No queue. |
| Workers | Expired-export cleanup (every 60 s + on startup), crash recovery, hourly current-year maintenance, optional keep-alive ping. |

### Storage layout (R2)
```
oanda-data/EUR_USD/M1/2024.bin        permanent yearly datasets (never touched by cleanup)
oanda-data/EUR_USD/M1/2025.bin
oanda-data/EUR_USD/M1/2026.bin        current year: "complete through 2026-10-16"
oanda-data/_quarantine/...            corrupted files moved aside (kept for inspection)
exports/<random-192-bit-id>.csv       temporary CSVs, deleted after 5 minutes
```
There are **no monthly permanent files**. A request for Jun 15 to Aug 20 2025 loads `2025.bin` once and filters it.
The binary format is documented in [`docs/BINARY_FORMAT.md`](docs/BINARY_FORMAT.md) (24 bytes per candle, 80-byte
self-describing header with identity, coverage and a SHA-256 of the data; about 9 MB per instrument-year).

### Database (PostgreSQL)
Tables: `datasets` (status, coverage `first/last_complete_date`, hash, size, candle count, timestamps),
`day_status` (transient downloading/verifying/failed per day), `job_lock` (the single global lease), `exports`
(job + download authorization: `created_at`, `expires_at`, **SHA-256 of the token, never the token**).
The schema is created automatically at startup.

### CSV format
```
timestamp,open,high,low,close,volume
2025-06-15T00:00:00Z,1.07123,1.07150,1.07101,1.07140,57
```
Timestamp = candle open time, ISO-8601 UTC with `Z`. Prices are mid prices, decimal (at least 5 decimals; 3 for JPY pairs).
Volume is OANDA's tick count. Lines end with `\n`.

---

## 2. The calendar-day rules (the important part)

* **UTC is the only clock** for availability, coverage, expiry, cleanup and locks.
* The *latest completed day* is **yesterday (UTC)**, never "the last 24 hours".
* **Today is never returned.** Requesting it (or any range ending today) is refused: *"Data not available yet. The requested
  date is still in progress. Please retry later."* A range is **never silently shortened** (Sep 1 to Sep 14 is not turned into Sep 1 to Sep 13).
* **A day that just ended is not available until it is verified.** It is only fetched `DAY_SETTLE_MINUTES` (default 10) after
  midnight UTC, and only becomes available after every candle was downloaded, flagged complete by OANDA, validated, and
  durably stored. Otherwise: *"...has not been fully processed and verified. Please retry later."*
* Future dates, inverted ranges, malformed dates, unknown instruments/timeframes are rejected with clear messages.
* **Current-year file** (`2026.bin`) records `complete_through`. After downtime it catches up **every** missing day
  (e.g. stored through Sep 10, today Sep 14 means Sep 11, 12 and 13), and never claims coverage past a day that failed.
* **Year rollover:** when Dec 31 is verified the year becomes `COMPLETE`; the new year's file starts.

Day states exposed by the code: `DAY_NOT_COMPLETE`, `DAY_MISSING` (ended, retrievable), `DAY_DOWNLOADING`, `DAY_VERIFYING`,
`DAY_AVAILABLE`, `DAY_FAILED`. Dataset states: `MISSING`, `COMPLETE`, `COMPLETE_THROUGH_DAY`, `CORRUPTED`, `FAILED`.
Export states: `PROCESSING`, `GENERATING`, `READY`, `FAILED`, `EXPIRED`.

**Empty days:** an empty result is only accepted on days the market is closed (Saturdays, Dec 25, Jan 1, plus anything in
`EXTRA_CLOSED_DATES`). An empty *trading* day is treated as "not ready" and fails the request rather than producing a CSV with a silent gap.

## 3. `/health` on Render's free server

`GET /health` (and `HEAD`) returns `200 {"status":"ok","uptimeSeconds":...,"timestamp":...}`. `render.yaml` points Render's
health check at it. It was designed so it is **not interruptible by the application**:

1. **Dispatched first.** It is matched before security headers, HTTPS redirect, rate limiting, cookies, body parsing, routing or logging.
2. **Zero dependencies.** No database, R2, OANDA or lock call. A dead database, an unconfigured service, a running export, or a
   busy lock cannot affect it. (All tested.)
3. **Port opens before anything else.** `server.js` starts listening first, then connects to Postgres/R2 in the background and
   retries forever. Missing environment variables disable the API (clean 503s) but **not** `/health`.
4. **The event loop is never starved.** Every heavy loop (encode, hash, decode, validate, CSV) yields every ~4k records.
   Measured while encoding, validating, decoding and writing a 29 MB CSV of 480k candles: **max `/health` latency 7.6 ms**.
5. **No spurious 502s.** `keepAliveTimeout` is 125 s (longer than Render's proxy), bad client sockets can't crash the server,
   and unhandled errors are logged instead of killing the process.
6. **Graceful deploys.** On `SIGTERM` the running job is aborted, marked failed and its lock released, while `/health` keeps
   answering until the server closes.
7. **Free-tier spin-down.** Render stops free services after ~15 minutes without inbound traffic, which no code can prevent from
   the inside. The app pings its own public `/health` every 10 minutes (`KEEP_ALIVE_*`, enabled automatically when Render's
   `RENDER_EXTERNAL_URL` exists). For belt and braces also point a free external monitor (UptimeRobot, cron-job.org) at
   `https://<your-app>.onrender.com/health` every 5 minutes. Check Render's current free-tier terms (monthly instance hours) yourself.

## 4. Single global job, no queue

* One row in `job_lock` is the lease. `INSERT ... ON CONFLICT DO NOTHING` makes acquisition atomic: **the first request wins**; any
  other arriving while it is held gets *"System busy..."* immediately. Nothing is queued, retried or deferred.
* The lock covers validate, download/update, validate, generate, store, authorize. It is **released as soon as the CSV is ready**,
  not while the user downloads.
* A heartbeat renews the lease every 15 s. If a process dies, the lease expires (90 s) and the next acquire, or startup/cleanup recovery,
  clears it automatically. A job that loses its lock is told to abort. Orphaned `PROCESSING` exports are marked failed.
* Hourly **maintenance** of recent datasets uses the same lock: if anything is running it skips that cycle (no hidden queue).

## 5. Integrity and recovery

* Every load re-verifies: identity (instrument, timeframe, year), size, body SHA-256, ordering, duplicates, OHLC relationships, coverage bounds,
  and the hash recorded in the database.
* **Corrupt file:** never used; moved to `_quarantine/`, marked `CORRUPTED`, rebuilt from OANDA, validated, then promoted.
* **Updates are staged:** build in memory, validate the encoded bytes, upload `<year>.bin.tmp`, confirm size, one atomic server-side copy to
  `<year>.bin`, then commit metadata. Any failure deletes the staging file and leaves the old known-good file untouched.
* **Crash between copy and commit:** a `pending_sha256` marker written beforehand lets the next load adopt the (fully verified) new file.
* **Database lost** (see the Render free-Postgres note below): fully verified objects in R2 are adopted and metadata is rebuilt with no re-download.
* Long builds write **validated checkpoints** every `CHECKPOINT_DAYS` (30) days. A checkpoint only claims coverage through its own last day, so
  a free-tier restart mid-build resumes instead of starting over, and nothing ever claims days it did not verify.

## 6. Temporary CSV exports

* Lifetime is **exactly 5 minutes** from the moment the CSV is stored (`expires_at = created_at + 5 min`, UTC, server clock).
* Downloads are streamed through the server (no public R2 URLs), so expiry is enforced by the server even if the object still exists
  (410 + *"This download has expired..."*). Multiple downloads within the 5 minutes are allowed.
* Token = HMAC-SHA256(server secret, random id): unguessable, and the database stores only its SHA-256. The same token is re-issued to the owning browser after a refresh.
* Cleanup: every 60 s the worker deletes objects with `expires_at <= now`; **on every startup** expired exports are deleted
  (a restart after 20 min deletes it, a restart after 3 min keeps it until minute 5). Orphan sweep removes untracked old CSVs and abandoned `.tmp` files.
  Only `exports/` (and `.bin.tmp` staging) is ever deleted; permanent `.bin` files are never touched by cleanup.
* **Optional R2 lifecycle safety net:** in the Cloudflare dashboard (R2 > your bucket > Settings > Object lifecycle rules) add a rule
  for prefix `exports/` to delete objects after 1 day. **Never** add a rule for `oanda-data/`. The app does not rely on this rule.

---

## 7. Deploy on Render (free)

1. Push this folder to a Git repository (GitHub/GitLab).
2. **Cloudflare R2:** create a bucket, create an API token with *Object Read & Write* for that bucket; note the account id, access key id,
   secret and bucket name. (Optionally add the `exports/` lifecycle rule above.)
3. **OANDA:** create an API token (practice account recommended to start; set `OANDA_ENVIRONMENT=live` for a live account).
4. On Render choose **New > Blueprint** and select the repo. `render.yaml` creates the free web service and a free Postgres, wires
   `DATABASE_URL`, and generates `EXPORT_TOKEN_SECRET`. Enter the prompted secrets (`OANDA_API_TOKEN`, `R2_*`).
   (Manual setup: Web Service, Node, build `npm install --omit=dev`, start `node backend/server.js`, **Health Check Path `/health`**.)
5. Open the service **Shell** and run `npm run smoke` once. It checks your real Postgres, R2 and OANDA (see section 9).
6. Open `https://<service>.onrender.com`. Optionally add an external uptime monitor on `/health`.

Notes for the free tier:
* The disk is ephemeral, so **nothing important lives on disk**. Data is in R2, metadata in Postgres.
* At the time of writing Render's *free Postgres expires after about 30 days*. The app survives this: recreate/reconnect a database and
  it rebuilds metadata from R2 on first use (no re-download). For a permanent setup use a paid Postgres or an external free one (Neon, Supabase)
  and set `DATABASE_URL` (+ `DATABASE_SSL=true` for external URLs).
* 512 MB RAM: a candle costs 24 bytes in memory and exports are streamed to R2, so a 1-year export peaks well under 100 MB.
  `MAX_EXPORT_DAYS` (default 800) caps a single request.
* The **first request for an old year downloads the whole year** (about 365 OANDA requests, a few minutes at the default 250 ms spacing) because completed years are stored whole and
  then reused forever. The progress bar shows this. Later requests for that year are instant.

## 8. Configuration

See [`.env.example`](.env.example) for every variable with comments. Required: `DATABASE_URL`, `OANDA_API_TOKEN`, `OANDA_ENVIRONMENT`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `EXPORT_TOKEN_SECRET`. Supported instruments and
timeframes live in one file: [`backend/config/catalog.js`](backend/config/catalog.js) (add a line to add an instrument).
For local development without Postgres you may use `DATABASE_URL=sqlite:./data/dev.db` (not durable on Render).

```
npm install
cp .env.example .env     # fill in
npm run dev              # http://localhost:10000
npm test                 # automated tests (no credentials or network needed)
npm run smoke            # live check of Postgres + R2 + OANDA (needs real credentials)
```

## 9. What was tested, and what was NOT

### Actually run (114 automated tests, all passing: `npm test`, about 3 s)
| File | Tests | Covers |
|---|---:|---|
| `calendar.test.js` | 20 | complete-day logic, no rolling 24h, UTC boundaries, settle window, current/future/inverted/malformed dates, no shortened ranges, cross-month/year, day states |
| `binformat.test.js` | 13 | round trip, determinism, wrong instrument/timeframe/year, bit-flip, truncation, bad magic/version, duplicates, out-of-order, invalid OHLC, CSV format |
| `datasets.test.js` | 19 | build/reuse, current-year `complete_through`, multi-day catch-up, failure preserves old file, checkpoints, atomic replacement, size-mismatch staging, incomplete/empty/invalid days, corruption rebuild, failed rebuild, hash mismatch, wrong identity, crash-window adoption, DB-loss recovery |
| `lock.test.js` | 8 | first wins, 25 concurrent acquirers give 1 winner, no queue, release, stale recovery, heartbeat, lost-lock abort |
| `exports.test.js` | 22 | CSV content/filtering/inclusive end, single- and cross-year loading, 5-minute expiry to the second, refresh recovery, multiple downloads, expired rejection with object present, cleanup, SYSTEM BUSY, failed-job release, maintenance vs user, catch-up, year transition |
| `recovery.test.js` | 11 | stale lock + orphan jobs, restart before/after expiry, crash during CSV write, abandoned staging, orphan sweep, crash during download, corrupted-data rebuild, row purge |
| `security.test.js` | 14 | injection/traversal inputs, key safety, guessed/malformed tokens, other-session access, no secrets in pages/API/logs, headers/cookie, static traversal, HTTPS redirect, rate limiting |
| `health.test.js` | 7 | `/health` with no services, DB down, job running, shutting down, no rate limit/redirect/cookie, **latency under heavy CPU work**, and a **real `node backend/server.js` process** booting with no config and exiting 0 on SIGTERM |

### NOT tested against real infrastructure (nothing here claims otherwise)
The environment I built this in could not install npm packages (the registry was blocked), so:
* **Cloudflare R2** (`backend/services/r2/storage.js`, AWS SDK v3): tested only through an in-memory double with the same interface. The adapter is
  small and uses standard calls (Put/Get/Head/Copy/Delete/ListObjectsV2 + multipart upload), but it has **never been run**, and neither has the SDK install.
* **PostgreSQL** (`createPgDb`, `pg`): never run. The SQL is a deliberately portable subset and the *same statements* were executed against SQLite in the tests, which
  catches logic and syntax errors but not Postgres-specific behaviour.
* **OANDA** (`backend/services/oanda/client.js`): tested only against a fake. The request format and response parsing follow OANDA's v20 candles endpoint as I know it; not verified against the live API.
* **Render deployment** and the keep-alive ping: not deployed.

**Run `npm run smoke` on first deploy.** It exercises exactly these three adapters (Postgres lock, R2 put/head/copy/get/list/delete/multipart, one real OANDA day) and
prints PASS/FAIL per step. If any step fails, the message is secret-redacted and points to the adapter at fault.

## 10. Decisions I made where the spec was silent
* Jobs run **asynchronously** (202 + polling) because Render cuts long HTTP requests; the lock is held by the background job.
* Validation of the request happens **before** taking the lock (cheap and stateless); everything else is inside it.
* Past years are built **whole** (see the free-tier note) so completed-year files are immutable; the current year is built only as far as needed by a request, and by maintenance up to the latest verifiable day.
* Exports are tied to an **anonymous cookie** (no accounts) for refresh recovery; the download link itself works as a bearer token for 5 minutes.
* `DAY_SETTLE_MINUTES`, `CHECKPOINT_DAYS`, `MAX_EXPORT_DAYS`, `MIN_DATA_YEAR` are safety parameters of mine, all configurable.
* Prices are mid prices stored as integers x 1e5 (OANDA gives at most 5 decimals for the allowlisted pairs; anything finer is rejected, not rounded).

## 11. Project layout
```
frontend/            index.html, css/styles.css, js/app.js
backend/server.js    entry point (listen first, init in background, graceful shutdown)
backend/app.js       request handler: /health first, then security, routing, static
backend/api/         route handlers
backend/config/      env parsing, instrument/timeframe allowlists
backend/database/    Postgres + SQLite adapters, schema, repositories
backend/lib/         time rules, binary format, validation, CSV, tokens, logger
backend/middleware/  http helpers (session, headers, rate limit), static files
backend/services/    oanda/ r2/ datasets/ exports/ jobs/
backend/workers/     cleanup + recovery, maintenance, keep-alive
scripts/smoke.js     live-infrastructure check
tests/               114 tests + helpers (in-memory R2, fake OANDA, harness)
docs/BINARY_FORMAT.md
render.yaml  .env.example  package.json
```
