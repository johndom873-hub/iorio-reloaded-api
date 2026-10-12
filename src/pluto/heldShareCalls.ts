import type { OpenCycleSummary } from "../lib/cycleBreakEven.js";
import { formatSignedDollars } from "../lib/formatSignedDollars.js";
import { commissionPerContractDollars as flatCommissionPerContractDollars } from "../lib/optionFriction.js";
import type { PlutoSettings } from "./settingsStore.js";

// Covered calls on shares already held (Marcelo, 2026-10-12). A call written on the cycle's shares may only be one
// whose assignment would close them at or above the cycle break-even plus the minimum profit, counting the call's own
// premium; the same for a covered-call roll that lowers the strike. Pro-rata, like the Positions break-even
// (cycleBreakEven.ts): the trade's cash is spread over every share acquired in the cycle.
//   breakEvenAfter    = breakEven − cashPerShareCovered × 100 × contracts ÷ sharesAcquired
//   profitIfCalledAway = (strike − breakEvenAfter) × 100 × contracts
//   floor             = max(unstructuredCloseMinPct% × average acquisition cost × 100 × contracts, unstructuredCloseMinDollars)
// cashPerShareCovered is what the trade adds per share it covers: an open's mid less its commission; a roll's net
// credit (new mid − old mid) less both commissions. The open call already counts at its credit in the break-even, so
// buying it back raises the break-even by what the buyback costs.
// Example: 100 shares assigned at $40 with $1.00 of put premium (break-even $39.00), floor max($40, $50) = $50: a $39
// call at 0.55 leaves a break-even of 38.4568, $54.32 if called away (eligible); a $38.50 call at 0.60 $9.32 (blocked).
// No break-even (cycleBreakEven.ts refused to compute one) blocks the call: the stock leg's entry price is not a cost basis.
//
// The call code sells on free shares (checkHeldShareCallStrike, Marcelo 2026-10-12) passes this rule AND has its strike at
// or above the cycle break-even before its own premium: the premium is a bonus on top, never what makes assignment pay.
// Example: INTC, 400 shares, break-even $113.90, floor $460: a $113 call at 2.58 passes the rule above (break-even after
// 111.32, +$670) but is blocked; a $114 call at 2.39 is allowed (114 ≥ 113.90, +$994 if called away).

/** The gate every action code takes on its own to sell a call on held shares carries first (passRunner.ts, the backtest's look). */
export const heldShareCallGate = "automatic_held_share_call";

export type CycleBreakEven = Pick<OpenCycleSummary, "breakEvenPerShare" | "unavailableReason" | "sharesAcquired" | "acquisitionCost">;

export interface CalledAwayCheck {
  /** The cycle break-even before this trade's cash. */
  breakEvenBefore: number;
  breakEvenAfter: number;
  profitIfCalledAway: number;
  floor: number;
  passes: boolean;
}

export function heldSharesProfitFloor(settings: Pick<PlutoSettings, "unstructuredCloseMinPct" | "unstructuredCloseMinDollars">, cycle: CycleBreakEven, contracts: number): number {
  const averageAcquisitionCost = cycle.acquisitionCost / cycle.sharesAcquired;
  return Math.max((settings.unstructuredCloseMinPct / 100) * averageAcquisitionCost * 100 * contracts, settings.unstructuredCloseMinDollars);
}

/** The cycle's outcome if the call is assigned, or why it cannot be known. */
export function checkCalledAway(input: {
  cycle: CycleBreakEven | null;
  strike: number;
  contracts: number;
  cashPerShareCovered: number;
  settings: Pick<PlutoSettings, "unstructuredCloseMinPct" | "unstructuredCloseMinDollars">;
}): { check: CalledAwayCheck; unavailableReason: null } | { check: null; unavailableReason: string } {
  const { cycle, contracts } = input;
  if (!cycle) return { check: null, unavailableReason: "no open cycle found for the shares" };
  if (cycle.breakEvenPerShare === null || !(cycle.sharesAcquired > 0)) return { check: null, unavailableReason: cycle.unavailableReason ?? "the cycle has no break-even" };
  const sharesCovered = 100 * contracts;
  const breakEvenAfter = cycle.breakEvenPerShare - (input.cashPerShareCovered * sharesCovered) / cycle.sharesAcquired;
  const profitIfCalledAway = (input.strike - breakEvenAfter) * sharesCovered;
  const floor = heldSharesProfitFloor(input.settings, cycle, contracts);
  return { check: { breakEvenBefore: cycle.breakEvenPerShare, breakEvenAfter, profitIfCalledAway, floor, passes: profitIfCalledAway >= floor }, unavailableReason: null };
}

/** checkCalledAway for a call code sells on free shares: also the strike at or above the break-even before this premium. */
export function checkHeldShareCallStrike(input: Parameters<typeof checkCalledAway>[0]): ReturnType<typeof checkCalledAway> {
  const result = checkCalledAway(input);
  if (!result.check) return result;
  return { check: { ...result.check, passes: result.check.passes && input.strike >= result.check.breakEvenBefore }, unavailableReason: null };
}

/** An open's or a roll's commission per share covered, from the candidate's per-contract estimate (the flat rate when absent). */
export function commissionPerShare(commissionPerContractDollars: number | undefined): number {
  return (commissionPerContractDollars ?? flatCommissionPerContractDollars) / 100;
}

export function describeCalledAwayShortfall(strike: number, contracts: number, check: CalledAwayCheck): string {
  if (check.profitIfCalledAway >= check.floor) return `the $${strike} strike is below the cycle break-even of ${check.breakEvenBefore.toFixed(2)} before this premium`;
  return `if assigned, the $${strike} strike closes ${100 * contracts} shares ${formatSignedDollars(check.profitIfCalledAway, 0)} over the cycle break-even of ${check.breakEvenAfter.toFixed(2)} (after this premium), below the ${formatSignedDollars(check.floor, 0)} minimum profit`;
}
