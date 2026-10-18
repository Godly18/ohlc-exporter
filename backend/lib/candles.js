// Columnar in-memory candle storage using typed arrays (24 bytes/candle, no per-candle objects),
// so a full year of M1 data (~370k candles) costs ~9 MB instead of tens of MB of JS objects.
//
// Prices are integers scaled by PRICE_SCALE (1e5). Timestamps are UTC seconds (uint32).

export const PRICE_SCALE = 100_000;
export const MAX_SCALED_PRICE = 2_147_483_647;

export class CandleSet {
  constructor(capacity = 1024) {
    this.length = 0;
    this._cap = Math.max(16, capacity);
    this.ts = new Uint32Array(this._cap);
    this.o = new Int32Array(this._cap);
    this.h = new Int32Array(this._cap);
    this.l = new Int32Array(this._cap);
    this.c = new Int32Array(this._cap);
    this.v = new Uint32Array(this._cap);
  }

  _grow(min) {
    let cap = this._cap;
    while (cap < min) cap *= 2;
    const widen = (old, Ctor) => {
      const next = new Ctor(cap);
      next.set(old.subarray(0, this.length));
      return next;
    };
    this.ts = widen(this.ts, Uint32Array);
    this.o = widen(this.o, Int32Array);
    this.h = widen(this.h, Int32Array);
    this.l = widen(this.l, Int32Array);
    this.c = widen(this.c, Int32Array);
    this.v = widen(this.v, Uint32Array);
    this._cap = cap;
  }

  push(ts, o, h, l, c, v) {
    if (this.length === this._cap) this._grow(this.length + 1);
    const i = this.length++;
    this.ts[i] = ts;
    this.o[i] = o;
    this.h[i] = h;
    this.l[i] = l;
    this.c[i] = c;
    this.v[i] = v;
  }

  /** Append parsed candles ({ts,o,h,l,c,v}) from one day. */
  pushAll(candles) {
    for (const k of candles) this.push(k.ts, k.o, k.h, k.l, k.c, k.v);
  }

  get firstTs() {
    return this.length ? this.ts[0] : null;
  }

  get lastTs() {
    return this.length ? this.ts[this.length - 1] : null;
  }

  /** First index whose timestamp is >= tsSec (assumes ascending order). */
  lowerBound(tsSec) {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[mid] < tsSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  static fromRecords(records) {
    const set = new CandleSet(records.length || 16);
    for (const r of records) set.push(r.ts, r.o, r.h, r.l, r.c, r.v);
    return set;
  }

  /** Test/debug helper. */
  at(i) {
    return { ts: this.ts[i], o: this.o[i], h: this.h[i], l: this.l[i], c: this.c[i], v: this.v[i] };
  }
}
