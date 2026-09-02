import { OptionType } from "@stoqey/ib";
import { quoteOptionChain } from "./fetchOptionChain.js";
import type { connectToIbkrGateway } from "./connectIbkr.js";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

// Approved 2026-09-02 (Juan's feedback doc, item 7 — "alert if we are below
// (CSP)/above (CC) assignment price"). |delta| >= 0.50 is the standard
// at-the-money convention: the underlying has crossed the strike, i.e. the
// leg has moved from OTM into ITM territory where assignment becomes live.
export const assignmentRiskDeltaThreshold = 0.5;

export interface AssignmentRiskCheck {
  atRisk: boolean;
  delta: number;
}

/**
 * An open short leg's live delta, plus whether it's crossed the
 * assignment-risk threshold. Returns both (not just the boolean) so the
 * caller can format a notification line from the same live quote instead of
 * re-fetching it. A second `quoteOptionChain` call alongside
 * evaluateRollCandidate's own (not threaded through — that function's return
 * contract is money-adjacent and several callers deep, not worth widening
 * for this) — acceptable here since this only runs once per *open
 * position*, not once per shortlisted ticker, so it doesn't add to the scan
 * that's previously hit IBKR pacing limits. Returns null when no live quote
 * is available, distinguishing "checked, not at risk" from "couldn't check"
 * — same convention as evaluateRollCandidate's own null-quote skip.
 */
export async function checkAssignmentRisk(
  connection: IbkrConnection,
  leg: { symbol: string; expiry: string; strike: number; right: "call" | "put" },
): Promise<AssignmentRiskCheck | null> {
  const optionType = leg.right === "call" ? OptionType.Call : OptionType.Put;
  const quotes = await quoteOptionChain(connection, leg.symbol, [{ expiry: leg.expiry, strikes: [leg.strike] }]);
  const quote = quotes.find((q) => q.strike === leg.strike && q.right === optionType);
  if (!quote || quote.delta === null) return null;
  return { atRisk: Math.abs(quote.delta) >= assignmentRiskDeltaThreshold, delta: quote.delta };
}
