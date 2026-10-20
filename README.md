# OANDA OHLC Exporter

A web app that retrieves historical **M1 OHLC candles** (92 instruments: 68 forex pairs from **OANDA**, 23 crypto pairs from
**Binance**, and **XAU/USD from Twelve Data**), keeps them permanently in **Cloudflare R2** as compact yearly binary files,
and lets a user pick an instrument and a date range and **download a ZIP containing the CSV**. The ZIP is built and served by
**GitHub Actions**, so download traffic never goes through the server. Built to run on **Render's free tier**.

You choose **dates only**. Every request means **complete UTC calendar days**, end date inclusive:

```
Start 2025-06-15, End 2025-08-20  =  2025-06-15 00:00:00 UTC  through  2025-08-20 23:59:59 UTC
```

---

## 1. Exactly what was built

### The user-facing app
* A single page (`frontend/`): a **searchable, scrollable instrument list** (type `jpy`, `btc`, `gold`, `crypto`...), Timeframe (M1),
  Start date, End date, **Generate CSV (ZIP)**. No time pickers. The date pickers stop at yesterday (UTC) and start at the
  instrument's first year: **2018 for the 23 crypto pairs, 2021 for XAU/USD, 2010 for forex**. The server enforces the same limits.
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
| `GET /api/export/download/:token` | Checks the token **and** the server-side expiry, then **redirects the browser to GitHub's signed artifact URL** (no bytes through this server). Local-dev mode streams the ZIP from R2 instead. |
| `GET /api/config`, `GET /api/status` | Public non-secret settings (instrument list, latest selectable date), and busy/idle. |
| OANDA client | Forex. One request per UTC day, spaced out, 30 s timeout, max 3 retries with backoff, only transient errors retried. |
| Binance client | Crypto. Monthly archive first (SHA-256 verified), REST API for months the archive does not have yet. See section 1b. |
| Twelve Data client | **XAUUSD only.** Paced to the free plan's 8 requests/minute, 3 days per request. |
| GitHub offload | Dispatches the export workflow, waits for it, hands out the artifact. See section 6. |
| Dataset service | Verifies, catches up missing days, stages, validates, atomically promotes yearly `.bin` files. |
| Export service | Verifies the datasets, has GitHub Actions build + zip the CSV from R2, issues the 5-minute download authorization. |
| Global lock | One row in Postgres used as a lease with a heartbeat. First request wins, everyone else gets SYSTEM BUSY. No queue. |
| Workers | Expired-export cleanup (every 60 s + on startup), crash recovery, hourly current-year maintenance, optional keep-alive ping. |

### Storage layout (R2)
```
oanda-data/EUR_USD/M1/2024.bin        permanent yearly datasets (never touched by cleanup)
oanda-data/EUR_USD/M1/2025.bin
oanda-data/EUR_USD/M1/2026.bin        current year: "complete through 2026-10-16"
oanda-data/_quarantine/...            corrupted files moved aside (kept for inspection)
oanda-data/BTCUSDT/M1/2026.bin        crypto and XAUUSD use the same layout (crypto in format v2)
exports/<random-192-bit-id>.zip       only in local-dev mode: temporary ZIPs, deleted after 5 minutes
```
In production (GitHub mode) the temporary file is a **GitHub Actions artifact**, not an R2 object.
There are **no monthly permanent files**. A request for Jun 15 to Aug 20 2025 loads `2025.bin` once and filters it.
The binary format is documented in [`docs/BINARY_FORMAT.md`](docs/BINARY_FORMAT.md): self-describing header with identity,
scales, coverage and a SHA-256 of the data. **Format v1** (forex, gold): 24 bytes/candle, about 9 MB per instrument-year.
**Format v2** (crypto): 44 bytes/candle with 8-decimal prices and volumes, about 23 MB per pair-year (crypto trades 24/7).
Existing v1 forex files keep working untouched.

### Database (PostgreSQL)
Tables: `datasets` (status, coverage `first/last_complete_date`, hash, size, candle count, timestamps),
`day_status` (transient downloading/verifying/failed per day), `job_lock` (the single global lease), `exports`
(job + download authorization: `created_at`, `expires_at`, **SHA-256 of the token, never the token**).
The schema is created automatically at startup.

