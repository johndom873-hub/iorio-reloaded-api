// IBKR reports an assignment as an ordinary stock execution at the strike (a put's shares bought, a covered call's shares
// sold), which the worker records in `trades`, while both cycle engines (cycles.ts, cycleBreakEven.ts) also infer the
// same assignment from the short option leg that settled in the money. This one rule pairs the two, so both engines count
// the shares once and agree on which fill was the assignment:
//   a fill is an assigned leg's own when its side is the assignment's (put -> buy, call -> sell), its share count is the
//   leg's contracts x multiplier, its price is the strike, and it executed within 36 hours of the leg's exit;
//   each leg takes at most one fill (the closest in time, legs served in exit order) and each fill serves one leg.
// The window is wide because a leg's exit is stamped when reconciliation notices the assignment, which can be hours from
// the execution IBKR reports. The positions' close_reason plays no part: the fill is recognised by what it is.
// Which legs were assigned stays each engine's own decision (an explicit settlement, else the expiry-date close).

export interface AssignedOptionLeg {
  id: string;
  optionType: "call" | "put";
  strike: number;
  quantity: number;
  multiplier: number;
  /** A leg that has not exited matches no fill. */
  exitAt: Date | null;
}

export interface RecordedStockFill {
  at: Date;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

export const assignmentFillWindowMs = 36 * 3_600_000;
const strikePriceTolerance = 0.00005;

/** Whether the fill is the stock execution of the leg's assignment. */
export function isAssignmentFillOf(leg: AssignedOptionLeg, fill: RecordedStockFill): boolean {
  return (
    leg.exitAt !== null &&
    fill.side === (leg.optionType === "put" ? "buy" : "sell") &&
    fill.quantity === leg.quantity * leg.multiplier &&
    Math.abs(fill.price - leg.strike) < strikePriceTolerance &&
    Math.abs(fill.at.getTime() - leg.exitAt.getTime()) <= assignmentFillWindowMs
  );
}

/** Each assigned leg's recorded assignment fill, as an index into `fills`, by leg id; a leg with none is absent. */
export function matchAssignmentFills(assignedLegs: readonly AssignedOptionLeg[], fills: readonly RecordedStockFill[]): Map<string, number> {
  const fillIndexByLegId = new Map<string, number>();
  if (assignedLegs.length === 0 || fills.length === 0) return fillIndexByLegId;
  const claimedFillIndices = new Set<number>();
  const legsInExitOrder = assignedLegs.filter((leg): leg is AssignedOptionLeg & { exitAt: Date } => leg.exitAt !== null).sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime());
  for (const leg of legsInExitOrder) {
    let closestFillIndex = -1;
    let closestDistanceMs = Infinity;
    fills.forEach((fill, fillIndex) => {
      if (claimedFillIndices.has(fillIndex) || !isAssignmentFillOf(leg, fill)) return;
      const distanceMs = Math.abs(fill.at.getTime() - leg.exitAt.getTime());
      if (distanceMs < closestDistanceMs) {
        closestFillIndex = fillIndex;
        closestDistanceMs = distanceMs;
      }
    });
    if (closestFillIndex === -1) continue;
    claimedFillIndices.add(closestFillIndex);
    fillIndexByLegId.set(leg.id, closestFillIndex);
  }
  return fillIndexByLegId;
}
