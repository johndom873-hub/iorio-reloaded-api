import type { BacktestCycleTimelineRow } from "./backtestTypes.js";

// An open cycle's cash break-even read back from its stored timeline (Marcelo 2026-10-20, the Wheel cycles' Break-even):
// (cost of every share bought in the cycle − what the shares that left brought in − net premium) ÷ shares held, the
// measure the baseline's call floor uses (cycleBreakEven.ts cashBreakEvenPerShare). The timeline's dollars are the same on
// any price scale, and its mark rows hold the shares still held on the last day's, so the result is as traded then.

/** A row's part in the cash break-even: dollars into and out of shares, premium, and shares in or out (as traded on its day). */
function rowAmounts(row: BacktestCycleTimelineRow): { acquired: number; disposed: number; premium: number; shares: number } {
  const dollars = row.quantity * (row.label.startsWith("Put assigned") || row.label.startsWith("Call assigned") ? (row.strike ?? 0) : (row.stockPrice ?? 0));
  const commission = row.commissionDollars ?? 0;
  const bought = row.label === "Bought shares" || row.label.startsWith("Put assigned");
  const left = row.label === "Sold shares" || row.label.startsWith("Call assigned");
  // A hedge's cost is not premium earned on the shares; an open option's mark is not premium received.
  const premium = row.bucket !== "hedge" && !(row.at === null && row.label.startsWith("Open ")) ? row.premiumDollars : 0;
  return { acquired: bought ? dollars + commission : 0, disposed: left ? dollars - commission : 0, premium, shares: bought ? row.quantity : left ? -row.quantity : 0 };
}

/** Null when the cycle holds no shares (or the timeline has no mark row of them). */
export function cycleCashBreakEven(timeline: readonly BacktestCycleTimelineRow[]): number | null {
  let net = 0;
  let sharesHeld = 0;
  for (const row of timeline) {
    const amounts = rowAmounts(row);
    net += amounts.acquired - amounts.disposed - amounts.premium;
    if (row.label.startsWith("Marked to the ")) sharesHeld += row.quantity;
  }
  return sharesHeld > 0 ? net / sharesHeld : null;
}

/**
 * The cash break-even just before each row's moment: what the shares then held had to bring for the cycle to end flat (null
 * while it held none). Rows of one moment (one look's sales) share the value from before it, as the engine checks every
 * call of a look against one floor: before a call sold on held shares, the floor it was held to (engine version 3 on).
 */
export function cashBreakEvenBeforeEachRow(timeline: readonly BacktestCycleTimelineRow[]): (number | null)[] {
  let net = 0;
  let sharesHeld = 0;
  let momentAt: string | null | undefined;
  let atMomentStart: number | null = null;
  return timeline.map((row) => {
    if (row.at === null || row.at !== momentAt) {
      momentAt = row.at;
      atMomentStart = sharesHeld > 1e-9 ? net / sharesHeld : null;
    }
    const amounts = rowAmounts(row);
    net += amounts.acquired - amounts.disposed - amounts.premium;
    sharesHeld += amounts.shares;
    return atMomentStart;
  });
}
