import { OptionType } from "@stoqey/ib";
import type { OptionQuote } from "./fetchOptionChain.js";
import { quoteSingleContract } from "./quoteContracts.js";
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
  /** The live quote this was judged on — handed to evaluateRollCandidate so the same leg is not quoted twice. */
  quote: OptionQuote;
}

/**
 * An open short leg's live delta, plus whether it's crossed the
 * assignment-risk threshold. Returns both (not just the boolean) so the
 * caller can format a notification line from the same live quote instead of
 * re-fetching it — and so the roll pass can pass the same quote on to
 * evaluateRollCandidate (knownQuote) instead of quoting the leg a second
 * time. Returns null when no live quote is available, distinguishing
 * "checked, not at risk" from "couldn't check" — same convention as
 * evaluateRollCandidate's own null-quote skip.
 */
export async function checkAssignmentRisk(
  connection: IbkrConnection,
  leg: { symbol: string; expiry: string; strike: number; right: "call" | "put" },
): Promise<AssignmentRiskCheck | null> {
  const optionType = leg.right === "call" ? OptionType.Call : OptionType.Put;
  const quote = await quoteSingleContract(connection.ib, leg.symbol, leg.expiry, leg.strike, optionType);
  if (!quote || quote.delta === null) return null;
  return { atRisk: Math.abs(quote.delta) >= assignmentRiskDeltaThreshold, delta: quote.delta, quote };
}
