// Binary yearly dataset formats (version 1 and 2). Documented in docs/BINARY_FORMAT.md.
//
//   Version 1 (forex, gold): 80-byte header, 24-byte records, int32 prices x1e5, uint32 volume.
//   Version 2 (crypto):      96-byte header, 44-byte records, prices and volume as float64 holding exact
//                            integers (scaled x1e8). Header gets the volume scale at offset 80.
//
//   Header common part (little-endian)
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
//   Version 1 record (24 bytes)
//     0 uint32 timestamp (UTC seconds)   4 int32 open   8 int32 high
//    12 int32 low   16 int32 close   20 uint32 volume
//   Version 2 record (44 bytes)
//     0 uint32 timestamp   4 f64 open   12 f64 high   20 f64 low   28 f64 close   36 f64 volume
//
// The header is self-describing: a file alone proves its identity, coverage and integrity.

import { createHash } from 'node:crypto';
import { getInstrument } from '../config/catalog.js';
import { CandleSet, PRICE_SCALE } from './candles.js';
import { FormatError } from './errors.js';
import { compactToDate, dateToCompact } from './time.js';
import { YIELD_EVERY, yieldToLoop } from './yield.js';

export const MAGIC = 'OAND';
export const FORMAT_VERSION = 1; // default / forex layout
export const HEADER_SIZE = 80;
export const RECORD_SIZE = 24;

export const LAYOUTS = Object.freeze({
  1: Object.freeze({ headerSize: 80, recordSize: 24 }),
  2: Object.freeze({ headerSize: 96, recordSize: 44 }),
});

/** Layout and scales for an instrument; unknown identities (tests) use the forex defaults. */
function specFor(instrument) {
  const inst = getInstrument(instrument);
  return {
    version: inst?.formatVersion ?? 1,
    priceScale: inst?.priceScale ?? PRICE_SCALE,
    volumeScale: inst?.volumeScale ?? 1,
  };
}

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

export async function encodeDataset(set, { instrument, timeframe, year, completeThrough, version, priceScale, volumeScale }) {
  if (instrument.length > 16 || timeframe.length > 8) throw new FormatError('identity too long for header');
  const spec = specFor(instrument);
  const ver = version ?? spec.version;
  const pScale = priceScale ?? spec.priceScale;
  const vScale = volumeScale ?? spec.volumeScale;
  const layout = LAYOUTS[ver];
  if (!layout) throw new FormatError(`unsupported format version ${ver}`);
  const { headerSize, recordSize } = layout;

  const n = set.length;
  const buf = Buffer.alloc(headerSize + n * recordSize);

  let off = headerSize;
  try {
    for (let i = 0; i < n; i++) {
      buf.writeUInt32LE(set.ts[i], off);
      if (ver === 1) {
        buf.writeInt32LE(set.o[i], off + 4);
        buf.writeInt32LE(set.h[i], off + 8);
        buf.writeInt32LE(set.l[i], off + 12);
        buf.writeInt32LE(set.c[i], off + 16);
        buf.writeUInt32LE(set.v[i], off + 20);
      } else {
        buf.writeDoubleLE(set.o[i], off + 4);
        buf.writeDoubleLE(set.h[i], off + 12);
        buf.writeDoubleLE(set.l[i], off + 20);
        buf.writeDoubleLE(set.c[i], off + 28);
        buf.writeDoubleLE(set.v[i], off + 36);
      }
      off += recordSize;
      if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await yieldToLoop();
    }
  } catch (err) {
    if (err?.code === 'ERR_OUT_OF_RANGE') throw new FormatError('value does not fit the dataset layout');
    throw err;
  }

  const bodyHash = createHash('sha256');
  for (let o = headerSize; o < buf.length; o += HASH_CHUNK) {
    bodyHash.update(buf.subarray(o, Math.min(o + HASH_CHUNK, buf.length)));
    await yieldToLoop();
  }
  const bodySha = bodyHash.digest();

  buf.write(MAGIC, 0, 4, 'ascii');
  buf.writeUInt16LE(ver, 4);
  buf.writeUInt16LE(headerSize, 6);
  buf.write(instrument, 8, 16, 'ascii');
  buf.write(timeframe, 24, 8, 'ascii');
  buf.writeUInt16LE(year, 32);
  buf.writeUInt16LE(recordSize, 34);
  buf.writeUInt32LE(pScale, 36);
  buf.writeUInt32LE(n, 40);
  buf.writeUInt32LE(completeThrough ? dateToCompact(completeThrough) : 0, 44);
  bodySha.copy(buf, 48);
  if (ver === 2) buf.writeUInt32LE(vScale, 80); // bytes 84..95 stay zero (reserved)
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
  const layout = LAYOUTS[version];
  if (!layout) throw new FormatError(`unsupported format version ${version}`);
  if (buf.length < layout.headerSize) throw new FormatError('file shorter than header');
  const headerSize = buf.readUInt16LE(6);
  const recordSize = buf.readUInt16LE(34);
  if (headerSize !== layout.headerSize || recordSize !== layout.recordSize) throw new FormatError('unexpected layout sizes');
  const priceScale = buf.readUInt32LE(36);
  let volumeScale = 1;
  if (version === 1) {
    if (priceScale !== PRICE_SCALE) throw new FormatError('unexpected price scale');
  } else {
    volumeScale = buf.readUInt32LE(80);
    if (priceScale < 1 || volumeScale < 1) throw new FormatError('unexpected scale');
  }
  const recordCount = buf.readUInt32LE(40);
  if (buf.length !== headerSize + recordCount * recordSize) throw new FormatError('size does not match record count');
  const compact = buf.readUInt32LE(44);
  return {
    version,
    headerSize,
    recordSize,
    priceScale,
    volumeScale,
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
    if (expected.priceScale !== undefined && header.priceScale !== expected.priceScale) throw new FormatError('wrong price scale');
    if (expected.volumeScale !== undefined && header.volumeScale !== expected.volumeScale) throw new FormatError('wrong volume scale');
  }
  const { headerSize, recordSize, version } = header;
  const body = buf.subarray(headerSize);
  const actual = createHash('sha256');
  for (let o = 0; o < body.length; o += HASH_CHUNK) {
    actual.update(body.subarray(o, Math.min(o + HASH_CHUNK, body.length)));
    await yieldToLoop();
  }
  if (actual.digest('hex') !== header.bodySha256) throw new FormatError('body hash mismatch');

  const set = new CandleSet(header.recordCount || 16);
  let off = headerSize;
  for (let i = 0; i < header.recordCount; i++) {
    if (version === 1) {
      set.push(
        buf.readUInt32LE(off),
        buf.readInt32LE(off + 4),
        buf.readInt32LE(off + 8),
        buf.readInt32LE(off + 12),
        buf.readInt32LE(off + 16),
        buf.readUInt32LE(off + 20),
      );
    } else {
      const o = buf.readDoubleLE(off + 4);
      const h = buf.readDoubleLE(off + 12);
      const l = buf.readDoubleLE(off + 20);
      const c = buf.readDoubleLE(off + 28);
      const v = buf.readDoubleLE(off + 36);
      if (!Number.isSafeInteger(o) || !Number.isSafeInteger(h) || !Number.isSafeInteger(l) || !Number.isSafeInteger(c) || !Number.isSafeInteger(v) || v < 0) {
        throw new FormatError(`non-integer value at record ${i}`);
      }
      set.push(buf.readUInt32LE(off), o, h, l, c, v);
    }
    off += recordSize;
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await yieldToLoop();
  }
  return { header, set };
}
