// Exact decimal-string -> scaled-integer conversion (no floating point), so "0.00001234" at 8 decimals
// is exactly 1234 and a price can never drift by a rounding error.

/**
 * @param {string|number} value  e.g. "65000.01000000"
 * @param {number} decimals      target scale 10^decimals
 * @param {{round?: boolean}} opts  round=false (default): more significant decimals than `decimals` is an error
 *                                  (digits beyond are only allowed when they are zeros); round=true: round half up.
 * @returns {number|null} the scaled integer, or null when malformed / not representable exactly
 */
export function parseDecimalScaled(value, decimals, { round = false } = {}) {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,15})(?:\.(\d{1,30}))?$/.exec(text);
  if (!m) return null;
  const whole = m[1];
  let frac = m[2] ?? '';
  let carry = 0;
  if (frac.length > decimals) {
    const extra = frac.slice(decimals);
    if (/[^0]/.test(extra)) {
      if (!round) return null;
      carry = extra.charCodeAt(0) >= 53 ? 1 : 0; // '5'
    }
    frac = frac.slice(0, decimals);
  }
  frac = frac.padEnd(decimals, '0');
  const n = Number(whole + frac) + carry;
  return Number.isSafeInteger(n) ? n : null;
}
