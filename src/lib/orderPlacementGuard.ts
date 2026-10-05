import { describeTradingHaltBlock, type TradingHalt } from "./platformControls.js";

// The worker's own check, right before an order is handed to IBKR (approved 2026-10-05). The confirm step judged the order and
// stored its verdict (order_requests.gate_evaluation); the worker does not repeat the judging, it refuses to place anything that:
//   - is under a trading halt NOW (a halt flipped after confirm must still stop an order already confirmed),
//   - was not confirmed through the gate at all (no stored verdict, a verdict with blocks, or one with no time),
//   - waited longer than maximumConfirmedOrderAgeMs between its verdict and now. Its limit price was judged against the quotes of
//     that moment; a worker that was offline, a Gateway that was disconnected or an account binding still pending must not
//     let the order fire minutes or hours later at a stale price.
// A refused order ends as an error for good: it is never retried once the cause clears.

export const maximumConfirmedOrderAgeMs = 5 * 60_000;

export interface StoredGateEvaluation {
  blocks?: unknown;
  evaluatedAt?: unknown;
}

/** The reason an order must not be placed, or null when it may be. `halt` is read fresh by the caller. */
export function findOrderPlacementBlockReason(params: { gateEvaluation: StoredGateEvaluation | null | undefined; halt: TradingHalt; nowMs?: number }): string | null {
  const nowMs = params.nowMs ?? Date.now();
  const haltReason = describeTradingHaltBlock(params.halt, nowMs);
  if (haltReason) return haltReason;

  const evaluation = params.gateEvaluation;
  if (!evaluation || typeof evaluation !== "object") return "The order has no stored gate verdict, so it was not confirmed through the order gate.";
  if (!Array.isArray(evaluation.blocks)) return "The order's stored gate verdict is malformed (no list of blocks).";
  if (evaluation.blocks.length > 0) return `The order's stored gate verdict has blocks: ${evaluation.blocks.join(" ")}`;
  if (typeof evaluation.evaluatedAt !== "string" || !Number.isFinite(new Date(evaluation.evaluatedAt).getTime())) return "The order's stored gate verdict has no valid time.";

  const ageMs = nowMs - new Date(evaluation.evaluatedAt).getTime();
  if (ageMs > maximumConfirmedOrderAgeMs) {
    return `The order was confirmed ${Math.round(ageMs / 60_000)} minutes ago and could not be sent within ${maximumConfirmedOrderAgeMs / 60_000} minutes, so it expired (its limit price is stale). Build it again.`;
  }
  return null;
}
