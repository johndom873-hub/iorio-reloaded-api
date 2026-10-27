import { contractKey } from "../../lib/optionContractKey.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";

// How a session marks the options it holds: at the mid of a two-sided quote. With no bid, a placeholder ask (a $4.5 call
// quoted 0 / 5.80) would make the mark half of it, so such a quote gives no mark and the option keeps its last one.

type MarkQuote = Pick<SymbolFileQuote, "expiry" | "strike" | "right" | "bid" | "ask">;

export const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;
export const markKey = (expiry: string, strike: number, right: "C" | "P") => contractKey({ expiry, strike: roundedStrike(strike), right });

/** The mid of every two-sided quote (bid above 0, ask at or above it) at the strikes wanted, by markKey. */
export function markMidByContract(quotes: readonly MarkQuote[], roundedStrikesWanted: ReadonlySet<number>): Map<string, number> {
  const marks = new Map<string, number>();
  for (const quote of quotes) {
    if (!roundedStrikesWanted.has(roundedStrike(quote.strike))) continue;
    if (quote.bid === null || !(quote.bid > 0) || quote.ask === null || quote.ask < quote.bid) continue;
    marks.set(markKey(quote.expiry, quote.strike, quote.right), (quote.bid + quote.ask) / 2);
  }
  return marks;
}

/**
 * For each contract, the mid of its first two-sided quote across the quote sets, taken in order (a day's snapshots after
 * 10:00, then its close), by markKey; a contract no set quotes two-sided is left out.
 */
export function firstTwoSidedMids(quoteSets: readonly (readonly MarkQuote[])[], contracts: readonly { expiry: string; strike: number; right: "C" | "P" }[]): Map<string, number> {
  const wanted = new Set(contracts.map((contract) => roundedStrike(contract.strike)));
  const keys = new Set(contracts.map((contract) => markKey(contract.expiry, contract.strike, contract.right)));
  const marks = new Map<string, number>();
  for (const quotes of quoteSets) {
    for (const [key, mid] of markMidByContract(quotes, wanted)) if (keys.has(key) && !marks.has(key)) marks.set(key, mid);
    if (marks.size === keys.size) break;
  }
  return marks;
}
