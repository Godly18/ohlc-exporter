// Central allowlists. Adding an instrument or timeframe later = one line here.
// User-supplied strings are ONLY ever used after passing through these lookups,
// so they can never become storage paths or reach OANDA unchecked.

/** Supported timeframes. Only M1 for now. */
const TIMEFRAMES = new Map([
  ['M1', Object.freeze({ code: 'M1', seconds: 60, oandaGranularity: 'M1' })],
]);

/**
 * Supported instruments. `displayDecimals` is the minimum number of decimals printed in CSV
 * (prices are stored at 1e-5 resolution regardless).
 */
const INSTRUMENTS = new Map([
  ['EUR_USD', Object.freeze({ code: 'EUR_USD', displayDecimals: 5 })],
  ['GBP_USD', Object.freeze({ code: 'GBP_USD', displayDecimals: 5 })],
  ['USD_JPY', Object.freeze({ code: 'USD_JPY', displayDecimals: 3 })],
  ['AUD_USD', Object.freeze({ code: 'AUD_USD', displayDecimals: 5 })],
  ['USD_CAD', Object.freeze({ code: 'USD_CAD', displayDecimals: 5 })],
  ['USD_CHF', Object.freeze({ code: 'USD_CHF', displayDecimals: 5 })],
  ['NZD_USD', Object.freeze({ code: 'NZD_USD', displayDecimals: 5 })],
  ['EUR_GBP', Object.freeze({ code: 'EUR_GBP', displayDecimals: 5 })],
  ['EUR_JPY', Object.freeze({ code: 'EUR_JPY', displayDecimals: 3 })],
  ['GBP_JPY', Object.freeze({ code: 'GBP_JPY', displayDecimals: 3 })],
]);

export function getInstrument(code) {
  return typeof code === 'string' ? INSTRUMENTS.get(code) ?? null : null;
}

export function getTimeframe(code) {
  return typeof code === 'string' ? TIMEFRAMES.get(code) ?? null : null;
}

export function listInstruments() {
  return [...INSTRUMENTS.keys()];
}

export function listTimeframes() {
  return [...TIMEFRAMES.keys()];
}
