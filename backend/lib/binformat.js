// Binary yearly dataset format, version 1. Documented in docs/BINARY_FORMAT.md.
//
//   Header (80 bytes, little-endian)
//     0   4  magic "OAND"
//     4   2  format version (1)
//     6   2  header size (80)
//     8  16  instrument, ASCII, NUL padded
//    24   8  timeframe, ASCII, NUL padded
//    32   2  year
//    34   2  record size (24)
//    36   4  price scale (100000)
//    40   4  record count
//    44   4  complete-through date as YYYYMMDD (0 = none)
//    48  32  SHA-256 of the record region
//
//   Records (24 bytes each)
//     0 uint32 timestamp (UTC seconds)   4 int32 open   8 int32 high
//    12 int32 low   16 int32 close   20 uint32 volume
//
// The header is self-describing: a file alone proves its identity, coverage and integrity.

import { createHash } from 'node:crypto';
import { CandleSet, PRICE_SCALE } from './candles.js';
import { FormatError } from './errors.js';
import { compactToDate, dateToCompact } from './time.js';
import { YIELD_EVERY, yieldToLoop } from './yield.js';

export const MAGIC = 'OAND';
export const FORMAT_VERSION = 1;
export const HEADER_SIZE = 80;
export const RECORD_SIZE = 24;

const HASH_CHUNK = 1 << 20;

/** SHA-256 hex of a buffer, hashed in slices so the event loop is never starved. */
export async function sha256Async(buf) {
  const hash = createHash('sha256');
  for (let off = 0; off < buf.length; off += HASH_CHUNK) {
    hash.update(buf.subarray(off, Math.min(off + HASH_CHUNK, buf.length)));
    await yieldToLoop();
  }
  return hash.digest('hex');
}

export async function encodeDataset(set, { instrument, timeframe, year, completeThrough }) {
  if (instrument.length > 16 || timeframe.length > 8) throw new FormatError('identity too long for header');
  const n = set.length;
  const buf = Buffer.alloc(HEADER_SIZE + n * RECORD_SIZE);

  let off = HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(set.ts[i], off);
    buf.writeInt32LE(set.o[i], off + 4);
    buf.writeInt32LE(set.h[i], off + 8);
    buf.writeInt32LE(set.l[i], off + 12);
    buf.writeInt32LE(set.c[i], off + 16);
    buf.writeUInt32LE(set.v[i], off + 20);
    off += RECORD_SIZE;
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await yieldToLoop();
  }

  const bodyHash = createHash('sha256');
  for (let o = HEADER_SIZE; o < buf.length; o += HASH_CHUNK) {
    bodyHash.update(buf.subarray(o, Math.min(o + HASH_CHUNK, buf.length)));
    await yieldToLoop();
  }
  const bodySha = bodyHash.digest();

  buf.write(MAGIC, 0, 4, 'ascii');
  buf.writeUInt16LE(FORMAT_VERSION, 4);
  buf.writeUInt16LE(HEADER_SIZE, 6);
  buf.write(instrument, 8, 16, 'ascii');
  buf.write(timeframe, 24, 8, 'ascii');
  buf.writeUInt16LE(year, 32);
  buf.writeUInt16LE(RECORD_SIZE, 34);
  buf.writeUInt32LE(PRICE_SCALE, 36);
  buf.writeUInt32LE(n, 40);
  buf.writeUInt32LE(completeThrough ? dateToCompact(completeThrough) : 0, 44);
  bodySha.copy(buf, 48);
  return buf;
}

function readAscii(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('ascii');
}

export function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) throw new FormatError('file shorter than header');
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new FormatError('bad magic');
  const version = buf.readUInt16LE(4);
  if (version !== FORMAT_VERSION) throw new FormatError(`unsupported format version ${version}`);
  const headerSize = buf.readUInt16LE(6);
  const recordSize = buf.readUInt16LE(34);
  if (headerSize !== HEADER_SIZE || recordSize !== RECORD_SIZE) throw new FormatError('unexpected layout sizes');
  const priceScale = buf.readUInt32LE(36);
  if (priceScale !== PRICE_SCALE) throw new FormatError('unexpected price scale');
  const recordCount = buf.readUInt32LE(40);
  if (buf.length !== HEADER_SIZE + recordCount * RECORD_SIZE) throw new FormatError('size does not match record count');
  const compact = buf.readUInt32LE(44);
  return {
    version,
    instrument: readAscii(buf, 8, 16),
    timeframe: readAscii(buf, 24, 8),
    year: buf.readUInt16LE(32),
    recordCount,
    completeThrough: compact === 0 ? null : compactToDate(compact),
    bodySha256: buf.subarray(48, 80).toString('hex'),
  };
}

/**
 * Parse and integrity-check a dataset file: header identity vs `expected`, size, body hash,
 * then decode the records. Semantic validation (ordering, OHLC, ...) is validateCandleSet().
 */
export async function decodeDataset(buf, expected) {
  const header = parseHeader(buf);
  if (expected) {
    if (header.instrument !== expected.instrument) throw new FormatError('wrong instrument');
    if (header.timeframe !== expected.timeframe) throw new FormatError('wrong timeframe');
    if (header.year !== expected.year) throw new FormatError('wrong year');
  }
  const body = buf.subarray(HEADER_SIZE);
  const actual = createHash('sha256');
  for (let o = 0; o < body.length; o += HASH_CHUNK) {
    actual.update(body.subarray(o, Math.min(o + HASH_CHUNK, body.length)));
    await yieldToLoop();
  }
  if (actual.digest('hex') !== header.bodySha256) throw new FormatError('body hash mismatch');

  const set = new CandleSet(header.recordCount || 16);
  let off = HEADER_SIZE;
  for (let i = 0; i < header.recordCount; i++) {
    set.push(
      buf.readUInt32LE(off),
      buf.readInt32LE(off + 4),
      buf.readInt32LE(off + 8),
      buf.readInt32LE(off + 12),
      buf.readInt32LE(off + 16),
      buf.readUInt32LE(off + 20),
    );
    off += RECORD_SIZE;
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await yieldToLoop();
  }
  return { header, set };
}
