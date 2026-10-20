// Central allowlists. Adding an instrument or timeframe later = one entry here.
// User-supplied strings are ONLY ever used after passing through these lookups,
// so they can never become storage paths or reach a data provider unchecked.
//
// Each instrument declares everything that differs between markets:
//   provider        which service supplies the candles: 'oanda' | 'binance' | 'twelvedata'
//   providerSymbol  the symbol that provider expects
//   formatVersion   binary dataset layout (1 = int32 prices x1e5, 2 = wide float64-held integers)
//   priceDecimals   price scale is 10^priceDecimals       volumeDecimals: volume scale is 10^volumeDecimals
//   displayDecimals minimum decimals printed in CSV (trailing zeros beyond it are trimmed)
//   minYear         first year users may request (the date picker and the server both enforce it)
//   calendar        'fx'     = closed Saturdays, Dec 25, Jan 1 (an empty day is only legitimate then)
//                   'always' = trades 24/7 (an empty day is only legitimate BEFORE the pair's first candle)

/** Supported timeframes. Only M1 for now. */
const TIMEFRAMES = new Map([
  ['M1', Object.freeze({ code: 'M1', seconds: 60, oandaGranularity: 'M1', binanceInterval: '1m', twelveInterval: '1min' })],
]);

const INSTRUMENTS = new Map();

function add(entry) {
  INSTRUMENTS.set(entry.code, Object.freeze({ priceScale: 10 ** entry.priceDecimals, volumeScale: 10 ** entry.volumeDecimals, ...entry }));
}

// ---- Forex: 68 pairs OANDA serves on its practice API ----------------------------------------------
const FOREX = [
  'NZD_USD', 'USD_PLN', 'GBP_AUD', 'EUR_CAD', 'USD_HUF', 'EUR_ZAR', 'AUD_JPY', 'EUR_SGD', 'USD_CNH', 'EUR_GBP',
  'CHF_HKD', 'USD_CZK', 'GBP_SGD', 'USD_SEK', 'EUR_AUD', 'USD_CAD', 'EUR_NOK', 'NZD_HKD', 'USD_HKD', 'CAD_HKD',
  'USD_CHF', 'AUD_HKD', 'NZD_CHF', 'AUD_CHF', 'GBP_CHF', 'USD_THB', 'EUR_HKD', 'GBP_HKD', 'EUR_NZD', 'AUD_SGD',
  'EUR_JPY', 'EUR_TRY', 'USD_JPY', 'SGD_JPY', 'GBP_ZAR', 'USD_NOK', 'AUD_NZD', 'EUR_CHF', 'CAD_CHF', 'CHF_ZAR',
  'USD_DKK', 'CAD_JPY', 'USD_ZAR', 'HKD_JPY', 'CAD_SGD', 'EUR_HUF', 'EUR_SEK', 'USD_SGD', 'EUR_DKK', 'SGD_CHF',
  'EUR_CZK', 'NZD_CAD', 'EUR_USD', 'GBP_JPY', 'USD_TRY', 'GBP_CAD', 'NZD_JPY', 'AUD_USD', 'ZAR_JPY', 'GBP_PLN',
  'EUR_PLN', 'AUD_CAD', 'GBP_USD', 'USD_MXN', 'GBP_NZD', 'NZD_SGD', 'CHF_JPY', 'TRY_JPY',
].sort();
const THREE_DECIMAL_QUOTES = ['JPY', 'HUF', 'CZK', 'THB'];
for (const code of FOREX) {
  add({
    code,
    label: code.replace('_', '/'),
    group: 'Forex',
    provider: 'oanda',
    providerSymbol: code,
    formatVersion: 1,
    priceDecimals: 5,
    volumeDecimals: 0,
    displayDecimals: THREE_DECIMAL_QUOTES.includes(code.slice(4)) ? 3 : 5,
    minYear: 0, // governed by MIN_DATA_YEAR
    calendar: 'fx',
  });
}

// ---- Crypto: 23 Binance Spot pairs (archive first, API for what the archive does not have yet) ----
const CRYPTO = [
  'ADABTC', 'BNBBTC', 'DASHBTC', 'ETCBTC', 'ETHBTC', 'LINKBTC', 'LTCBTC', 'TRXBTC', 'XRPBTC', 'ZECBTC',
  'ADAETH', 'BNBETH', 'LINKETH', 'LTCETH', 'TRXETH', 'XLMETH', 'XRPETH', 'ZECETH',
  'BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'LTCUSDT', 'NEOUSDT',
].sort();
export const CRYPTO_MIN_YEAR = 2018;
for (const code of CRYPTO) {
  const base = code.endsWith('USDT') ? code.slice(0, -4) : code.slice(0, -3);
  const quote = code.endsWith('USDT') ? 'USDT' : code.slice(-3);
  add({
    code,
    label: `${base}/${quote}`,
    group: 'Crypto',
    provider: 'binance',
    providerSymbol: code,
    formatVersion: 2,
    priceDecimals: 8,
    volumeDecimals: 8,
    displayDecimals: quote === 'USDT' ? 2 : 6,
    minYear: CRYPTO_MIN_YEAR,
    calendar: 'always',
  });
}

// ---- Gold: Twelve Data (this provider is used for XAUUSD and nothing else) -----------------------------
export const XAUUSD_MIN_YEAR = 2021;
add({
  code: 'XAUUSD',
  label: 'XAU/USD',
  group: 'Metals',
  provider: 'twelvedata',
  providerSymbol: 'XAU/USD',
  formatVersion: 1,
  priceDecimals: 5,
  volumeDecimals: 0,
  displayDecimals: 2,
  minYear: XAUUSD_MIN_YEAR,
  calendar: 'fx',
});

export function getInstrument(code) {
  return typeof code === 'string' ? INSTRUMENTS.get(code) ?? null : null;
}

export function getTimeframe(code) {
  return typeof code === 'string' ? TIMEFRAMES.get(code) ?? null : null;
}

export function listInstruments() {
  return [...INSTRUMENTS.keys()];
}

export function listInstrumentEntries() {
  return [...INSTRUMENTS.values()];
}

export function listTimeframes() {
  return [...TIMEFRAMES.keys()];
}

/** First year a user may request for this instrument (never earlier than the global MIN_DATA_YEAR). */
export function effectiveMinYear(instrument, config) {
  return Math.max(config?.minDataYear ?? 0, instrument.minYear ?? 0);
}

/** Is the provider for this instrument configured? (Twelve Data needs its key; the others need nothing extra.) */
export function providerAvailable(instrument, config) {
  if (instrument.provider === 'twelvedata') return !!config?.twelvedata?.apiKey;
  return true;
}
