import { describe, expect, it } from "vitest";
import { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { analysisSessionName } from "./analysisBacktest.js";
import { treasuryBillCagr } from "./analysisSessions.js";
import { hashAnalysisLabValues, validateAnalysisTrialValues } from "./analysisStore.js";
import { fitByDay, largestPotOfOrder, tooLargeByYear, yieldGivenUp, type AnalysisOrder } from "./analysisPotSizing.js";
import type { BacktestSettings } from "../backtestTypes.js";

describe("analysisSessionName", () => {
  it("names the session with shares, rungs, the |delta| range and the pot", () => {
    expect(analysisSessionName("HOOD", 200_000, { ladderSharesPct: 50, ladderRungs: 5, minAbsDelta: 0.05, maxAbsDelta: 0.3 })).toBe("Analysis · HOOD · 50% shares · 5 rungs · |delta| 0.05–0.30 · $200k");
    expect(analysisSessionName("SMCI", 1_250_000, { ladderSharesPct: 30, ladderRungs: 1, minAbsDelta: 0.1, maxAbsDelta: 0.25 })).toBe("Analysis · SMCI · 30% shares · 1 rung · |delta| 0.10–0.25 · $1.25M");
    expect(analysisSessionName("HOOD", 62_500, { ladderSharesPct: 50, ladderRungs: 5, minAbsDelta: 0.05, maxAbsDelta: 0.3 })).toContain("$62.5k");
  });
});

describe("treasuryBillCagr", () => {
  it("compounds the rate over the weekdays as the engine credits interest", () => {
    // 5% all year: daily credit 5% × days ÷ 365 over every weekday gap, a little above 5% compounded.
    const rates = new TreasuryBillRates([{ dateIso: "2020-01-01", ratePercent: 5 }]);
    const cagr = treasuryBillCagr(rates, "2024-01-02", "2025-01-02");
    expect(cagr).toBeGreaterThan(0.05);
    expect(cagr).toBeLessThan(0.0515);
  });

  it("is 0 with no rate and over an empty period", () => {
    const rates = new TreasuryBillRates([]);
    expect(treasuryBillCagr(rates, "2024-01-02", "2025-01-02")).toBe(0);
    expect(treasuryBillCagr(new TreasuryBillRates([{ dateIso: "2020-01-01", ratePercent: 5 }]), "2024-01-02", "2024-01-02")).toBe(0);
  });
});

describe("validateAnalysisTrialValues", () => {
  it("keeps numbers, a null shock (the rule) and refuses anything else", () => {
    expect(validateAnalysisTrialValues({ potDollars: 50_000, ladderShockPct: null, maxDte: 30 })).toEqual({ potDollars: 50_000, ladderShockPct: null, maxDte: 30 });
    expect(() => validateAnalysisTrialValues({ minimumBid: 0.1 })).toThrow(/not a value/);
    expect(() => validateAnalysisTrialValues({ ladderRungs: "5" })).toThrow(/must be a number/);
    expect(() => validateAnalysisTrialValues({ potDollars: 0 })).toThrow(/above \$0/);
    expect(() => validateAnalysisTrialValues([])).toThrow(/must be an object/);
  });
});

describe("hashAnalysisLabValues", () => {
  it("does not depend on key order", () => {
    const settings = { kellyFraction: 0.5, baseline: { ladderRungs: 5, ladderSharesPct: 50 } } as unknown as BacktestSettings;
    const reordered = { baseline: { ladderSharesPct: 50, ladderRungs: 5 }, kellyFraction: 0.5 } as unknown as BacktestSettings;
    const base = { defaultPotDollars: 200_000, tickerOverrides: null, trial: null };
    expect(hashAnalysisLabValues({ ...base, settings })).toBe(hashAnalysisLabValues({ ...base, settings: reordered }));
    expect(hashAnalysisLabValues({ ...base, settings })).not.toBe(hashAnalysisLabValues({ ...base, defaultPotDollars: 100_000, settings }));
  });
});

const order = (overrides: Partial<AnalysisOrder>): AnalysisOrder => ({ date: "2025-03-03", at: "2025-03-03T15:00:00.000Z", right: "P", wanted: 4, best: { strike: 80, dte: 30, premiumYield: 0.2, volumeCap: 3 }, fills: [{ contracts: 3, premiumYield: 0.2 }], unsold: 0, unsoldReason: null, sharesAverageCost: null, ...overrides });

describe("pot sizing", () => {
  it("fitByDay: smallest pot = max(100 × P ÷ p, 100 × P × (n − S) ÷ (1 − p))", () => {
    // P 100, p 0.5, n 5, S 0.8: lot 10,000 ÷ 0.5 = 20,000; rung side 100 × 100 × 4.2 ÷ 0.5 = 84,000.
    const [row] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { potDollars: 200_000, shares: 0.5, rungs: 5, fixedShock: null });
    expect(row!.smallestPot).toBeCloseTo(84_000, 6);
    expect(row!.lotFits).toBe(true);
    // A rung of 200,000 × 0.5 ÷ 5 = 20,000 holds a Put at the first cap 100 × (1 − 0.16) = 84 (8,400).
    expect(row!.rungFits).toBe(true);
    // A share level of 0.05 makes the lot side bind: 10,000 ÷ 0.05 = 200,000, and a $10,000 lot budget exactly buys a lot.
    const [lotSide] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { potDollars: 200_000, shares: 0.05, rungs: 5, fixedShock: null });
    expect(lotSide!.smallestPot).toBeCloseTo(200_000, 6);
    expect(lotSide!.lotFits).toBe(true);
    const [small] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { potDollars: 15_000, shares: 0.5, rungs: 5, fixedShock: null });
    expect(small!.lotFits).toBe(false);
    expect(small!.rungFits).toBe(false);
  });

  it("largestPotOfOrder: Put limit × strike × 100 × n ÷ (1 − p); Call limit × 100 × the shares' cost ÷ p", () => {
    expect(largestPotOfOrder(order({}), { shares: 0.5, rungs: 5 })).toBeCloseTo((3 * 80 * 100 * 5) / 0.5, 6);
    expect(largestPotOfOrder(order({ right: "C", sharesAverageCost: 90 }), { shares: 0.5, rungs: 5 })).toBeCloseTo((3 * 100 * 90) / 0.5, 6);
    expect(largestPotOfOrder(order({ right: "C", sharesAverageCost: null }), { shares: 0.5, rungs: 5 })).toBeNull();
    // An entry's shares cost the look's price (the loader takes stockPriceAtLook when no shares are held).
    expect(largestPotOfOrder(order({ right: "C", sharesAverageCost: 45 }), { shares: 0.5, rungs: 5 })).toBeCloseTo((3 * 100 * 45) / 0.5, 6);
    expect(largestPotOfOrder(order({ best: null }), { shares: 0.5, rungs: 5 })).toBeNull();
  });

  it("yieldGivenUp and tooLargeByYear count orders over one strike and partly unsold", () => {
    const multi = order({ fills: [{ contracts: 3, premiumYield: 0.2 }, { contracts: 1, premiumYield: 0.12 }] });
    expect(yieldGivenUp(multi)).toBeCloseTo(0.2 - (3 * 0.2 + 0.12) / 4, 9);
    const byYear = tooLargeByYear([multi, order({ date: "2025-03-04", unsold: 2, unsoldReason: "volume" }), order({ date: "2026-01-05", right: "C" })]);
    expect(byYear["2025"]).toEqual({ saleDays: 2, callDaysOverOneStrike: 0, putDaysOverOneStrike: 1, medianYieldGivenUp: yieldGivenUp(multi), callDaysPartlyUnsold: 0, putDaysPartlyUnsold: 1 });
    expect(byYear["2026"]!.saleDays).toBe(1);
  });
});
