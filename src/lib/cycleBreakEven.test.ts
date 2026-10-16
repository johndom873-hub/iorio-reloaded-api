import { describe, expect, it } from "vitest";
import { summarizeOpenCycle, breakEvenForPosition, breakEvenByPositionFromHistory, type CycleOptionLeg, type CycleStockTrade } from "./cycleBreakEven.js";
import { deriveCycles } from "./cycles.js";

// The worker records IBKR's stock fill of an assignment as a real trade, while the ledger also infers the same
// assignment from the put that expired in the money: the fill must be absorbed by the inferred assignment, or the
// shares count twice ("ledger says 200 sh held but the open stock legs total 100 sh") and the break-even goes blank.
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

  it("does not consume an unrelated real stock trade executed more than 36 hours from the leg's exit", () => {
    const farTrade = assignmentStockTrade({ at: new Date("2026-09-20T00:00:00.000Z") });
    const summary = summarizeOpenCycle([assignedPutLeg()], [farTrade], 100);
    // Two independent 100-share buys land in the ledger (the unrelated far trade, plus the
    // strike-price fallback for the unmatched assignment) — 200 sh vs. 100 sh actually held.
    expect(summary).not.toBeNull();
    expect(summary!.unavailableReason).toContain("ledger says 200 sh held but the open stock legs total 100 sh");
  });

  it("counts the assignment fill's commission once, as deriveCycles does", () => {
    const fill = assignmentStockTrade({ commission: 1.05, positionId: "pos-stock" });
    const summary = summarizeOpenCycle([assignedPutLeg()], [fill], 100)!;
    expect(summary.unavailableReason).toBeNull();
    expect(summary.sharesAcquired).toBe(100);
    expect(summary.acquisitionCost).toBeCloseTo(8101.05, 8);
    expect(summary.breakEvenPerShare).toBeCloseTo((8101.05 - 8.87) / 100, 8);
    // The cost is the position's whose stock leg holds the fill: the shares landed there.
    expect(summary.contributionsByPositionId.get("pos-stock")!.acquisitionCost).toBeCloseTo(8101.05, 8);

    const { positionCloseReason: _positionCloseReason, ...putLeg } = assignedPutLeg();
    const [cycle] = deriveCycles({
      optionLegs: [putLeg],
      stockLegs: [{ positionId: "pos-stock", quantity: 100, entryAt: putLeg.exitAt!, exitAt: null }],
      stockTrades: [fill],
      dailyCloses: new Map([["2026-09-23", 80.46]]),
      lastPrice: { date: "2026-09-23", price: 80.46 },
      openPositionPremiumPnl: new Map(),
    });
    expect(cycle!.dataFlags).toEqual([]);
    expect(cycle!.breakEvenPerShare).toBeCloseTo(summary.breakEvenPerShare!, 8);
  });

  it("matches a fill executed 10 minutes after the leg's exit", () => {
    const lateFill = assignmentStockTrade({ at: new Date("2026-09-24T02:14:09.041Z") });
    const summary = summarizeOpenCycle([assignedPutLeg()], [lateFill], 100)!;
    expect(summary.unavailableReason).toBeNull();
    expect(summary.sharesHeld).toBe(100);
    expect(summary.acquisitionCost).toBe(8100);
  });

  it("matches the fill whatever close_reason the put's position carries", () => {
    for (const positionCloseReason of [null, "expired_worthless", "closed_via_app"]) {
      const summary = summarizeOpenCycle([assignedPutLeg({ positionCloseReason })], [assignmentStockTrade()], 100)!;
      expect(summary.unavailableReason).toBeNull();
      expect(summary.sharesHeld).toBe(100);
    }
  });

  it("matches the fill of an early assignment (a leg that states it was assigned before its expiry date)", () => {
    // Assigned overnight after the 21 September session, two days before the 23 September expiry.
    const earlyAssigned = assignedPutLeg({ exitAt: new Date("2026-09-22T01:40:00Z"), expiryClose: 80.7, settledAs: "assigned" });
    const summary = summarizeOpenCycle([earlyAssigned], [assignmentStockTrade({ at: new Date("2026-09-22T01:39:30Z"), commission: 0.9 })], 100)!;
    expect(summary.unavailableReason).toBeNull();
    expect(summary.sharesHeld).toBe(100);
    expect(summary.acquisitionCost).toBeCloseTo(8100.9, 8);
  });
});

