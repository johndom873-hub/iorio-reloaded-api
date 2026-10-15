import { describe, expect, it } from "vitest";
import { defaultBacktestBaselineSettings } from "../backtestTypes.js";
import { deepestFallFromPeak, ladderBase, ladderBudget, ladderCommitted, ladderRungCollateral, ladderRungToday, ladderShareLots, ladderShock, ladderStrikeCap, noteLadderLook } from "./backtestBaselineLadder.js";
import type { SimulatedLedger } from "./ledger/simulatedLedger.js";

const settings = { ...defaultBacktestBaselineSettings, putsWhenNoCall: "reserve_ladder" as const };

describe("the ladder's strike cap", () => {
  it("matches the worked example: break-even $100, peak $110, shock 70%, $100,000 in 5 rungs", () => {
    const floor = 110 * (1 - 0.7);
    expect(ladderStrikeCap({ breakEven: 100, floor, committed: 0, rungCollateral: 20_000, reserve: 100_000 })).toBeCloseTo(86.6, 6);
    expect(ladderStrikeCap({ breakEven: 95.5, floor, committed: 15_000, rungCollateral: 20_000, reserve: 100_000 })).toBeCloseTo(73.625, 6);
  });

  it("puts the last rung's cap on the floor", () => {
    expect(ladderStrikeCap({ breakEven: 80, floor: 33, committed: 80_000, rungCollateral: 20_000, reserve: 100_000 })).toBeCloseTo(33, 6);
  });

  it("allows no put without a break-even, with the reserve spent, or with the break-even at or below the floor", () => {
    expect(ladderStrikeCap({ breakEven: null, floor: 33, committed: 0, rungCollateral: 20_000, reserve: 100_000 })).toBeNull();
    expect(ladderStrikeCap({ breakEven: 100, floor: 33, committed: 100_000, rungCollateral: 0, reserve: 100_000 })).toBeNull();
    expect(ladderStrikeCap({ breakEven: 30, floor: 33, committed: 0, rungCollateral: 20_000, reserve: 100_000 })).toBeNull();
  });
});

describe("the ladder's budget", () => {
  it("splits the cycle's starting value into the shares' budget and the reserve", () => {
    expect(ladderBudget(200_000, 50)).toEqual({ sharesBudget: 100_000, reserve: 100_000 });
    expect(ladderBudget(200_000, 70)).toEqual({ sharesBudget: 140_000, reserve: 60_000 });
  });

  it("takes the budget from the larger of the cycle's starting value and today's: a rally grows it, a fall keeps it", () => {
    expect(ladderBase({ accountValueAtStart: 200_000 }, 400_000, 1)).toBe(400_000);
    expect(ladderBase({ accountValueAtStart: 200_000 }, 120_000, 1)).toBe(200_000);
    expect(ladderBudget(ladderBase({ accountValueAtStart: 200_000 }, 400_000, 1), 50)).toEqual({ sharesBudget: 200_000, reserve: 200_000 });
  });

  it("gives a ticker of a pots session its weight of that base: pots $80,000 and $120,000 are 40% and 60% of the account", () => {
    // The account started at $200,000 and is $250,000 today: the 40% ticker's base is 0.4 × 250,000 = $100,000.
    expect(ladderBase({ accountValueAtStart: 200_000 }, 250_000, 0.4)).toBeCloseTo(100_000, 6);
    // After a fall to $150,000 it keeps 0.4 × 200,000 = $80,000, its pot at the cycle's start.
    expect(ladderBase({ accountValueAtStart: 200_000 }, 150_000, 0.4)).toBeCloseTo(80_000, 6);
    expect(ladderBudget(ladderBase({ accountValueAtStart: 200_000 }, 250_000, 0.6), 50)).toEqual({ sharesBudget: 75_000, reserve: 75_000 });
  });

  it("counts as committed only what the stock holds beyond the shares' budget", () => {
    expect(ladderCommitted(100_000, 15_000, 100_000)).toBe(15_000);
    expect(ladderCommitted(90_000, 0, 100_000)).toBe(0);
  });

  it("sizes a rung at reserve ÷ rungs, never more than what is left", () => {
    expect(ladderRungCollateral(100_000, 0, 5)).toBe(20_000);
    expect(ladderRungCollateral(100_000, 87_500, 5)).toBe(12_500);
    expect(ladderRungCollateral(100_000, 120_000, 5)).toBe(0);
  });

  it("gives the buy-writes the round lots the budget has room for", () => {
    expect(ladderShareLots(10_000, 33)).toBe(3);
    expect(ladderShareLots(-5, 33)).toBe(0);
  });
});

