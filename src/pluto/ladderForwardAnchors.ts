import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { parityImpliedForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { LadderBandQuote } from "./ladderBandQuotes.js";

/**
 * Each expiry's forward from the ladder's own band quotes (Marcelo 2026-10-27, replacing the 10:00 surface fit's): put-call
 * parity on the expiry's quotes, else the stock price grown at the risk-free rate; anchored at the stock price of the
 * expiry's latest quote. The same rule the backtest applies to its looks (noteBaselineForwardAnchors in baselineSaleSteps.ts).
 */
export function forwardAnchorsFromBandQuotes(quotes: readonly LadderBandQuote[], clock: { todayIso: string; yearsToTodaysClose: number; riskFreeRate: number }): Map<string, BaselineForwardAnchor> {
  const quotesByExpiry = new Map<string, LadderBandQuote[]>();
  for (const quote of quotes) {
    if (quote.expiry < clock.todayIso || quote.stockPrice === null || !(quote.stockPrice > 0)) continue;
    const expiryQuotes = quotesByExpiry.get(quote.expiry) ?? quotesByExpiry.set(quote.expiry, []).get(quote.expiry)!;
    expiryQuotes.push(quote);
  }
  const anchors = new Map<string, BaselineForwardAnchor>();
  for (const [expiry, expiryQuotes] of quotesByExpiry) {
    const latest = expiryQuotes.reduce((newest, quote) => (quote.quotedAt > newest.quotedAt ? quote : newest));
    const stockPrice = latest.stockPrice!;
    const yearsToExpiry = expiry === clock.todayIso ? clock.yearsToTodaysClose : yearsBetweenIsoDates(clock.todayIso, expiry);
    const spotForward = stockPrice * Math.exp(clock.riskFreeRate * yearsToExpiry);
    const parity = parityImpliedForward(expiryQuotes.map((quote) => ({ strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask })), spotForward, yearsToExpiry, clock.riskFreeRate);
    anchors.set(expiry, { forward: parity ?? spotForward, spotPrice: stockPrice });
  }
  return anchors;
}