### CSV format (delivered inside a .zip)
Every download is a **`.zip`** named like `EUR_USD_M1_2025-06-15_2025-08-20.zip`, containing exactly one file with the same name ending `.csv`. It is compressed while it is generated (`backend/lib/zip.js`, pure `node:zlib`, no dependency), so memory stays flat. It opens with Windows Explorer, macOS, 7-Zip and `unzip`.

```
timestamp,open,high,low,close,volume
2025-06-15T00:00:00Z,1.07123,1.07150,1.07101,1.07140,57
```
Timestamp = candle open time, ISO-8601 UTC with `Z`. Lines end with `\n`.
* **Forex:** mid prices, at least 5 decimals (3 for JPY/HUF/CZK/THB quotes); volume = OANDA's tick count.
* **Crypto:** Binance trade prices, exact up to 8 decimals (at least 2 for USDT pairs, 6 for BTC/ETH-quoted pairs; trailing zeros beyond that are trimmed);
  volume = base-asset amount with up to 8 decimals (e.g. `65000.01,...,12.34567`).
* **XAU/USD:** at least 2 decimals (rounded half-up to 5); Twelve Data often reports no volume for gold, which is written as `0`.

### 1b. Data sources and instruments

| Group | Instruments | Provider | First year |
|---|---|---|---|
| Forex | the 68 OANDA practice-API pairs (EUR/USD ... TRY/JPY) | OANDA v20 | 2010 (`MIN_DATA_YEAR`) |
| Crypto | ADABTC BNBBTC DASHBTC ETCBTC ETHBTC LINKBTC LTCBTC TRXBTC XRPBTC ZECBTC, ADAETH BNBETH LINKETH LTCETH TRXETH XLMETH XRPETH ZECETH, BNBUSDT BTCUSDT ETHUSDT LTCUSDT NEOUSDT | Binance Spot (public, no key) | **2018** |
| Metals | XAUUSD (XAU/USD) | **Twelve Data, for this one instrument only** | **2021** |

* **Binance, archive first:** for any day inside a month that has fully ended, the app downloads the whole **monthly** file
  `data.binance.vision/data/spot/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-<YYYY-MM>.zip` once, checks it against the published
  `.CHECKSUM` (SHA-256), and serves the month's days from it. If the month is not in the archive yet (the current month, and the first days
  after a month ends) or the checksum fails, it uses the REST API (`data-api.binance.vision/api/v3/klines`, 1000 candles per request, so 2 per day).
  Archive timestamps switched from milliseconds to **microseconds** in 2025; both are handled.
* **Crypto trades 24/7**, so an empty day is only accepted *before the pair's first candle* (pair not listed yet, e.g. LINKBTC in 2018).
  A missing day after trading started stops the build with "not fully processed and verified" instead of leaving a silent gap.
  A range with no data at all is answered with "No data exists for this instrument in the selected date range".
* **Twelve Data free plan limits** (8 requests/minute, 800 credits/day) are respected: 3 days per request, ~8 s between requests.
  A first request for a whole past XAU/USD year is therefore about 100 requests (~13 minutes); a daily-credit error stops the job with a clear message.
  If `TWELVEDATA_API_KEY` is not set, XAUUSD is simply not offered.
* The per-instrument first year is enforced in the date picker **and** on the server (`DATE_TOO_EARLY`).

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

## 6. Temporary exports: built and downloaded on GitHub Actions

The server no longer reads, zips or serves the CSV in production. After the datasets are verified, it hands the job to a **GitHub Actions workflow**:

1. The server (still holding the global lock) calls `workflow_dispatch` on `.github/workflows/export-csv.yml` with the export id, instrument, dates.
2. The workflow checks out the repo, runs `scripts/export-csv.js`, which **reads the verified yearly `.bin` files from R2** (re-checking identity, SHA-256, ordering,
   OHLC rules and that the data covers the requested days), writes the CSV, and uploads it as a workflow **artifact**. GitHub delivers artifacts as a `.zip`,
   so the download is always `<instrument>_<timeframe>_<start>_<end>.zip` with one CSV inside.
