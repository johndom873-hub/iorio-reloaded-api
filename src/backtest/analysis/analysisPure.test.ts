import { describe, expect, it } from "vitest";
import { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { analysisSessionName } from "./analysisBacktest.js";
import { treasuryBillCagr } from "./analysisSessions.js";
import { hashAnalysisLabValues, validateAnalysisTrialValues } from "./analysisStore.js";
import { fitByDay, ladderBasePath, largestPotOfDay, potOnDayFrom, tooLargeByYear, yieldGivenUp, type AnalysisOrder } from "./analysisPotSizing.js";
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
  const pluto = { windowStartEt: "10:00", windowEndEt: "15:30", capitalBudgetPct: 50 };
  const trading = { spreadCostChargedPct: 0, maxOrderPctOfPortfolio: 10 };
  const base = { defaultPotDollars: 200_000, tickerOverrides: null, trial: null };

  it("does not depend on key order", () => {
    const settings = { kellyFraction: 0.5, pluto, trading, baseline: { ladderRungs: 5, ladderSharesPct: 50 } } as unknown as BacktestSettings;
    const reordered = { baseline: { ladderSharesPct: 50, ladderRungs: 5 }, trading, pluto, kellyFraction: 0.5 } as unknown as BacktestSettings;
    expect(hashAnalysisLabValues({ ...base, settings })).toBe(hashAnalysisLabValues({ ...base, settings: reordered }));
    expect(hashAnalysisLabValues({ ...base, settings })).not.toBe(hashAnalysisLabValues({ ...base, defaultPotDollars: 100_000, settings }));
  });

  it("covers only what an analysis reads: Pluto's own rows leave it as it was", () => {
    const settings = { kellyFraction: 0.5, decisionMaker: "baseline", policy: { roll: "never" }, pluto, trading, baseline: { ladderRungs: 5 } } as unknown as BacktestSettings;
    const hash = hashAnalysisLabValues({ ...base, settings });
    const plutoOnly = { ...settings, kellyFraction: 0.25, decisionMaker: "rules", policy: { roll: "flagged_legs" }, pluto: { ...pluto, capitalBudgetPct: 80 }, trading: { ...trading, maxOrderPctOfPortfolio: 20 } } as unknown as BacktestSettings;
    expect(hashAnalysisLabValues({ ...base, settings: plutoOnly })).toBe(hash);
    expect(hashAnalysisLabValues({ ...base, settings: { ...settings, trading: { ...trading, spreadCostChargedPct: 50 } } as unknown as BacktestSettings })).not.toBe(hash);
    expect(hashAnalysisLabValues({ ...base, settings: { ...settings, baseline: { ladderRungs: 4 } } as unknown as BacktestSettings })).not.toBe(hash);
  });
});

const order = (overrides: Partial<AnalysisOrder>): AnalysisOrder => ({ date: "2025-03-03", at: "2025-03-03T15:00:00.000Z", right: "P", wanted: 4, best: { strike: 80, dte: 30, premiumYield: 0.2, volumeCap: 3 }, fills: [{ contracts: 3, premiumYield: 0.2 }], unsold: 0, unsoldReason: null, ...overrides });

