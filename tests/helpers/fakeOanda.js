// Deterministic fake OANDA client (same interface as services/oanda/client.js).
// Market hours: closed all Saturday, Friday closes 22:00 UTC, Sunday opens 22:00 UTC.
// `stride` thins candles (every Nth minute) to keep tests fast; they are still valid M1 candles.

import { dayStartSec } from '../../backend/lib/time.js';

export function createFakeOanda({ stride = 30 } = {}) {
  const fake = {
    calls: [],
    stride,
    failOn: null, // (date) => Error | undefined
    incompleteDays: new Set(),
    emptyDays: new Set(),
    badOhlcDays: new Set(),
    gate: null, // Promise: when set, every fetch waits for it (to hold a job open)
    entered: null, // resolved when the first fetch starts

    async fetchDayCandles({ instrument, timeframe, date, signal }) {
      fake.calls.push({ instrument, timeframe, date });
      fake.onFirstCall?.();
      if (fake.gate) await fake.gate;
      signal?.throwIfAborted();
      const failure = fake.failOn?.(date);
      if (failure) throw failure;

      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const base = dayStartSec(date);
      const candles = [];
      if (!fake.emptyDays.has(date)) {
        for (let minute = 0; minute < 1440; minute += fake.stride) {
          if (dow === 6) break;
          if (dow === 0 && minute < 22 * 60) continue;
          if (dow === 5 && minute >= 22 * 60) continue;
          const ts = base + minute * 60;
          const o = 100_000 + ((ts / 60) % 97) * 10;
          const c = o + (((ts / 60) % 13) - 6) * 3;
          let h = Math.max(o, c) + 5;
          const l = Math.min(o, c) - 5;
          if (fake.badOhlcDays.has(date)) h = l - 1; // invalid on purpose
          candles.push({ ts, o, h, l, c, v: 1 + ((ts / 60) % 50), complete: !fake.incompleteDays.has(date) });
        }
      }
      return { candles, incompleteCount: fake.incompleteDays.has(date) ? candles.length : 0 };
    },
  };
  return fake;
}
