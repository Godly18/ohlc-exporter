// Central allowlists. Adding an instrument or timeframe later = one line here.
// User-supplied strings are ONLY ever used after passing through these lookups,
// so they can never become storage paths or reach OANDA unchecked.

/** Supported timeframes. Only M1 for now. */
const TIMEFRAMES = new Map([
  ['M1', Object.freeze({ code: 'M1', seconds: 60, oandaGranularity: 'M1' })],
]);

/**
 * Supported instruments: the 68 forex pairs OANDA serves candles for on its practice API.
 * `displayDecimals` is the minimum number of decimals printed in CSV (prices are stored at 1e-5
 * resolution regardless): 3 for pairs quoted in JPY, HUF, CZK or THB, otherwise 5.
 * Stored prices are int32 x 1e5, so the largest representable price is about 21,474 (all pairs here are far below).
 */
const INSTRUMENT_CODES = ['AUD_CAD', 'AUD_CHF', 'AUD_HKD', 'AUD_JPY', 'AUD_NZD', 'AUD_SGD', 'AUD_USD', 'CAD_CHF', 'CAD_HKD', 'CAD_JPY', 'CAD_SGD', 'CHF_HKD', 'CHF_JPY', 'CHF_ZAR', 'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_CZK', 'EUR_DKK', 'EUR_GBP', 'EUR_HKD', 'EUR_HUF', 'EUR_JPY', 'EUR_NOK', 'EUR_NZD', 'EUR_PLN', 'EUR_SEK', 'EUR_SGD', 'EUR_TRY', 'EUR_USD', 'EUR_ZAR', 'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_HKD', 'GBP_JPY', 'GBP_NZD', 'GBP_PLN', 'GBP_SGD', 'GBP_USD', 'GBP_ZAR', 'HKD_JPY', 'NZD_CAD', 'NZD_CHF', 'NZD_HKD', 'NZD_JPY', 'NZD_SGD', 'NZD_USD', 'SGD_CHF', 'SGD_JPY', 'TRY_JPY', 'USD_CAD', 'USD_CHF', 'USD_CNH', 'USD_CZK', 'USD_DKK', 'USD_HKD', 'USD_HUF', 'USD_JPY', 'USD_MXN', 'USD_NOK', 'USD_PLN', 'USD_SEK', 'USD_SGD', 'USD_THB', 'USD_TRY', 'USD_ZAR', 'ZAR_JPY'];
const THREE_DECIMAL_QUOTES = ['JPY', 'HUF', 'CZK', 'THB'];

const INSTRUMENTS = new Map(
  INSTRUMENT_CODES.map((code) => [
    code,
    Object.freeze({ code, displayDecimals: THREE_DECIMAL_QUOTES.includes(code.slice(4)) ? 3 : 5 }),
  ]),
);

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