describe("the stock shock", () => {
  const closes = (values: number[], fromYear = 2015) => values.map((close, index) => ({ date: `${fromYear + Math.floor(index / 300)}-01-${String((index % 28) + 1).padStart(2, "0")}`, close }));

  it("measures the deepest fall from a running peak", () => {
    expect(deepestFallFromPeak([10, 20, 5, 30, 24])).toBeCloseTo(0.75, 9);
    expect(deepestFallFromPeak([10])).toBe(0);
  });

  it("is the fixed value when asked", () => {
    expect(ladderShock({ ...settings, ladderShock: "fixed", ladderShockPct: 55 }, [], "2024-03-13")).toBeCloseTo(0.55, 9);
  });

  it("from history, keeps the deepest fall within the range (60–80% by default)", () => {
    const fall70 = closes([...Array.from({ length: 200 }, () => 100), ...Array.from({ length: 200 }, () => 30)]);
    expect(ladderShock(settings, fall70, "2024-01-01")).toBeCloseTo(0.7, 9);
    const fall90 = closes([...Array.from({ length: 200 }, () => 100), ...Array.from({ length: 200 }, () => 10)]);
    expect(ladderShock(settings, fall90, "2024-01-01")).toBeCloseTo(0.8, 9);
    const fall10 = closes([...Array.from({ length: 200 }, () => 100), ...Array.from({ length: 200 }, () => 90)]);
    expect(ladderShock(settings, fall10, "2024-01-01")).toBeCloseTo(0.6, 9);
  });

  it("takes 90% with under a year of history (a new listing, above the 80% cap), and never reads a close on or after the cycle's start", () => {
    expect(ladderShock(settings, closes([100, 50]), "2024-01-01")).toBeCloseTo(0.9, 9);
    const afterStart = [...closes(Array.from({ length: 300 }, () => 100), 2022), { date: "2024-03-13", close: 1 }];
    expect(ladderShock(settings, afterStart, "2024-03-13")).toBeCloseTo(0.6, 9);
  });
});

describe("the ladder's cycle state", () => {
  const look = (overrides: Partial<Parameters<typeof noteLadderLook>[2]>) => ({ cycleOpen: false, todayIso: "2024-03-12", accountValue: 200_000, stockPriceOnCycleScale: 110, adjustedClosesBefore: [], ...overrides });

  it("starts a cycle with the value of the last flat look, fixes S, then raises the peak only", () => {
    const ledger = {} as SimulatedLedger;
    expect(noteLadderLook(ledger, "SMCI", look({}), settings).startedOn).toBeNull();
    const started = noteLadderLook(ledger, "SMCI", look({ cycleOpen: true, todayIso: "2024-03-13", accountValue: 199_000, stockPriceOnCycleScale: 118 }), settings);
    expect(started).toEqual({ startedOn: "2024-03-13", accountValueAtStart: 200_000, peakOnCycleScale: 118, shock: 0.9 });
    expect(noteLadderLook(ledger, "SMCI", look({ cycleOpen: true, todayIso: "2024-03-14", stockPriceOnCycleScale: 100 }), settings).peakOnCycleScale).toBe(118);
    expect(noteLadderLook(ledger, "SMCI", look({ cycleOpen: true, todayIso: "2024-03-15", stockPriceOnCycleScale: 125 }), settings).peakOnCycleScale).toBe(125);
    expect(noteLadderLook(ledger, "SMCI", look({ todayIso: "2024-09-01", accountValue: 150_000 }), settings)).toMatchObject({ startedOn: null, accountValueAtStart: 150_000 });
  });

  it("reports today's rung from the state", () => {
    const state = { startedOn: "2024-01-02", accountValueAtStart: 200_000, peakOnCycleScale: 110, shock: 0.7 };
    const rung = ladderRungToday({ settings: { ladderSharesPct: 50, ladderRungs: 5, ladderTop: "break_even" }, state, accountValueToday: 180_000, tickerWeight: 1, breakEven: 100, stockPrice: 80, heldSharesCost: 100_000, openPutCollateral: 0, priceToCycleScale: 1 });
    expect(rung.cap).toBeCloseTo(86.6, 6);
    expect(rung.collateral).toBe(20_000);
    // From today's price: 80 − (80 − 33) × 0.2 = 70.60.
    expect(ladderRungToday({ settings: { ladderSharesPct: 50, ladderRungs: 5, ladderTop: "price" }, state, accountValueToday: 180_000, tickerWeight: 1, breakEven: 100, stockPrice: 80, heldSharesCost: 100_000, openPutCollateral: 0, priceToCycleScale: 1 }).cap).toBeCloseTo(70.6, 6);
  });
});
