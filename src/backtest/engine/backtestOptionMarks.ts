import { contractKey } from "../../lib/optionContractKey.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { optionSaleFillPrice } from "./ledger/ledgerFills.js";

// How a session marks the options it holds: from a two-sided quote, at its mid; a LEAPS at what selling it would bring,
// the mid less volFarmerV2.leapsSpreadCostChargedPct of the half-spread (Marcelo 2026-10-28). With no bid, a placeholder
// ask (a $4.5 call quoted 0 / 5.80) would make the mark half of it, so such a quote gives no mark and the option keeps its
// last one.

type MarkQuote = Pick<SymbolFileQuote, "expiry" | "strike" | "right" | "bid" | "ask">;

/** A quote with a bid above 0 and an ask at or above it. */
export interface TwoSidedQuote {
  bid: number;
  ask: number;
}

export const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;
export const markKey = (expiry: string, strike: number, right: "C" | "P") => contractKey({ expiry, strike: roundedStrike(strike), right });

/** A held option's mark from its two-sided quote: the mid less spreadShareCharged of the half-spread (0: the mid). */
export function markOfTwoSidedQuote(quote: TwoSidedQuote, spreadShareCharged: number): number {
  return optionSaleFillPrice(quote.bid, quote.ask, spreadShareCharged);
}

/** Every two-sided quote (bid above 0, ask at or above it) at the strikes wanted, by markKey. */
export function twoSidedQuoteByContract(quotes: readonly MarkQuote[], roundedStrikesWanted: ReadonlySet<number>): Map<string, TwoSidedQuote> {
  const twoSided = new Map<string, TwoSidedQuote>();
  for (const quote of quotes) {
    if (!roundedStrikesWanted.has(roundedStrike(quote.strike))) continue;
    if (quote.bid === null || !(quote.bid > 0) || quote.ask === null || quote.ask < quote.bid) continue;
    twoSided.set(markKey(quote.expiry, quote.strike, quote.right), { bid: quote.bid, ask: quote.ask });
  }
  return twoSided;
}

/**
 * For each contract, its first two-sided quote across the quote sets, taken in order (a day's snapshots after 10:00, then
 * its close), by markKey; a contract no set quotes two-sided is left out. The sets after the one that quotes the last
 * contract are not taken.
 */
export function firstTwoSidedQuotes(quoteSets: Iterable<readonly MarkQuote[]>, contracts: readonly { expiry: string; strike: number; right: "C" | "P" }[]): Map<string, TwoSidedQuote> {
  const wanted = new Set(contracts.map((contract) => roundedStrike(contract.strike)));
  const keys = new Set(contracts.map((contract) => markKey(contract.expiry, contract.strike, contract.right)));
  const firstQuotes = new Map<string, TwoSidedQuote>();
  for (const quotes of quoteSets) {
    for (const [key, quote] of twoSidedQuoteByContract(quotes, wanted)) if (keys.has(key) && !firstQuotes.has(key)) firstQuotes.set(key, quote);
    if (firstQuotes.size === keys.size) break;
  }
  return firstQuotes;
}