describe("summarizeOpenCycle — call assignment fills", () => {
  // A Covered Call entry on 5 October (100 shares at 50.00 + 1.00, the $52 call sold at 1.20) called away after the
  // 9 October expiry (close 53.40); IBKR's sale of the shares at the strike was recorded 10 minutes after the leg closed,
  // on a position reconciliation did not mark assigned.
  const coveredCallOpenedAt = new Date("2026-10-05T14:00:00Z");
  const calledAwayAt = new Date("2026-10-10T01:45:00Z");
  const calledAwayCall = assignedPutLeg({ id: "call-a", positionId: "cc-a", optionType: "call", strike: 52, entryPrice: 1.2, entryAt: coveredCallOpenedAt, exitAt: calledAwayAt, expiryDate: "2026-10-09", expiryClose: 53.4, positionCloseReason: null });
  const firstPurchase = assignmentStockTrade({ at: coveredCallOpenedAt, price: 50, commission: 1, positionId: "cc-a" });
  const callAwaySale = assignmentStockTrade({ at: new Date("2026-10-10T01:55:00Z"), side: "sell", price: 52, commission: 0.6, positionId: "cc-a" });

  it("a single Covered Call called away with its recorded sale leaves the symbol flat", () => {
    expect(summarizeOpenCycle([calledAwayCall], [firstPurchase, callAwaySale], 0)).toBeNull();
  });

  it("two Covered Calls on one ticker, one called away: the other keeps its shares and gets the break-even", () => {
    const secondOpenedAt = new Date("2026-10-06T14:00:00Z");
    const openCall: CycleOptionLeg = { ...calledAwayCall, id: "call-b", positionId: "cc-b", strike: 55, entryPrice: 0.8, entryAt: secondOpenedAt, exitPrice: null, exitAt: null, expiryDate: "2026-10-16", expiryClose: null };
    const secondPurchase = assignmentStockTrade({ at: secondOpenedAt, price: 51, commission: 1, positionId: "cc-b" });
    const summary = summarizeOpenCycle([calledAwayCall, openCall], [firstPurchase, secondPurchase, callAwaySale], 100)!;
    expect(summary.unavailableReason).toBeNull();
    expect(summary.sharesHeld).toBe(100);
    // (5,001 + 5,101 − 120 − 80) / 200 shares acquired.
    expect(summary.breakEvenPerShare).toBeCloseTo(49.51, 8);
    const byPosition = breakEvenByPositionFromHistory(summary, [{ positionId: "cc-b", sharesHeld: 100 }], []);
    expect(byPosition.get("cc-b")!.breakEven!).toBeCloseTo(49.51, 8);
  });
});

