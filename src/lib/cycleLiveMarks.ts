import { deriveCycles, type CycleInput } from "./cycles.js";

// The pieces the Positions table needs to show a live Cycle P&L (approved 2026-09-28). The cycle total is computed
// with the stored marks (shares at the last daily close, open options at the last nightly snapshot); the browser
// then swaps in the row's live marks with
//   live = total + sharesHeld x (rowPrice - markPrice) + sum over open option positions (livePremiumPnl - optionMarks[position])
// which equals re-deriving the cycle with those marks because the total is linear in both of them.
export interface OpenCycleMarks {
  symbol: string;
  total: number;
  /** Ledger shares held (the slope of the total in the stock mark). */
  sharesHeld: number;
  /** The price the shares were marked at: the last daily close; null when there is none. */
  markPrice: number | null;
  markDate: string | null;
  /** Per open option position: the premium P&L the total was computed with (the nightly snapshot, or the credit when there is none). */
  optionMarks: Record<string, number>;
  /** Non-empty when the cycle's numbers can't be trusted. */
  dataFlags: string[];
}

export function computeOpenCycleMarks(symbol: string, input: CycleInput): OpenCycleMarks | null {
  const openCycle = deriveCycles(input).find((cycle) => cycle.status === "open");
  if (!openCycle) return null;

  // What the total was computed with when the position has no nightly mark: a short sits at its credit, a hedge (long
  // options only) at its cost, i.e. a P&L of 0 (see deriveOneCycle).
  const creditByPositionId = new Map<string, number>();
  const hedgePositionIds = new Set(input.optionLegs.filter((leg) => leg.exitAt === null && leg.side === "long").map((leg) => leg.positionId));
  for (const leg of input.optionLegs) if (leg.exitAt === null && leg.side === "short") hedgePositionIds.delete(leg.positionId);
  for (const leg of input.optionLegs) {
    if (leg.exitAt !== null) continue;
    const credit = (leg.side === "short" ? 1 : -1) * leg.entryPrice * leg.quantity * leg.multiplier;
    creditByPositionId.set(leg.positionId, (creditByPositionId.get(leg.positionId) ?? 0) + credit);
  }
  const optionMarks: Record<string, number> = {};
  for (const [positionId, credit] of creditByPositionId) optionMarks[positionId] = input.openPositionPremiumPnl.get(positionId) ?? (hedgePositionIds.has(positionId) ? 0 : credit);

  return {
    symbol,
    total: openCycle.total,
    sharesHeld: openCycle.sharesHeld,
    markPrice: input.lastPrice?.price ?? null,
    markDate: input.lastPrice?.date ?? null,
    optionMarks,
    dataFlags: openCycle.dataFlags,
  };
}
