// Routes a day-of-candles request to the right provider using the instrument catalog:
//   forex -> OANDA, 23 crypto pairs -> Binance, XAUUSD -> Twelve Data.
// Every provider exposes the same method: fetchDayCandles({instrument, timeframe, date, lastDay, signal})
//   -> { candles: [{ts,o,h,l,c,v}], incompleteCount }

import { getInstrument } from '../../config/catalog.js';
import { SourceError } from '../../lib/errors.js';

export function createMarketData(providers) {
  return {
    async fetchDayCandles(args) {
      const inst = getInstrument(args.instrument);
      const provider = inst ? providers[inst.provider] : null;
      if (!provider) throw new SourceError(`no data provider configured for ${args.instrument}`);
      return provider.fetchDayCandles(args);
    },
  };
}
