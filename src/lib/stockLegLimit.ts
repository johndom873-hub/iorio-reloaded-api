/**
 * The limit price for the stock leg of a buy-write (Marcelo 2026-10-05): the mid of the stock's bid and ask, the same
 * basis as the option leg's mid limit, instead of the last trade, which can lag in a fast market. Falls back to the
 * last price when there is no real two-sided quote (a zero or crossed side is not one).
 */
export function stockLegLimitPrice(quote: { bid: number | null; ask: number | null } | null, lastPrice: number): { price: number; basis: "mid" | "last" } {
  if (quote && quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask >= quote.bid) {
    return { price: (quote.bid + quote.ask) / 2, basis: "mid" };
  }
  return { price: lastPrice, basis: "last" };
}
