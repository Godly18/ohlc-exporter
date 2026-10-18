# Yearly dataset binary format (version 1)

One file per **instrument / timeframe / year**, stored in Cloudflare R2 at
`oanda-data/<INSTRUMENT>/<TIMEFRAME>/<YEAR>.bin` (e.g. `oanda-data/EUR_USD/M1/2025.bin`).
All integers are little-endian. The file is self-describing: identity, coverage and an integrity hash
live in the header, so a file can be verified without trusting the database.

## Header (80 bytes)

| Offset | Size | Type   | Field             | Notes                                              |
|-------:|-----:|--------|-------------------|----------------------------------------------------|
| 0      | 4    | ASCII  | magic             | `OAND`                                             |
| 4      | 2    | uint16 | format version    | `1`                                                |
| 6      | 2    | uint16 | header size       | `80`                                               |
| 8      | 16   | ASCII  | instrument        | NUL padded, e.g. `EUR_USD`                         |
| 24     | 8    | ASCII  | timeframe         | NUL padded, e.g. `M1`                              |
| 32     | 2    | uint16 | year              | e.g. `2025`                                        |
| 34     | 2    | uint16 | record size       | `24`                                               |
| 36     | 4    | uint32 | price scale       | `100000` (prices are integers = price x 1e5)       |
| 40     | 4    | uint32 | record count      | file size must equal `80 + count x 24`             |
| 44     | 4    | uint32 | complete-through  | `YYYYMMDD` of the last fully verified UTC day, `0` = none |
| 48     | 32   | bytes  | body SHA-256      | SHA-256 of the record region (bytes 80 to end)     |

## Record (24 bytes)

| Offset | Size | Type   | Field     |
|-------:|-----:|--------|-----------|
| 0      | 4    | uint32 | timestamp (UTC seconds, candle open time) |
| 4      | 4    | int32  | open  (x 1e5) |
| 8      | 4    | int32  | high  (x 1e5) |
| 12     | 4    | int32  | low   (x 1e5) |
| 16     | 4    | int32  | close (x 1e5) |
| 20     | 4    | uint32 | volume (tick count) |

Mid prices (`price=M`) are stored. A full year of M1 data is roughly 370,000 records, about 9 MB.

## Rules enforced on every load

* magic, version, header/record sizes, price scale and `size == 80 + count x 24`
* instrument, timeframe and year equal the identity requested (a file in the wrong place is corrupt)
* SHA-256 of the body equals the header hash (detects any bit flip or truncation)
* timestamps are aligned to the timeframe, inside the year, **not after `complete-through`**,
  strictly increasing (so no duplicates, no disorder)
* `high >= open, close, low`, `low <= open, close`, all prices positive
* the database's recorded SHA-256 of the whole file matches (or equals the recorded *pending* hash,
  which means a crash happened after the atomic copy but before the metadata commit; the file is
  then adopted)

`complete-through` is how the current year is represented: `2026.bin` with `complete-through =
20260913` is valid and complete through September 13 and contains nothing from the in-progress day.
A year becomes `COMPLETE` when `complete-through` reaches December 31.

## Writing (atomic promotion)

1. Build the full new dataset in memory (existing verified records + newly downloaded complete days).
2. Encode it, then decode and validate the encoded bytes (what is stored must itself verify).
3. Record `pending_sha256` / `pending_complete_date` in the database.
4. Upload to `<year>.bin.tmp` and confirm the staged size.
5. Server-side copy `<year>.bin.tmp` to `<year>.bin` (a single atomic object replacement), delete the `.tmp`.
6. Commit metadata (status, coverage, hash) and clear the pending marker.

The previous `<year>.bin` is untouched until step 5, so a failure at any earlier point leaves the old
known-good dataset in place. A corrupted file is copied to `oanda-data/_quarantine/...` and rebuilt.