3. The server polls the run (about every 4 s, progress shown to the user), then records the artifact id and releases the lock.
4. `GET /api/export/download/:token` checks the token and the **server-side 5-minute expiry**, asks GitHub for the artifact's short-lived signed URL and answers
   **`302` to it**. The file travels GitHub -> browser; this server sends no download bytes (Render's outbound bandwidth is not used).

* Lifetime is **exactly 5 minutes** (`expires_at = created_at + 5 min`, server clock). After that the token is refused (410) without contacting GitHub.
* Cleanup (every 60 s and on every startup) deletes the artifact **and the run** once expired. The workflow's `retention-days: 1` is only a safety net.
  Failed runs are kept in the Actions history so their logs can be read.
* Token = HMAC-SHA256(server secret, random id); the database stores only its SHA-256. The same token is re-issued to the owning browser after a refresh.
* If the run takes longer than `GH_RUN_TIMEOUT_SECONDS` (600) it is cancelled and the job fails cleanly; the lock is released either way.
* **Local development / no GitHub configured:** `EXPORT_MODE=server` (the default when `GH_*` are unset) builds the ZIP into R2 `exports/` and streams it from the server, exactly as before.
  Do not use that mode in production if you want to save bandwidth.
* Cost: public repositories have free Actions minutes; private ones use your plan's minutes (each export is a ~1 minute run). The artifact is deleted by the cleanup minutes after use.
* **Optional R2 lifecycle rule** (only relevant in server mode): rule for prefix `exports/` to delete after 1 day. **Never** add one for `oanda-data/`.

---

## 7. Deploy on Render (free)

1. Push this folder to **a GitHub repository** (the workflow file `.github/workflows/export-csv.yml` must be in its default branch).
2. **Cloudflare R2:** create a bucket and an API token with *Object Read & Write* for it (for the server). Create a second, **read-only** token for GitHub.
3. **OANDA:** create an API token (practice account recommended to start; `OANDA_ENVIRONMENT=live` for a live account).
4. **Twelve Data (optional, only for XAU/USD):** create an API key; set `TWELVEDATA_API_KEY`. Without it XAU/USD is hidden. Binance needs no key.
5. **GitHub repository secrets** (Settings > Secrets and variables > Actions): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   (the read-only token), `R2_BUCKET_NAME`.
6. **GitHub token for the server:** Settings > Developer settings > Fine-grained tokens. Resource owner = you, *Only select repositories* = this repo,
   permission **Actions: Read and write** (nothing else). Put it in Render as `GH_EXPORT_TOKEN`, and set `GH_REPO=owner/name`
   (`GH_REF=main` or your default branch).
7. On Render choose **New > Blueprint** and select the repo. `render.yaml` creates the free web service and a free Postgres, wires
   `DATABASE_URL`, and generates `EXPORT_TOKEN_SECRET`. Enter the prompted secrets (`OANDA_API_TOKEN`, `R2_*`, `TWELVEDATA_API_KEY`, `GH_EXPORT_TOKEN`, `GH_REPO`).
   (Manual setup: Web Service, Node, build `npm install --omit=dev`, start `node backend/server.js`, **Health Check Path `/health`**.)
8. Open the service **Shell** and run `npm run smoke` once. It checks your real Postgres, R2, OANDA, Binance (API + archive), Twelve Data and the GitHub token (see section 9).
9. Open `https://<service>.onrender.com`. Optionally add an external uptime monitor on `/health`.

Notes for the free tier:
* The disk is ephemeral, so **nothing important lives on disk**. Data is in R2, metadata in Postgres.
* At the time of writing Render's *free Postgres expires after about 30 days*. The app survives this: recreate/reconnect a database and
  it rebuilds metadata from R2 on first use (no re-download). For a permanent setup use a paid Postgres or an external free one (Neon, Supabase)
  and set `DATABASE_URL` (+ `DATABASE_SSL=true` for external URLs).
* 512 MB RAM: a candle costs 44 bytes in memory (crypto years are ~525k candles, ~23 MB each). While GitHub builds the file the server frees the in-memory datasets.
  `MAX_EXPORT_DAYS` (default 800) caps a single request.
* The **first request for an old year builds the whole year** because completed years are stored whole and then reused forever: forex about 365 OANDA requests (a few minutes);
  crypto 12 archive downloads (seconds to a minute); XAU/USD ~100 Twelve Data requests (~13 minutes on the free plan). The progress bar shows this. Later requests for that year are instant.

## 8. Configuration

See [`.env.example`](.env.example) for every variable with comments. Required: `DATABASE_URL`, `OANDA_API_TOKEN`, `OANDA_ENVIRONMENT`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `EXPORT_TOKEN_SECRET`.
New: `TWELVEDATA_API_KEY` (optional; enables XAU/USD), `GH_EXPORT_TOKEN` + `GH_REPO` (+ `GH_WORKFLOW_FILE`, `GH_REF`, `GH_RUN_TIMEOUT_SECONDS`; enable GitHub downloads),
`EXPORT_MODE` (`github`/`server`; automatic), and `BINANCE_*` / `TWELVEDATA_*` tuning (defaults are right for the free plans). Supported instruments and
timeframes live in one file: [`backend/config/catalog.js`](backend/config/catalog.js) (add a line to add an instrument).
For local development without Postgres you may use `DATABASE_URL=sqlite:./data/dev.db` (not durable on Render).

```
npm install
cp .env.example .env     # fill in
npm run dev              # http://localhost:10000
npm test                 # automated tests (no credentials or network needed)
npm run smoke            # live check of Postgres, R2, OANDA, Binance, Twelve Data, GitHub (needs real credentials)
```

## 9. What was tested, and what was NOT

### Actually run (176 automated tests, all passing: `npm test`, about 10 s)
| File | Tests | Covers |
|---|---:|---|
| `calendar.test.js` | 20 | complete-day logic, no rolling 24h, UTC boundaries, settle window, current/future/inverted/malformed dates, no shortened ranges, cross-month/year, day states |
| `binformat.test.js` | 13 | round trip, determinism, wrong instrument/timeframe/year, bit-flip, truncation, bad magic/version, duplicates, out-of-order, invalid OHLC, CSV format |
| `datasets.test.js` | 19 | build/reuse, current-year `complete_through`, multi-day catch-up, failure preserves old file, checkpoints, atomic replacement, size-mismatch staging, incomplete/empty/invalid days, corruption rebuild, failed rebuild, hash mismatch, wrong identity, crash-window adoption, DB-loss recovery |
| `lock.test.js` | 8 | first wins, 25 concurrent acquirers give 1 winner, no queue, release, stale recovery, heartbeat, lost-lock abort |
| `exports.test.js` | 22 | CSV content/filtering/inclusive end, single- and cross-year loading, 5-minute expiry to the second, refresh recovery, multiple downloads, expired rejection with object present, cleanup, SYSTEM BUSY, failed-job release, maintenance vs user, catch-up, year transition |
| `recovery.test.js` | 11 | stale lock + orphan jobs, restart before/after expiry, crash during CSV write, abandoned staging, orphan sweep, crash during download, corrupted-data rebuild, row purge |
| `security.test.js` | 14 | injection/traversal inputs, key safety, guessed/malformed tokens, other-session access, no secrets in pages/API/logs, headers/cookie, static traversal, HTTPS redirect, rate limiting |
| `zip.test.js` | 5 | ZIP round trip + CRC, empty/30 MB input, readable by Python `zipfile` and `unzip -t`, source failure, consumer abort, end-to-end download is a valid single-entry `.zip` |
| `format2.test.js` | 11 | catalog (68 + 23 + 1, providers, first years), exact decimal parsing, format v2 round trip/tamper/scales, v1 files still decode, CSV decimals |
| `sources.test.js` | 15 | Binance archive (real zips, checksum, microsecond timestamps, month cache, API fallback, paging, retries) and Twelve Data (windowing, rounding, rate/daily limits, truncation) against faked HTTP |
| `markets.test.js` | 13 | 2018/2021 year enforcement, XAUUSD hidden without a key, crypto and gold end-to-end builds, leading-vs-mid-history empty days, "no data", provider routing |
| `github.test.js` | 18 | offload end-to-end (no R2 export object, 302 redirect, zero bytes through the server), 5-minute expiry + artifact/run cleanup, lock held until ready, timeout/cancel, failed or never-started runs, GitHub REST client |
| `health.test.js` | 7 | `/health` with no services, DB down, job running, shutting down, no rate limit/redirect/cookie, **latency under heavy CPU work**, and a **real `node backend/server.js` process** booting with no config and exiting 0 on SIGTERM |

### NOT tested against real infrastructure (nothing here claims otherwise)
The environment I built this in could not install npm packages (the registry was blocked) and has no access to the providers, so:
* **Cloudflare R2** (`backend/services/r2/storage.js`, AWS SDK v3): tested only through an in-memory double with the same interface. Never run.
* **PostgreSQL** (`createPgDb`, `pg`): never run. The SQL is a portable subset executed against SQLite in the tests.
* **OANDA, Binance and Twelve Data**: tested only against fakes built from their documented formats (including real ZIP archives for Binance), never against the live services.
  In particular I could not confirm **that your Twelve Data plan includes 1-minute XAU/USD history back to 2021** (the free plan may not), nor the exact
  Binance archive file layout of every pair/month (listing dates differ per pair).
* **GitHub Actions** (`.github/workflows/export-csv.yml`, the REST calls, the artifact redirect): the REST client is tested against a faked API and the workflow's
  script (`scripts/export-csv.js`) was run locally for input validation, but the workflow itself has **never run on GitHub**, and the exact response of GitHub's
  artifact download endpoint (302 with a signed URL) is taken from its documentation.
* **Render deployment** and the keep-alive ping: not deployed.

**Run `npm run smoke` on first deploy.** It exercises Postgres (lock), R2 (put/head/copy/get/list/delete/multipart), one real OANDA day, one real Binance API day,
one real Binance archive month (checksum verified), one XAU/USD window (if the key is set) and the GitHub token's access to the workflow, and prints PASS/FAIL per step.
Then request a small recent range once for a forex pair, a crypto pair and XAU/USD and download each ZIP, to prove the GitHub path end to end.

## 10. Decisions I made where the spec was silent
* Jobs run **asynchronously** (202 + polling) because Render cuts long HTTP requests; the lock is held by the background job.
* Validation of the request happens **before** taking the lock (cheap and stateless); everything else is inside it.
* Past years are built **whole** (see the free-tier note) so completed-year files are immutable; the current year is built only as far as needed by a request, and by maintenance up to the latest verifiable day.
* Exports are tied to an **anonymous cookie** (no accounts) for refresh recovery; the download link itself works as a bearer token for 5 minutes.
* `DAY_SETTLE_MINUTES`, `CHECKPOINT_DAYS`, `MAX_EXPORT_DAYS`, `MIN_DATA_YEAR` are safety parameters of mine, all configurable.
* Forex prices are mid prices stored as integers x 1e5 (anything finer is rejected, not rounded). Crypto needs 8 decimals and values beyond 32 bits, so it uses format v2
  (integers x 1e8 held in float64, exact up to 2^53). Twelve Data prices beyond 5 decimals are rounded half-up (documented).
* Past crypto years are built whole from the archive; the in-progress month always comes from the API.
* The GitHub token is only ever used by the server; browsers never see it. Downloads are authorised by our own token + expiry before any redirect is issued.
* The server keeps holding the global lock while GitHub builds the file (a minute or so), matching "lock covers generate, store, authorize".

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
backend/services/    oanda/ binance/ twelvedata/ github/ sources/ r2/ datasets/ exports/ jobs/
backend/workers/     cleanup + recovery, maintenance, keep-alive
scripts/smoke.js     live-infrastructure check
scripts/export-csv.js  runs inside GitHub Actions: R2 -> verified CSV
.github/workflows/export-csv.yml   the export workflow
tests/               176 tests + helpers (in-memory R2, fake OANDA/Binance/Twelve Data/GitHub, harness)
docs/BINARY_FORMAT.md
render.yaml  .env.example  package.json
```
