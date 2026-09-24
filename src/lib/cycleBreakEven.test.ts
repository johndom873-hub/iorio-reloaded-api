import { describe, expect, it } from "vitest";
import { summarizeOpenCycle, breakEvenForPosition, type CycleOptionLeg, type CycleStockTrade } from "./cycleBreakEven.js";

// Real bug found 2026-09-24: a same-day CSP assignment (TLT, QQQ) showed the API's
// "ledger says 200 sh held but the open stock legs total 100 sh" refusal, nulling out
// break-even. ibkrGatewayWorker.ts records a real stock buy trade for the assignment AND
// stamps the closed CSP position's close_reason "assigned" — but cycleBreakEven.ts also
// independently re-derived the same assignment from the put's strike/ITM-at-expiry math,
// double-counting the shares. Fixed by skipping the strike-price synthesis whenever a
// matching real trade already accounts for the assignment.
function assignedPutLeg(overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg {
  return {
    id: "leg-1",
    positionId: "pos-put",
    side: "short",
    optionType: "put",
    strike: 81,
    quantity: 1,
    multiplier: 100,
    entryPrice: 0.0887,
    entryAt: new Date("2026-09-21T14:09:11.987Z"),
    exitPrice: 0,
    exitAt: new Date("2026-09-24T02:04:09.041Z"),
    closingCommission: 0,
    hasClosingTrade: false,
    expiryDate: "2026-09-23",
    expiryClose: 80.46,
    positionCloseReason: "assigned",
    ...overrides,
  };
}

function assignmentStockTrade(overrides: Partial<CycleStockTrade> = {}): CycleStockTrade {
  return { at: new Date("2026-09-24T02:03:22.000Z"), side: "buy", quantity: 100, price: 81, commission: 0, ...overrides };
}

describe("summarizeOpenCycle — CSP assignment double-count", () => {
  it("does not double-count shares when a real stock trade already recorded the assignment", () => {
    const summary = summarizeOpenCycle([assignedPutLeg()], [assignmentStockTrade()], 100);
    expect(summary).not.toBeNull();
    expect(summary!.unavailableReason).toBeNull();
    expect(summary!.sharesHeld).toBe(100);
    expect(summary!.sharesAcquired).toBe(100);
    expect(summary!.acquisitionCost).toBe(8100);
    // (8100 acquisition cost - 8.87 net premium) / 100 shares — matches the real TLT position's
    // stored break-even (80.9113) confirmed against the dev DB while diagnosing this bug.
    expect(summary!.breakEvenPerShare).toBeCloseTo(80.9113, 4);

    const { breakEven, reason } = breakEvenForPosition(summary!, "pos-stock");
    expect(reason).toBeNull();
    expect(breakEven).toBeCloseTo(80.9113, 4);
  });

  it("falls back to strike-price synthesis when no matching real trade is found (execution never arrived)", () => {
    const summary = summarizeOpenCycle([assignedPutLeg()], [], 100);
    expect(summary).not.toBeNull();
    expect(summary!.unavailableReason).toBeNull();
    expect(summary!.sharesHeld).toBe(100);
    expect(summary!.sharesAcquired).toBe(100);
    expect(summary!.acquisitionCost).toBe(8100);
  });

  it("still synthesizes shares for a legacy/backfilled assignment with no close_reason recorded", () => {
    const summary = summarizeOpenCycle([assignedPutLeg({ positionCloseReason: null })], [], 100);
    expect(summary).not.toBeNull();
    expect(summary!.unavailableReason).toBeNull();
    expect(summary!.sharesHeld).toBe(100);
    expect(summary!.sharesAcquired).toBe(100);
  });

  it("does not consume an unrelated real stock trade that falls outside the grouping window", () => {
    const farTrade = assignmentStockTrade({ at: new Date("2026-09-20T00:00:00.000Z") });
    const summary = summarizeOpenCycle([assignedPutLeg()], [farTrade], 100);
    // Two independent 100-share buys land in the ledger (the unrelated far trade, plus the
    // strike-price fallback for the unmatched assignment) — 200 sh vs. 100 sh actually held.
    expect(summary).not.toBeNull();
    expect(summary!.unavailableReason).toContain("ledger says 200 sh held but the open stock legs total 100 sh");
  });
});
