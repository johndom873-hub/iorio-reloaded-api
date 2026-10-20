import type { BacktestCycleTimelineRow } from "./backtestTypes.js";

// An open cycle's cash break-even read back from its stored timeline (Marcelo 2026-10-20, the Wheel cycles' Break-even):
// (cost of every share bought in the cycle − what the shares that left brought in − net premium) ÷ shares held, the
// measure the baseline's call floor uses (cycleBreakEven.ts cashBreakEvenPerShare). The timeline's dollars are the same on
// any price scale, and its mark rows hold the shares still held on the last day's, so the result is as traded then.

/** Null when the cycle holds no shares (or the timeline has no mark row of them). */
export function cycleCashBreakEven(timeline: readonly BacktestCycleTimelineRow[]): number | null {
  let acquired = 0;
  let disposed = 0;
  let premium = 0;
  let sharesHeld = 0;
  for (const row of timeline) {
    const dollars = row.quantity * (row.label.startsWith("Put assigned") || row.label.startsWith("Call assigned") ? (row.strike ?? 0) : (row.stockPrice ?? 0));
    const commission = row.commissionDollars ?? 0;
    if (row.label === "Bought shares" || row.label.startsWith("Put assigned")) acquired += dollars + commission;
    else if (row.label === "Sold shares" || row.label.startsWith("Call assigned")) disposed += dollars - commission;
    else if (row.label.startsWith("Marked to the ")) sharesHeld += row.quantity;
    // A hedge's cost is not premium earned on the shares; an open option's mark is not premium received.
    if (row.bucket !== "hedge" && !(row.at === null && row.label.startsWith("Open "))) premium += row.premiumDollars;
  }
  return sharesHeld > 0 ? (acquired - disposed - premium) / sharesHeld : null;
}
