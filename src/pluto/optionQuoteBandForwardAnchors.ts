import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { parityImpliedForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";

/**
 * Each expiry's forward from the band's own quotes (Marcelo 2026-10-27, replacing the 10:00 surface fit's): put-call
 * parity on the expiry's quotes of its newest band cycle, else the stock price grown at the risk-free rate; anchored at
 * the stock price of the expiry's latest quote. The same rule the backtest applies to its looks, on one moment's quotes
 * (noteBaselineForwardAnchors in baselineSaleSteps.ts): the table keeps each contract's latest quote, so a Call no
 * longer re-quoted (in the money past the band) would otherwise pair with a Put quoted minutes later, the stock elsewhere.
 * Example: TSLA on 2 Nov 2026 at 399.97, a same-day expiry, read a forward of about 403.3 from such pairs.
 */
export function forwardAnchorsFromBandQuotes(quotes: readonly OptionQuoteBandQuote[], clock: { todayIso: string; yearsToTodaysClose: number; riskFreeRate: number }): Map<string, BaselineForwardAnchor> {
  const quotesByExpiry = new Map<string, OptionQuoteBandQuote[]>();
  for (const quote of quotes) {
    if (quote.expiry < clock.todayIso || quote.stockPrice === null || !(quote.stockPrice > 0)) continue;
    const expiryQuotes = quotesByExpiry.get(quote.expiry) ?? quotesByExpiry.set(quote.expiry, []).get(quote.expiry)!;
    expiryQuotes.push(quote);
  }
  const anchors = new Map<string, BaselineForwardAnchor>();
  for (const [expiry, expiryQuotes] of quotesByExpiry) {
    const latest = expiryQuotes.reduce((newest, quote) => (quote.quotedAt > newest.quotedAt ? quote : newest));
    const newestCycle = Math.max(...expiryQuotes.map((quote) => quote.cycleNumber));
    const cycleQuotes = expiryQuotes.filter((quote) => quote.cycleNumber === newestCycle);
    const stockPrice = latest.stockPrice!;
    const yearsToExpiry = expiry === clock.todayIso ? clock.yearsToTodaysClose : yearsBetweenIsoDates(clock.todayIso, expiry);
    const spotForward = stockPrice * Math.exp(clock.riskFreeRate * yearsToExpiry);
    const parity = parityImpliedForward(cycleQuotes.map((quote) => ({ strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask })), spotForward, yearsToExpiry, clock.riskFreeRate);
    anchors.set(expiry, { forward: parity ?? spotForward, spotPrice: stockPrice });
  }
  return anchors;
}
