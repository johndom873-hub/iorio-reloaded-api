export interface OptionQuoteForMark {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
}

const smallestOptionPrice = 0.01;

/**
 * The live price an open option position is valued at, on every screen (positions' P&L, Pulse, Cycle P&L, exposure):
 *   mid = (bid + ask) / 2 when both bid and ask are positive, else the last trade, else null.
 * One exception (approved 2026-11-04): with no bid and the ask at the smallest price an option can have ($0.01), the
 * option is worth between 0 and the ask, so it is valued at the mid of 0 and the ask ($0.005) rather than left unpriced.
 * Null leaves the caller on its own stored fallback (the nightly snapshot, or the entry price for exposure).
 */
export function optionMarkPrice(quote: OptionQuoteForMark): number | null {
  const bid = quote.bid ?? null;
  const ask = quote.ask ?? null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (quote.last != null) return quote.last;
  if ((bid === null || bid <= 0) && ask !== null && ask > 0 && ask <= smallestOptionPrice) return ask / 2;
  return null;
}
