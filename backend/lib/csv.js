// CSV generation. Format (documented in README):
//   header : timestamp,open,high,low,close,volume
//   rows   : 2025-06-15T00:00:00Z,1.07123,1.07150,1.07101,1.07140,57
//   - timestamp is ISO 8601 UTC with a trailing Z and second precision (candle OPEN time)
//   - prices are decimal, at least the instrument's display decimals, up to 5, no thousands separators
//   - volume is an integer tick count; line ending is \n
// Produced as an async generator of Buffers so memory stays flat and the event loop stays free.

import { PRICE_SCALE } from './candles.js';
import { yieldToLoop } from './yield.js';

export const CSV_HEADER = 'timestamp,open,high,low,close,volume\n';

const PAD2 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const FRACTION_DIGITS = String(PRICE_SCALE).length - 1; // 5
const LINES_PER_CHUNK = 2000;

export function formatPrice(scaled, minDecimals) {
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const whole = Math.floor(abs / PRICE_SCALE);
  const frac = String(abs % PRICE_SCALE).padStart(FRACTION_DIGITS, '0');
  let end = FRACTION_DIGITS;
  while (end > minDecimals && frac.charCodeAt(end - 1) === 48) end--;
  return `${negative ? '-' : ''}${whole}.${frac.slice(0, end)}`;
}

export function formatTimestamp(tsSec) {
  const day = Math.floor(tsSec / 86_400);
  const s = tsSec - day * 86_400;
  const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
  return `${date}T${PAD2[Math.floor(s / 3600)]}:${PAD2[Math.floor((s % 3600) / 60)]}:${PAD2[s % 60]}Z`;
}

/**
 * @param segments  [{ set: CandleSet, from: number, to: number }] index ranges [from, to), in
 *                  chronological order across segments.
 */
export async function* csvChunks(segments, { displayDecimals }) {
  yield Buffer.from(CSV_HEADER, 'ascii');

  let cachedDay = -1;
  let cachedDate = '';
  let lines = '';
  let count = 0;

  for (const { set, from, to } of segments) {
    for (let i = from; i < to; i++) {
      const ts = set.ts[i];
      const day = Math.floor(ts / 86_400);
      if (day !== cachedDay) {
        cachedDay = day;
        cachedDate = `${new Date(day * 86_400_000).toISOString().slice(0, 10)}T`;
      }
      const s = ts - day * 86_400;
      lines +=
        `${cachedDate}${PAD2[Math.floor(s / 3600)]}:${PAD2[Math.floor((s % 3600) / 60)]}:${PAD2[s % 60]}Z,` +
        `${formatPrice(set.o[i], displayDecimals)},${formatPrice(set.h[i], displayDecimals)},` +
        `${formatPrice(set.l[i], displayDecimals)},${formatPrice(set.c[i], displayDecimals)},${set.v[i]}\n`;

      if (++count === LINES_PER_CHUNK) {
        yield Buffer.from(lines, 'ascii');
        lines = '';
        count = 0;
        await yieldToLoop();
      }
    }
  }
  if (lines) yield Buffer.from(lines, 'ascii');
}
