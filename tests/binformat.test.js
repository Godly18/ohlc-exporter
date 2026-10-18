import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CandleSet } from '../backend/lib/candles.js';
import { decodeDataset, encodeDataset, HEADER_SIZE, parseHeader, RECORD_SIZE } from '../backend/lib/binformat.js';
import { csvChunks, formatPrice, formatTimestamp } from '../backend/lib/csv.js';
import { FormatError } from '../backend/lib/errors.js';
import { dayStartSec } from '../backend/lib/time.js';
import { validateCandleSet, validateDayCandles } from '../backend/lib/validation.js';

const ID = { instrument: 'EUR_USD', timeframe: 'M1', year: 2025 };
const T0 = dayStartSec('2025-03-03'); // Monday

function sampleSet(n = 10) {
  const set = new CandleSet();
  for (let i = 0; i < n; i++) set.push(T0 + i * 60, 100_000 + i, 100_010 + i, 99_990 + i, 100_005 + i, 5 + i);
  return set;
}
const meta = { ...ID, completeThrough: '2025-03-03' };

describe('binary dataset format', () => {
  it('round-trips and records identity, count, coverage', async () => {
    const buf = await encodeDataset(sampleSet(), meta);
    assert.equal(buf.length, HEADER_SIZE + 10 * RECORD_SIZE);
    const header = parseHeader(buf);
    assert.deepEqual(
      { i: header.instrument, t: header.timeframe, y: header.year, n: header.recordCount, c: header.completeThrough },
      { i: 'EUR_USD', t: 'M1', y: 2025, n: 10, c: '2025-03-03' },
    );
    const { set } = await decodeDataset(buf, ID);
    assert.deepEqual(set.at(3), { ts: T0 + 180, o: 100_003, h: 100_013, l: 99_993, c: 100_008, v: 8 });
  });

  it('is deterministic', async () => {
    const a = await encodeDataset(sampleSet(), meta);
    const b = await encodeDataset(sampleSet(), meta);
    assert.ok(a.equals(b));
  });

  it('rejects wrong instrument, timeframe and year', async () => {
    const buf = await encodeDataset(sampleSet(), meta);
    await assert.rejects(decodeDataset(buf, { ...ID, instrument: 'GBP_USD' }), /wrong instrument/);
    await assert.rejects(decodeDataset(buf, { ...ID, timeframe: 'H1' }), /wrong timeframe/);
    await assert.rejects(decodeDataset(buf, { ...ID, year: 2024 }), /wrong year/);
  });

  it('detects bit corruption (body hash), truncation, bad magic and bad version', async () => {
    const good = await encodeDataset(sampleSet(), meta);
    const flipped = Buffer.from(good);
    flipped[HEADER_SIZE + 30] ^= 0xff;
    await assert.rejects(decodeDataset(flipped, ID), (e) => e instanceof FormatError && /hash mismatch/.test(e.message));

    await assert.rejects(decodeDataset(good.subarray(0, good.length - 7), ID), FormatError);
    await assert.rejects(decodeDataset(good.subarray(0, 40), ID), FormatError);

    const magic = Buffer.from(good);
    magic.write('XXXX', 0, 'ascii');
    await assert.rejects(decodeDataset(magic, ID), /bad magic/);

    const version = Buffer.from(good);
    version.writeUInt16LE(99, 4);
    await assert.rejects(decodeDataset(version, ID), /unsupported format version/);
  });
});

describe('dataset validation', () => {
  const opts = { year: 2025, stepSeconds: 60, completeThrough: '2025-03-03' };

  it('accepts a valid set', async () => assert.equal(await validateCandleSet(sampleSet(), opts), null));

  it('rejects duplicate timestamps', async () => {
    const s = sampleSet();
    s.ts[5] = s.ts[4];
    assert.match(await validateCandleSet(s, opts), /duplicate/);
  });

  it('rejects out-of-order timestamps', async () => {
    const s = sampleSet();
    s.ts[5] = s.ts[2];
    assert.match(await validateCandleSet(s, opts), /out-of-order/);
  });

  it('rejects invalid OHLC relationships', async () => {
    for (const mutate of [(s) => (s.h[2] = s.o[2] - 1), (s) => (s.l[2] = s.c[2] + 1), (s) => (s.h[2] = s.l[2] - 5)]) {
      const s = sampleSet();
      mutate(s);
      assert.match(await validateCandleSet(s, opts), /OHLC/);
    }
  });

  it('rejects timestamps outside the year or beyond claimed coverage, and unaligned ones', async () => {
    const early = sampleSet();
    early.ts[0] = dayStartSec('2024-12-31');
    assert.match(await validateCandleSet(early, opts), /outside/);

    const late = sampleSet();
    assert.match(await validateCandleSet(late, { ...opts, completeThrough: '2025-03-02' }), /outside covered range/);

    const unaligned = sampleSet();
    unaligned.ts[1] += 7;
    assert.match(await validateCandleSet(unaligned, opts), /aligned/);
  });

  it('validates a day batch', () => {
    const good = [{ ts: T0, o: 1, h: 2, l: 1, c: 2, v: 1 }];
    assert.equal(validateDayCandles(good, '2025-03-03', 60), null);
    assert.match(validateDayCandles(good, '2025-03-04', 60), /outside requested day/);
    assert.match(validateDayCandles([{ ...good[0], h: 0 }], '2025-03-03', 60), /non-positive|OHLC/);
  });
});

describe('CSV output', () => {
  it('formats prices losslessly with a minimum number of decimals', () => {
    assert.equal(formatPrice(107_123, 5), '1.07123');
    assert.equal(formatPrice(107_100, 5), '1.07100');
    assert.equal(formatPrice(15_023_400, 3), '150.234');
    assert.equal(formatPrice(15_023_000, 3), '150.230'.slice(0, 7)); // 150.23 padded to >=3 decimals
    assert.equal(formatPrice(100_000, 3), '1.000');
  });

  it('formats UTC timestamps as ISO-8601 with Z', () => {
    assert.equal(formatTimestamp(T0), '2025-03-03T00:00:00Z');
    assert.equal(formatTimestamp(T0 + 3600 * 23 + 60 * 59 + 59), '2025-03-03T23:59:59Z');
  });

  it('emits the header and rows in order', async () => {
    const chunks = [];
    for await (const c of csvChunks([{ set: sampleSet(3), from: 0, to: 3 }], { displayDecimals: 5 })) chunks.push(c);
    const lines = Buffer.concat(chunks).toString().trimEnd().split('\n');
    assert.equal(lines[0], 'timestamp,open,high,low,close,volume');
    assert.equal(lines.length, 4);
    assert.equal(lines[1], '2025-03-03T00:00:00Z,1.00000,1.00010,0.99990,1.00005,5');
  });
});
