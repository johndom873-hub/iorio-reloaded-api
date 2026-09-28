import { describe, expect, it } from "vitest";
import { computeOpenCycleMarks } from "./cycleLiveMarks.js";
import { deriveCycles, type CycleInput } from "./cycles.js";

// 100 shares bought at 50 with a covered call (short 1x $55C sold at 2.00) opened with them; marked at a daily close of 55.
function coveredCallInput(openPositionPremiumPnl: Map<string, number> = new Map()): CycleInput {
  return {
    optionLegs: [
      {
        id: "call-leg", positionId: "pos-cc", side: "short", optionType: "call", strike: 55, quantity: 1, multiplier: 100, entryPrice: 2,
        entryAt: new Date("2026-09-01T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
        expiryDate: "2026-10-16", expiryClose: null,
      },
    ],
    stockLegs: [{ positionId: "pos-cc", quantity: 100, entryAt: new Date("2026-09-01T15:00:00Z"), exitAt: null }],
    stockTrades: [{ at: new Date("2026-09-01T15:00:00Z"), side: "buy", quantity: 100, price: 50, commission: 0 }],
    dailyCloses: new Map([["2026-09-25", 55]]),
    lastPrice: { date: "2026-09-25", price: 55 },
    openPositionPremiumPnl,
  };
}

// The formula the Positions table applies in the browser.
function liveTotal(marks: NonNullable<ReturnType<typeof computeOpenCycleMarks>>, rowPrice: number, livePremiumPnlByPositionId: Record<string, number>): number {
  let total = marks.total + marks.sharesHeld * (rowPrice - marks.markPrice!);
  for (const [positionId, storedMark] of Object.entries(marks.optionMarks)) {
    if (positionId in livePremiumPnlByPositionId) total += livePremiumPnlByPositionId[positionId]! - storedMark;
  }
  return total;
}

describe("computeOpenCycleMarks", () => {
  it("reports the stored marks: total, shares, mark price and the credit when there is no snapshot", () => {
    const marks = computeOpenCycleMarks("ABC", coveredCallInput())!;
    expect(marks.sharesHeld).toBe(100);
    expect(marks.markPrice).toBe(55);
    expect(marks.markDate).toBe("2026-09-25");
    expect(marks.optionMarks).toEqual({ "pos-cc": 200 }); // 2.00 x 100 credit: no snapshot means the option is carried at its credit
    expect(marks.total).toBeCloseTo(700); // 500 stock (50 -> 55) + 200 premium collected
    expect(marks.dataFlags).toEqual([]);
  });

  it("uses the nightly snapshot as the option mark when there is one", () => {
    const marks = computeOpenCycleMarks("ABC", coveredCallInput(new Map([["pos-cc", 120]])))!;
    expect(marks.optionMarks).toEqual({ "pos-cc": 120 });
    expect(marks.total).toBeCloseTo(620); // 500 stock + 200 credit - (200 - 120) marked down
  });

  it("returns null when the ticker has no open cycle", () => {
    const flat: CycleInput = { ...coveredCallInput(), optionLegs: [], stockLegs: [], stockTrades: [] };
    expect(computeOpenCycleMarks("ABC", flat)).toBeNull();
  });

  it.each([
    ["stock up, call cheaper", 60, 150],
    ["stock down, call worth more", 48, -300],
    ["unchanged marks", 55, 200],
  ])("live formula equals re-deriving the cycle with the live marks (%s)", (_label, rowPrice, livePremiumPnl) => {
    for (const snapshot of [new Map<string, number>(), new Map([["pos-cc", 120]])]) {
      const input = coveredCallInput(snapshot);
      const marks = computeOpenCycleMarks("ABC", input)!;
      const rederived = deriveCycles({
        ...input,
        lastPrice: { date: "2026-09-28", price: rowPrice },
        openPositionPremiumPnl: new Map([["pos-cc", livePremiumPnl]]),
      }).find((cycle) => cycle.status === "open")!;
      expect(liveTotal(marks, rowPrice, { "pos-cc": livePremiumPnl })).toBeCloseTo(rederived.total);
    }
  });

  it("with no live marks available the figure stays at the stored total", () => {
    const marks = computeOpenCycleMarks("ABC", coveredCallInput())!;
    expect(liveTotal(marks, marks.markPrice!, {})).toBeCloseTo(marks.total);
  });
});
