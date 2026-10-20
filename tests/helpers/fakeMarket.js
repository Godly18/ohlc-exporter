// Deterministic fake providers with the same interface as the real Binance / Twelve Data clients:
//   fetchDayCandles({instrument, timeframe, date, lastDay, signal}) -> { candles, incompleteCount }
// Crypto: trades 24/7, prices x1e8, volume x1e8, optional `listedFrom` (days before it are empty).
// Gold:   like forex (closed Saturdays, thin Friday/Sunday), prices x1e5.

import { dayStartSec } from '../../backend/lib/time.js';

function base(extra) {
  const fake = {
    calls: [],
    failOn: null,
    emptyDays: new Set(),
    incompleteDays: new Set(),
    gate: null,
    ...extra,
  };
  return fake;
}

export function createFakeBinance({ stride = 60, listedFrom = null } = {}) {
  const fake = base({ stride, listedFrom });
  fake.fetchDayCandles = async ({ instrument, timeframe, date, lastDay, signal }) => {
    fake.calls.push({ instrument, timeframe, date, lastDay });
    if (fake.gate) await fake.gate;
    signal?.throwIfAborted();
    const failure = fake.failOn?.(date);
    if (failure) throw failure;
    const candles = [];
    const listed = !fake.listedFrom || date >= fake.listedFrom;
    if (listed && !fake.emptyDays.has(date)) {
      const baseTs = dayStartSec(date);
      for (let minute = 0; minute < 1440; minute += fake.stride) {
        const ts = baseTs + minute * 60;
        const o = 6_500_000_000_000 + ((ts / 60) % 97) * 1_000_000; // 65000.00xxx
        const c = o + (((ts / 60) % 13) - 6) * 100_000;
        candles.push({ ts, o, h: Math.max(o, c) + 500_000, l: Math.min(o, c) - 500_000, c, v: (1 + ((ts / 60) % 50)) * 12_345_678 });
      }
    }
    return { candles, incompleteCount: fake.incompleteDays.has(date) ? candles.length : 0 };
  };
  return fake;
}

export function createFakeTwelve({ stride = 30 } = {}) {
  const fake = base({ stride });
  fake.fetchDayCandles = async ({ instrument, timeframe, date, lastDay, signal }) => {
    fake.calls.push({ instrument, timeframe, date, lastDay });
    if (fake.gate) await fake.gate;
    signal?.throwIfAborted();
    const failure = fake.failOn?.(date);
    if (failure) throw failure;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const baseTs = dayStartSec(date);
    const candles = [];
    if (!fake.emptyDays.has(date)) {
      for (let minute = 0; minute < 1440; minute += fake.stride) {
        if (dow === 6) break;
        if (dow === 0 && minute < 22 * 60) continue;
        if (dow === 5 && minute >= 22 * 60) continue;
        const ts = baseTs + minute * 60;
        const o = 200_000_000 + ((ts / 60) % 97) * 100; // 2000.00xx
        const c = o + (((ts / 60) % 13) - 6) * 10;
        candles.push({ ts, o, h: Math.max(o, c) + 50, l: Math.min(o, c) - 50, c, v: 0 });
      }
    }
    return { candles, incompleteCount: 0 };
  };
  return fake;
}
