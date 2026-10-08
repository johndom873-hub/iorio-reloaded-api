// Delisting detection for scripts/run-daily-screener-scan-job.ts. When IBKR rejects a stored symbol with error 200,
// the job asks IBKR what its contract id is filed under now. A delisted stock keeps its symbol but moves to IBKR's
// "VALUE" exchange (WBD after its cash merger closed on 2026-10-06, contract 554208351); a renamed one comes back under
// its new ticker (PSKY -> SKYD). Anything else, e.g. an ambiguous symbol still listed on a real exchange, stays a failure.

/** IBKR's exchange for stocks that can no longer trade, only be valued. */
export const delistedPrimaryExchange = "VALUE";

export type RejectedSymbolOutcome = { kind: "delisted" } | { kind: "renamed"; newSymbol: string } | { kind: "unexplained" };

export function classifyRejectedSymbol(storedSymbol: string, listing: { symbol: string; primaryExchange: string | null } | null): RejectedSymbolOutcome {
  if (!listing) return { kind: "unexplained" };
  if (listing.symbol !== storedSymbol) return { kind: "renamed", newSymbol: listing.symbol };
  if (listing.primaryExchange === delistedPrimaryExchange) return { kind: "delisted" };
  return { kind: "unexplained" };
}
