// Builds the export CSV from the permanent yearly datasets in R2. Used by the GitHub Actions workflow
// (scripts/export-csv.js) so the server itself never reads, zips or serves the file in production, and by
// the server's local-development mode. Everything is re-verified here (identity, SHA-256, ordering, OHLC):
// a file is only produced from data that passes verification. Holes in the data (missing days/minutes) and
// a year that was only partly retrieved are NOT errors: the CSV holds every candle that exists, and a
// missing-data report (written next to it, so both end up in the same ZIP) lists what is not there.

import { once } from 'node:events';
import { createWriteStream, writeFileSync } from 'node:fs';
import { getInstrument, getTimeframe } from '../config/catalog.js';
import { decodeDataset } from './binformat.js';
import { csvChunks } from './csv.js';
import { buildGapReport } from './gaps.js';
import { FormatError } from './errors.js';
import { loadSkipped } from './skipped.js';
import { addDays, dayStartSec, yearEndDate, yearStartDate, yearsInRange } from './time.js';
import { validateCandleSet } from './validation.js';
import { datasetKey } from '../services/r2/keys.js';

export class ExportFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportFileError';
  }
}

/** Load + fully verify the yearly datasets for a request and return CSV segments. */
export async function loadSegments({ storage, instrument, timeframe, start, end }) {
  const inst = getInstrument(instrument);
  const tf = getTimeframe(timeframe);
  if (!inst || !tf) throw new ExportFileError('unsupported instrument or timeframe');

  const segments = [];
  const notes = [];
  const skipped = [];
  let rows = 0;
  for (const year of yearsInRange(start, end)) {
    const buf = await storage.getObjectBuffer(datasetKey(instrument, timeframe, year));
    if (!buf) {
      notes.push(`dataset ${instrument}/${timeframe}/${year} is not in storage; skipped`);
      continue;
    }
    let decoded;
    try {
      decoded = await decodeDataset(buf, { instrument, timeframe, year, priceScale: inst.priceScale, volumeScale: inst.volumeScale });
    } catch (err) {
      if (err instanceof FormatError) throw new ExportFileError(`dataset ${year} failed verification: ${err.message}`);
      throw err;
    }
    const { header, set } = decoded;
    const from = start > yearStartDate(year) ? start : yearStartDate(year);
    let to = end < yearEndDate(year) ? end : yearEndDate(year);
    if (!header.completeThrough) {
      notes.push(`dataset ${year} has no retrieved days; skipped`);
      continue;
    }
    if (header.completeThrough < to) {
      notes.push(`dataset ${year} was retrieved only through ${header.completeThrough}`);
      to = header.completeThrough;
    }
    if (to < from) continue;
    const reason = await validateCandleSet(set, { year, stepSeconds: tf.seconds, completeThrough: header.completeThrough });
    if (reason) throw new ExportFileError(`dataset ${year} failed validation: ${reason}`);
    const i0 = set.lowerBound(dayStartSec(from));
    const i1 = set.lowerBound(dayStartSec(addDays(to, 1))); // inclusive end date
    segments.push({ set, from: i0, to: i1 });
    skipped.push(...(await loadSkipped(storage, instrument, timeframe, year)).values());
    rows += i1 - i0;
  }
  return { segments, rows, inst, notes, skipped };
}

export const csvOptionsFor = (inst) => ({ displayDecimals: inst.displayDecimals, priceScale: inst.priceScale, volumeScale: inst.volumeScale });

/**
 * Write the CSV (not zipped: GitHub zips artifacts itself) to `outFile`. When `reportFile` is given and the
 * data has holes, the missing-data report is written there too. Returns { rows, bytes, notes, reported }.
 */
export async function writeExportCsv({ storage, instrument, timeframe, start, end, outFile, reportFile = null, extraClosedDates = new Set() }) {
  const { segments, rows, inst, notes, skipped } = await loadSegments({ storage, instrument, timeframe, start, end });
  if (rows === 0) throw new ExportFileError('no candles in the requested range');
  const out = createWriteStream(outFile);
  let bytes = 0;
  try {
    for await (const chunk of csvChunks(segments, csvOptionsFor(inst))) {
      bytes += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    throw err;
  }

  let reported = false;
  if (reportFile) {
    const report = await buildGapReport({
      segments,
      start,
      end,
      stepSeconds: getTimeframe(timeframe).seconds,
      calendar: inst.calendar,
      extraClosedDates,
      skipped,
      instrumentLabel: inst.label,
      instrument,
      timeframe,
    });
    if (report) {
      writeFileSync(reportFile, report.text, 'utf8');
      reported = true;
    }
  }
  return { rows, bytes, notes, reported };
}