describe("breakEvenByPositionFromHistory — each open position's own break-even", () => {
  // INTC 2026-10-15: the $100 put (2 @ 1.3358 net) assigned 200 shares at $100.00 into a leftover-stock position, which
  // handed them to the $98 covered call (2 @ 0.3553); the $94 covered call bought its own 100 @ $92.43 + $1.0903 (1 @ 1.143).
  const intcOptionLegs = (): CycleOptionLeg[] => [
    assignedPutLeg({ id: "put", positionId: "csp", strike: 100, quantity: 2, entryPrice: 1.3358, entryAt: new Date("2026-10-12T14:00:00Z"), exitAt: new Date("2026-10-15T01:43:00Z"), expiryDate: "2026-10-14", expiryClose: 98.12 }),
    { ...assignedPutLeg(), id: "call98", positionId: "the98", optionType: "call", strike: 98, quantity: 2, entryPrice: 0.3553, entryAt: new Date("2026-10-15T13:32:23Z"), exitPrice: null, exitAt: null, expiryDate: "2026-10-16", expiryClose: null, positionCloseReason: null },
    { ...assignedPutLeg(), id: "call94", positionId: "the94", optionType: "call", strike: 94, quantity: 1, entryPrice: 1.143, entryAt: new Date("2026-10-15T14:25:50Z"), exitPrice: null, exitAt: null, expiryDate: "2026-10-16", expiryClose: null, positionCloseReason: null },
  ];
  const intcStockTrades = (): CycleStockTrade[] => [
    assignmentStockTrade({ at: new Date("2026-10-15T01:42:53Z"), quantity: 200, price: 100, positionId: "leftover" }),
    assignmentStockTrade({ at: new Date("2026-10-15T14:25:50Z"), quantity: 100, price: 92.43, commission: 1.0903, positionId: "the94" }),
  ];
  const intcOpenPositions = [
    { positionId: "the98", sharesHeld: 200 },
    { positionId: "the94", sharesHeld: 100 },
  ];
  const intcShareSources = [
    { positionId: "leftover", sourcePositionId: "csp", sharesReceived: 200 },
    { positionId: "the98", sourcePositionId: "leftover", sharesReceived: 200 },
  ];

  it("INTC: the $98 position carries the put that delivered its shares, the $94 one only its own; weighted they are the cycle's", () => {
    const summary = summarizeOpenCycle(intcOptionLegs(), intcStockTrades(), 300)!;
    expect(summary.breakEvenPerShare).toBeCloseTo((29_244.09 - 452.52) / 300, 4);

    const byPosition = breakEvenByPositionFromHistory(summary, intcOpenPositions, intcShareSources);
    const the98 = byPosition.get("the98")!.breakEven!;
    const the94 = byPosition.get("the94")!.breakEven!;
    expect(the98).toBeCloseTo((20_000 - 267.16 - 71.06) / 200, 4);
    expect(the94).toBeCloseTo((9_244.09 - 114.3) / 100, 4);
    expect((200 * the98 + 100 * the94) / 300).toBeCloseTo(summary.breakEvenPerShare!, 6);
  });

  it("an amount no open position's history reaches is shared by shares held (the put's link missing)", () => {
    const summary = summarizeOpenCycle(intcOptionLegs(), intcStockTrades(), 300)!;
    const byPosition = breakEvenByPositionFromHistory(summary, intcOpenPositions, intcShareSources.filter((link) => link.sourcePositionId !== "csp"));
    expect(byPosition.get("the98")!.breakEven!).toBeCloseTo((20_000 - 71.06 - (267.16 * 2) / 3) / 200, 4);
    expect(byPosition.get("the94")!.breakEven!).toBeCloseTo((9_244.09 - 114.3 - 267.16 / 3) / 100, 4);
  });

  it("a ticker's only open position gets exactly the cycle's break-even, an earlier worthless put included", () => {
    const worthlessPut = assignedPutLeg({ id: "early-put", positionId: "early-csp", strike: 90, entryPrice: 0.5, entryAt: new Date("2026-10-05T14:00:00Z"), exitAt: new Date("2026-10-10T21:00:00Z"), expiryDate: "2026-10-09", expiryClose: 95, positionCloseReason: "expired_worthless" });
    const summary = summarizeOpenCycle([worthlessPut, ...intcOptionLegs().filter((leg) => leg.id !== "call94")], intcStockTrades().slice(0, 1), 200)!;
    const byPosition = breakEvenByPositionFromHistory(summary, [{ positionId: "the98", sharesHeld: 200 }], intcShareSources);
    expect(byPosition.get("the98")!.breakEven!).toBeCloseTo(summary.breakEvenPerShare!, 8);
  });

  it("a position that handed shares to two others splits its amounts by shares received", () => {
    const put = assignedPutLeg({ id: "put", positionId: "csp", strike: 100, quantity: 3, entryPrice: 1, entryAt: new Date("2026-10-12T14:00:00Z"), exitAt: new Date("2026-10-15T01:43:00Z"), expiryDate: "2026-10-14", expiryClose: 98 });
    const summary = summarizeOpenCycle([put], [assignmentStockTrade({ at: new Date("2026-10-15T01:42:53Z"), quantity: 300, price: 100, positionId: "leftover" })], 300)!;
    const byPosition = breakEvenByPositionFromHistory(
      summary,
      [
        { positionId: "first", sharesHeld: 200 },
        { positionId: "second", sharesHeld: 100 },
      ],
      [
        { positionId: "leftover", sourcePositionId: "csp", sharesReceived: 300 },
        { positionId: "first", sourcePositionId: "leftover", sharesReceived: 200 },
        { positionId: "second", sourcePositionId: "leftover", sharesReceived: 100 },
      ],
    );
    expect(byPosition.get("first")!.breakEven!).toBeCloseTo(99, 6);
    expect(byPosition.get("second")!.breakEven!).toBeCloseTo(99, 6);
  });

  it("two open puts and no shares: each its own strike - premium per put share, an earlier put's premium shared by put shares", () => {
    const earlierPut = assignedPutLeg({ id: "early", positionId: "early-csp", strike: 90, entryPrice: 0.6, entryAt: new Date("2026-10-05T14:00:00Z"), exitPrice: 0.2, exitAt: new Date("2026-10-06T15:00:00Z"), hasClosingTrade: true, positionCloseReason: "closed_via_app" });
    const openPut = (positionId: string, strike: number, entryPrice: number): CycleOptionLeg => ({ ...assignedPutLeg(), id: positionId, positionId, strike, entryPrice, entryAt: new Date("2026-10-06T15:00:30Z"), exitPrice: null, exitAt: null, expiryDate: "2026-10-23", expiryClose: null, positionCloseReason: null });
    const summary = summarizeOpenCycle([earlierPut, openPut("put-a", 95, 1.2), openPut("put-b", 92, 0.8)], [], 0)!;
    const byPosition = breakEvenByPositionFromHistory(summary, [{ positionId: "put-a", sharesHeld: 0 }, { positionId: "put-b", sharesHeld: 0 }], []);
    expect(byPosition.get("put-a")!.breakEven!).toBeCloseTo(95 - (120 + 20) / 100, 6);
    expect(byPosition.get("put-b")!.breakEven!).toBeCloseTo(92 - (80 + 20) / 100, 6);
  });

  it("a cycle that cannot be computed gives every position its reason", () => {
    const summary = summarizeOpenCycle(intcOptionLegs(), intcStockTrades(), 200)!;
    const byPosition = breakEvenByPositionFromHistory(summary, intcOpenPositions, intcShareSources);
    expect(byPosition.get("the94")).toEqual({ breakEven: null, reason: summary.unavailableReason });
  });
});
