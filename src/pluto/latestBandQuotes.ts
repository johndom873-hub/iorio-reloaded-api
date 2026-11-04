import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import type { OptionQuoteBandCycle, OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";

/**
 * The ticker's band quotes from its newest finished cycle on, as the sale steps take quotes: that cycle whole, with any
 * fresher quote of the cycle being stored (a quote from before it may have left the band), without those quoted more than
 * maxQuoteAgeMinutes before `now`. `stale`: there were such quotes, none of them fresh. None before the first cycle finishes.
 */
export function latestCycleQuotes(bandQuotes: readonly OptionQuoteBandQuote[], bandCycle: Pick<OptionQuoteBandCycle, "startedAt"> | null, now: Date, maxQuoteAgeMinutes: number): { quotes: SymbolFileQuote[]; stale: boolean } {
  if (bandCycle === null) return { quotes: [], stale: false };
  const latest = bandQuotes.filter((quote) => quote.quotedAt.getTime() >= bandCycle.startedAt.getTime() && quote.errorCode === null);
  const fresh = latest.filter((quote) => now.getTime() - quote.quotedAt.getTime() <= maxQuoteAgeMinutes * 60_000);
  return { quotes: fresh.map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, bidSize: quote.bidSize, askSize: quote.askSize })), stale: latest.length > 0 && fresh.length === 0 };
}
