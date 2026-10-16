export interface OptionQuoteForMark {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
}

/**
 * The live price an open option position is valued at, on every screen (positions' P&L, Pulse, Cycle P&L, exposure):
 *   mid = (bid + ask) / 2 when both bid and ask are positive, else the last trade, else null.
 * Null leaves the caller on its own stored fallback (the nightly snapshot, or the entry price for exposure).
 */
export function optionMarkPrice(quote: OptionQuoteForMark): number | null {
  const bid = quote.bid ?? null;
  const ask = quote.ask ?? null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0) return (bid + ask) / 2;
  return quote.last ?? null;
}