describe("pot sizing", () => {
  it("fitByDay: smallest pot = max(100 × P ÷ p, 100 × P × (n − S) ÷ (1 − p))", () => {
    // P 100, p 0.5, n 5, S 0.8: lot 10,000 ÷ 0.5 = 20,000; rung side 100 × 100 × 4.2 ÷ 0.5 = 84,000.
    const [row] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { shares: 0.5, rungs: 5, fixedShock: null }, () => 200_000);
    expect(row!.smallestPot).toBeCloseTo(84_000, 6);
    expect(row!.lotFits).toBe(true);
    // A rung of 200,000 × 0.5 ÷ 5 = 20,000 holds a Put at the first cap 100 × (1 − 0.16) = 84 (8,400).
    expect(row!.rungFits).toBe(true);
    // A share level of 0.05 makes the lot side bind: 10,000 ÷ 0.05 = 200,000, and a $10,000 lot budget exactly buys a lot.
    const [lotSide] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { shares: 0.05, rungs: 5, fixedShock: null }, () => 200_000);
    expect(lotSide!.smallestPot).toBeCloseTo(200_000, 6);
    expect(lotSide!.lotFits).toBe(true);
    const [small] = fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { shares: 0.5, rungs: 5, fixedShock: null }, () => 15_000);
    expect(small!.lotFits).toBe(false);
    expect(small!.rungFits).toBe(false);
    // Each day against its own pot; no pot path: no fits.
    const [early, late] = fitByDay(
      [
        { date: "2025-01-02", price: 100, shock: 0.8 },
        { date: "2025-06-02", price: 100, shock: 0.8 },
      ],
      { shares: 0.5, rungs: 5, fixedShock: null },
      (date) => (date < "2025-03-01" ? 15_000 : 200_000),
    );
    expect([early!.lotFits, late!.lotFits]).toEqual([false, true]);
    expect(fitByDay([{ date: "2025-01-02", price: 100, shock: 0.8 }], { shares: 0.5, rungs: 5, fixedShock: null }, null)[0]).toMatchObject({ lotFits: null, rungFits: null });
  });

  it("largestPotOfDay: the smaller of Put limit × strike × 100 × n ÷ (1 − p) and Call limit × 100 × P ÷ p", () => {
    // 14 Oct 2026, HOOD at $106.01: the $85 Put with limit 96 → 96 × 85 × 100 × 5 ÷ 0.5 = $8,160,000; the Call with limit
    // 1,746 → 1,746 × 100 × 106.01 ÷ 0.5 = $37,016,700. The Put side sets it.
    const values = { shares: 0.5, rungs: 5 };
    const day = { date: "2026-10-14", price: 106.01, putVolumeCap: 96, putStrike: 85, callVolumeCap: 1746 };
    expect(largestPotOfDay(day, values)!.pot).toBeCloseTo(8_160_000, 6);
    expect(largestPotOfDay(day, values)!.right).toBe("P");
    expect(largestPotOfDay({ ...day, callVolumeCap: 10 }, values)).toEqual({ pot: (10 * 100 * 106.01) / 0.5, right: "C" });
    // A side with no qualifying contract: the day is left out.
    expect(largestPotOfDay({ ...day, putVolumeCap: null, putStrike: null }, values)).toBeNull();
    expect(largestPotOfDay({ ...day, callVolumeCap: null }, values)).toBeNull();
  });

  it("ladderBasePath: max(account at the open cycle's start, last night's account), last night's while flat", () => {
    const days = [
      { date: "2022-01-03", accountValue: 200_000 },
      { date: "2022-01-04", accountValue: 150_000 },
      { date: "2022-01-05", accountValue: 120_000 },
      { date: "2022-01-06", accountValue: 130_000 },
      { date: "2022-01-07", accountValue: 260_000 },
      { date: "2022-01-10", accountValue: 270_000 },
    ];
    // Cycle 1 from the 4th (started at the 3rd's close, $200,000) to the 6th; flat on the 7th; cycle 2 from the 10th.
    const path = ladderBasePath(days, [{ openedOn: "2022-01-04", closedOn: "2022-01-06" }, { openedOn: "2022-01-10", closedOn: null }], 200_000);
    expect(path).toEqual([
      ["2022-01-03", 200_000],
      ["2022-01-04", 200_000],
      ["2022-01-05", 200_000],
      ["2022-01-06", 200_000],
      ["2022-01-07", 130_000],
      ["2022-01-10", 260_000],
    ]);
    const potOnDay = potOnDayFrom(path)!;
    expect(potOnDay("2022-01-05")).toBe(200_000);
    // A weekend carries the Friday; past the last day the last value carries forward; before the first, the first.
    expect(potOnDay("2022-01-08")).toBe(130_000);
    expect(potOnDay("2022-02-01")).toBe(260_000);
    expect(potOnDay("2021-12-31")).toBe(200_000);
    expect(potOnDayFrom([])).toBeNull();
  });

  it("yieldGivenUp and tooLargeByYear count orders over one strike and partly unsold", () => {
    const multi = order({ fills: [{ contracts: 3, premiumYield: 0.2 }, { contracts: 1, premiumYield: 0.12 }] });
    expect(yieldGivenUp(multi)).toBeCloseTo(0.2 - (3 * 0.2 + 0.12) / 4, 9);
    const byYear = tooLargeByYear([multi, order({ date: "2025-03-04", unsold: 2, unsoldReason: "volume" }), order({ date: "2026-01-05", right: "C" })]);
    expect(byYear["2025"]).toEqual({ saleDays: 2, callDaysOverOneStrike: 0, putDaysOverOneStrike: 1, medianYieldGivenUp: yieldGivenUp(multi), callDaysPartlyUnsold: 0, putDaysPartlyUnsold: 1 });
    expect(byYear["2026"]!.saleDays).toBe(1);
  });
});
