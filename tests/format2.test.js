import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { CRYPTO_MIN_YEAR, XAUUSD_MIN_YEAR, getInstrument, listInstrumentEntries, listInstruments } from '../backend/config/catalog.js';
import { CandleSet } from '../backend/lib/candles.js';
import { decodeDataset, encodeDataset, parseHeader } from '../backend/lib/binformat.js';
import { csvChunks, formatScaled } from '../backend/lib/csv.js';
import { parseDecimalScaled } from '../backend/lib/decimal.js';
import { dayStartSec } from '../backend/lib/time.js';
import { validateCandleSet, validateDayCandles, limitsFor } from '../backend/lib/validation.js';

const CRYPTO_CODES = ['ADABTC', 'BNBBTC', 'DASHBTC', 'ETCBTC', 'ETHBTC', 'LINKBTC', 'LTCBTC', 'TRXBTC', 'XRPBTC', 'ZECBTC', 'ADAETH', 'BNBETH', 'LINKETH', 'LTCETH', 'TRXETH', 'XLMETH', 'XRPETH', 'ZECETH', 'BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'LTCUSDT', 'NEOUSDT'];

describe('instrument catalog', () => {
  it('has 68 forex pairs + the 23 crypto pairs + XAUUSD, each with the right provider and first year', () => {
    const all = listInstrumentEntries();
    assert.equal(all.filter((i) => i.provider === 'oanda').length, 68);
    assert.equal(all.filter((i) => i.provider === 'binance').length, 23);
    assert.equal(all.filter((i) => i.provider === 'twelvedata').length, 1);
    assert.equal(all.length, 92);
    assert.deepEqual(all.filter((i) => i.group === 'Crypto').map((i) => i.code).sort(), [...CRYPTO_CODES].sort());
    for (const code of CRYPTO_CODES) {
      const i = getInstrument(code);
      assert.equal(i.provider, 'binance');
      assert.equal(i.minYear, 2018);
      assert.equal(i.formatVersion, 2);
      assert.equal(i.priceScale, 1e8);
      assert.equal(i.volumeScale, 1e8);
      assert.equal(i.calendar, 'always');
    }
    const gold = getInstrument('XAUUSD');
    assert.equal(gold.provider, 'twelvedata');
    assert.equal(gold.minYear, 2021);
    assert.equal(gold.label, 'XAU/USD');
    assert.equal(CRYPTO_MIN_YEAR, 2018);
    assert.equal(XAUUSD_MIN_YEAR, 2021);
  });

  it('keeps all 68 OANDA pairs and their decimals; codes are unique and key-safe', () => {
    const forex = listInstrumentEntries().filter((i) => i.provider === 'oanda');
    assert.ok(forex.every((i) => /^[A-Z]{3}_[A-Z]{3}$/.test(i.code) && i.formatVersion === 1 && i.priceScale === 1e5));
    assert.equal(getInstrument('USD_HUF').displayDecimals, 3);
    assert.equal(getInstrument('EUR_USD').displayDecimals, 5);
    assert.equal(new Set(listInstruments()).size, listInstruments().length);
    assert.ok(listInstruments().every((c) => /^[A-Z0-9_]{1,16}$/.test(c)));
  });
});

describe('decimal parsing is exact', () => {
  it('converts without floating point error', () => {
    assert.equal(parseDecimalScaled('0.00001234', 8), 1234);
    assert.equal(parseDecimalScaled('65000.01000000', 8), 6_500_001_000_000);
    assert.equal(parseDecimalScaled('1.1', 8), 110_000_000);
    assert.equal(parseDecimalScaled('0.1', 8) + parseDecimalScaled('0.2', 8), parseDecimalScaled('0.3', 8));
    assert.equal(parseDecimalScaled('12', 5), 1_200_000);
    assert.equal(parseDecimalScaled('1812.340000', 5), 181_234_000, 'trailing zeros beyond the scale are fine');
  });
  it('rejects what cannot be stored exactly, and rounds only when asked', () => {
    assert.equal(parseDecimalScaled('1.123456789', 8), null);
    assert.equal(parseDecimalScaled('1812.3456789', 5, { round: true }), 181_234_568);
    assert.equal(parseDecimalScaled('1812.3456749', 5, { round: true }), 181_234_567);
    for (const bad of ['', 'abc', '-1', '1e5', '1.2.3', null, undefined, NaN, '99999999999999999']) assert.equal(parseDecimalScaled(bad, 8), null);
  });
});

describe('binary format v2 (crypto)', () => {
  const bigSet = () => {
    const set = new CandleSet(8);
    const t = dayStartSec('2026-03-01');
    set.push(t, 12_500_000_000_000, 12_600_000_000_000, 12_400_000_000_000, 12_550_000_000_000, 123_456_789_012); // 125,000.00 BTC-ish
    set.push(t + 60, 1234, 1300, 1200, 1250, 5_000_000_000_000_000); // 0.00001234 with a huge volume
    return set;
  };
  const id = { instrument: 'BTCUSDT', timeframe: 'M1', year: 2026 };

  it('round-trips prices far beyond int32 and volumes with 8 decimals', async () => {
    const buf = await encodeDataset(bigSet(), { ...id, completeThrough: '2026-03-01' });
    const header = parseHeader(buf);
    assert.equal(header.version, 2);
    assert.equal(header.headerSize, 96);
    assert.equal(header.recordSize, 44);
    assert.equal(header.priceScale, 1e8);
    assert.equal(header.volumeScale, 1e8);
    assert.equal(buf.length, 96 + 2 * 44);
    const { set } = await decodeDataset(buf, { ...id, priceScale: 1e8, volumeScale: 1e8 });
    assert.deepEqual(set.at(0), bigSet().at(0));
    assert.deepEqual(set.at(1), bigSet().at(1));
    assert.equal(await validateCandleSet(set, { year: 2026, stepSeconds: 60, completeThrough: '2026-03-01' }), null);
  });

  it('is deterministic, detects bit flips/truncation and wrong scales, and rejects non-integers', async () => {
    const a = await encodeDataset(bigSet(), { ...id, completeThrough: '2026-03-01' });
    const b = await encodeDataset(bigSet(), { ...id, completeThrough: '2026-03-01' });
    assert.ok(a.equals(b));
    const flipped = Buffer.from(a);
    flipped[100] ^= 1;
    await assert.rejects(decodeDataset(flipped, id), /hash mismatch/);
    await assert.rejects(decodeDataset(a.subarray(0, a.length - 1), id), /size does not match/);
    await assert.rejects(decodeDataset(a, { ...id, priceScale: 1e5 }), /wrong price scale/);
    await assert.rejects(decodeDataset(a, { ...id, volumeScale: 1 }), /wrong volume scale/);

    const fractional = Buffer.from(a);
    fractional.writeDoubleLE(1.5, 96 + 4); // open = 1.5: not an integer
    createHash('sha256').update(fractional.subarray(96)).digest().copy(fractional, 48); // keep the hash valid
    await assert.rejects(decodeDataset(fractional, id), /non-integer/);
  });

  it('refuses a value that does not fit the v1 layout instead of corrupting it', async () => {
    await assert.rejects(encodeDataset(bigSet(), { instrument: 'EUR_USD', timeframe: 'M1', year: 2026, completeThrough: '2026-03-01' }), /does not fit/);
  });

  it('version 1 files (existing forex data) still decode', async () => {
    const set = new CandleSet(4);
    set.push(dayStartSec('2026-03-02'), 107_123, 107_150, 107_101, 107_140, 57);
    const buf = await encodeDataset(set, { instrument: 'EUR_USD', timeframe: 'M1', year: 2026, completeThrough: '2026-03-02' });
    assert.equal(parseHeader(buf).version, 1);
    assert.equal(buf.length, 80 + 24);
    const { set: back } = await decodeDataset(buf, { instrument: 'EUR_USD', timeframe: 'M1', year: 2026, priceScale: 1e5, volumeScale: 1 });
    assert.deepEqual(back.at(0), set.at(0));
    await assert.rejects(decodeDataset(buf, { instrument: 'EUR_USD', timeframe: 'M1', year: 2026, priceScale: 1e8 }), /wrong price scale/);
  });

  it('day validation uses the right limits per layout', () => {
    const day = '2026-03-01';
    const ts = dayStartSec(day);
    const candle = { ts, o: 5_000_000_000, h: 5_000_000_100, l: 4_999_999_900, c: 5_000_000_050, v: 5_000_000_000 };
    assert.match(validateDayCandles([candle], day, 60), /out of range/); // v1 limit
    assert.equal(validateDayCandles([candle], day, 60, limitsFor(getInstrument('BTCUSDT'))), null);
    assert.match(validateDayCandles([{ ...candle, o: 1.5 }], day, 60, limitsFor(getInstrument('BTCUSDT'))), /invalid price/);
  });
});

describe('CSV formatting by scale', () => {
  it('prints crypto prices/volumes exactly with trimmed zeros, and forex as before', () => {
    assert.equal(formatScaled(6_500_000_000_000, 2, 1e8), '65000.00');
    assert.equal(formatScaled(6_500_000_300_000, 2, 1e8), '65000.003');
    assert.equal(formatScaled(1234, 6, 1e8), '0.000012'.replace('0.000012', '0.00001234'));
    assert.equal(formatScaled(12_345_678, 0, 1e8), '0.12345678');
    assert.equal(formatScaled(100_000_000, 0, 1e8), '1');
    assert.equal(formatScaled(0, 0, 1e8), '0');
    assert.equal(formatScaled(107_123, 5, 1e5), '1.07123');
    assert.equal(formatScaled(10_700_000, 3, 1e5), '107.000');
  });

  it('csvChunks writes the whole row for a crypto candle', async () => {
    const set = new CandleSet(2);
    set.push(dayStartSec('2026-03-01') + 60, 1234, 1300, 1200, 1250, 12_345_678_000);
    const parts = [];
    for await (const c of csvChunks([{ set, from: 0, to: 1 }], { displayDecimals: 6, priceScale: 1e8, volumeScale: 1e8 })) parts.push(c);
    assert.equal(Buffer.concat(parts).toString(), 'timestamp,open,high,low,close,volume\n2026-03-01T00:01:00Z,0.00001234,0.000013,0.000012,0.0000125,123.45678\n');
  });
});
