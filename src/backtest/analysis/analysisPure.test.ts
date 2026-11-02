import { describe, expect, it } from "vitest";
import { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { analysisSessionName } from "./analysisBacktest.js";
import { treasuryBillCagr } from "./analysisSessions.js";
import { analysisLabValuesOf, hashAnalysisLabValues, validateAnalysisTrialValues } from "./analysisStore.js";
import { noTickerOwnValues } from "../labTickerValuesStore.js";
import { barIndicatorsOf, sliceBarIndicators } from "./analysisPriceFigures.js";
import { defaultBacktestVolFarmerV4Settings, type BacktestSettings } from "../backtestTypes.js";

describe("analysisSessionName", () => {
  it("names the session with the ticker, Vol Farmer v4 and the account, a trial's as one", () => {
    expect(analysisSessionName("AMD", 100_000, false)).toBe("Analysis · AMD · Vol Farmer v4 · $100k");
    expect(analysisSessionName("SMCI", 1_250_000, false)).toBe("Analysis · SMCI · Vol Farmer v4 · $1.25M");
    expect(analysisSessionName("HOOD", 62_500, true)).toBe("Analysis trial · HOOD · Vol Farmer v4 · $62.5k");
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
  it("takes the starting account only", () => {
    expect(validateAnalysisTrialValues({ accountDollars: 500_000 })).toEqual({ accountDollars: 500_000 });
    expect(() => validateAnalysisTrialValues({ accountDollars: 500_000, potDollars: 1 })).toThrow(/not a value/);
    expect(() => validateAnalysisTrialValues({ accountDollars: "500000" })).toThrow(/must be a number above/);
    expect(() => validateAnalysisTrialValues({ accountDollars: 0 })).toThrow(/must be a number above/);
    expect(() => validateAnalysisTrialValues([])).toThrow(/must be an object/);
  });

  it("takes some of the ticker's five values (Analyse Only), each in the lab's range", () => {
    expect(validateAnalysisTrialValues({ accountDollars: 200_000, volFarmerV4: { callMinAbsDelta: 0.1, firstPositionPct: 60 } })).toEqual({ accountDollars: 200_000, volFarmerV4: { callMinAbsDelta: 0.1, firstPositionPct: 60 } });
    expect(() => validateAnalysisTrialValues({ accountDollars: 200_000, volFarmerV4: { firstPositionPct: 95 } })).toThrow(/firstPositionPct must be a number from 10 to 90/);
    expect(() => validateAnalysisTrialValues({ accountDollars: 200_000, volFarmerV4: { putMaxAbsDelta: null } })).toThrow(/putMaxAbsDelta must be a number/);
    expect(() => validateAnalysisTrialValues({ accountDollars: 200_000, volFarmerV4: { rebalanceBandPct: 5 } })).toThrow(/not a value a ticker can have/);
  });
});

describe("hashAnalysisLabValues", () => {
  const pluto = { windowStartEt: "10:00", windowEndEt: "15:30", capitalBudgetPct: 50 };
  const trading = { spreadCostChargedPct: 0, maxOrderPctOfPortfolio: 10 };
  const base = { defaultPotDollars: 100_000, trial: null };

  it("does not depend on key order", () => {
    const settings = { kellyFraction: 0.5, pluto, trading, volFarmerV4: { firstPositionPct: 80, callMaxAbsDelta: 0.5 } } as unknown as BacktestSettings;
    const reordered = { volFarmerV4: { callMaxAbsDelta: 0.5, firstPositionPct: 80 }, trading, pluto, kellyFraction: 0.5 } as unknown as BacktestSettings;
    expect(hashAnalysisLabValues({ ...base, settings })).toBe(hashAnalysisLabValues({ ...base, settings: reordered }));
    expect(hashAnalysisLabValues({ ...base, settings })).not.toBe(hashAnalysisLabValues({ ...base, defaultPotDollars: 200_000, settings }));
    expect(hashAnalysisLabValues({ ...base, settings })).not.toBe(hashAnalysisLabValues({ ...base, trial: { accountDollars: 500_000 }, settings }));
  });

  it("covers only what an analysis reads: v4's section, the fills' spread share and Pluto's window", () => {
    const settings = { kellyFraction: 0.5, decisionMaker: "vol_farmer_v4", pluto, trading, baseline: { ladderRungs: 5 }, volFarmerV4: { firstPositionPct: 80 } } as unknown as BacktestSettings;
    const hash = hashAnalysisLabValues({ ...base, settings });
    const elsewhere = { ...settings, kellyFraction: 0.25, decisionMaker: "baseline", baseline: { ladderRungs: 4 }, pluto: { ...pluto, capitalBudgetPct: 80 }, trading: { ...trading, maxOrderPctOfPortfolio: 20 } } as unknown as BacktestSettings;
    expect(hashAnalysisLabValues({ ...base, settings: elsewhere })).toBe(hash);
    expect(hashAnalysisLabValues({ ...base, settings: { ...settings, trading: { ...trading, spreadCostChargedPct: 50 } } as unknown as BacktestSettings })).not.toBe(hash);
    expect(hashAnalysisLabValues({ ...base, settings: { ...settings, volFarmerV4: { firstPositionPct: 70 } } as unknown as BacktestSettings })).not.toBe(hash);
  });

  it("reads v4's section in the code's shape: a value saved at its default hashes as one not saved", () => {
    const saved = { pluto, trading, volFarmerV4: { firstPositionPct: 80 } } as unknown as BacktestSettings;
    const unsaved = { pluto, trading } as unknown as BacktestSettings;
    expect(hashAnalysisLabValues({ ...base, settings: saved })).toBe(hashAnalysisLabValues({ ...base, settings: unsaved }));
  });
});

describe("an analysis's values with the ticker's own on top", () => {
  const pluto = { windowStartEt: "10:00", windowEndEt: "15:30" };
  const trading = { spreadCostChargedPct: 0 };
  const lab = (volFarmerV4: Record<string, number>) => ({ settings: { pluto, trading, volFarmerV4: { ...defaultBacktestVolFarmerV4Settings, ...volFarmerV4 } } as unknown as BacktestSettings, defaultPotDollars: 200_000 });

  it("runs the lab's v4 with the ticker's own values, then a trial's, on top", () => {
    const values = analysisLabValuesOf(lab({}), { ...noTickerOwnValues, callMinAbsDelta: 0.1, firstPositionPct: 60 }, { accountDollars: 200_000, volFarmerV4: { putMaxAbsDelta: 0.2, firstPositionPct: 70 } });
    expect(values.effective.v4).toMatchObject({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.5, firstPositionPct: 70, putMaxAbsDelta: 0.2, leapsMaxAccountPct: 10 });
    expect(values.effective.firstPositionShare).toBeCloseTo(0.7, 12);
  });

  it("a lab change to a value the ticker holds leaves its hash; one to another value, or a change of its own, does not", () => {
    const own = { ...noTickerOwnValues, callMinAbsDelta: 0.1 };
    const hash = analysisLabValuesOf(lab({}), own, null).hash;
    expect(analysisLabValuesOf(lab({ callMinAbsDelta: 0.08 }), own, null).hash).toBe(hash);
    expect(analysisLabValuesOf(lab({ callMaxAbsDelta: 0.45 }), own, null).hash).not.toBe(hash);
    expect(analysisLabValuesOf(lab({}), { ...own, callMinAbsDelta: 0.12 }, null).hash).not.toBe(hash);
    // Its own value equal to the lab's hashes as having none.
    expect(analysisLabValuesOf(lab({}), { ...noTickerOwnValues, callMinAbsDelta: 0.05 }, null).hash).toBe(analysisLabValuesOf(lab({}), null, null).hash);
  });

  it("an analysis stored before the ticker's own values hashes as one with none", () => {
    const { settings, defaultPotDollars } = lab({});
    expect(hashAnalysisLabValues({ settings, defaultPotDollars, trial: null })).toBe(analysisLabValuesOf(lab({}), null, null).hash);
  });
});

describe("barIndicatorsOf", () => {
  // Closes 1, 2, 3, … and IVs rising with them, so each bar's IV is its window's highest.
  const rising = Array.from({ length: 260 }, (_, index) => ({ close: index + 1, impliedVolatility: 0.3 + index / 100 }));

  it("IV Percentile: from the 20th bar with an IV, the last 252 bars' IVs at or below the bar's ÷ those with one", () => {
    const { ivPercentile } = barIndicatorsOf(rising);
    expect(ivPercentile.slice(0, 19)).toEqual(Array(19).fill(null));
    expect(ivPercentile[19]).toEqual([1, 20, 20]);
    // The window stops at 252 bars: the 260th bar reads bars 9 to 260.
    expect(ivPercentile[259]).toEqual([1, 252, 252]);
  });

  it("counts ties and the bar's own IV, and skips the bars without one", () => {
    const bars = [...Array.from({ length: 20 }, (_, index) => ({ close: 10, impliedVolatility: index < 10 ? 0.5 : 0.7 })), { close: 10, impliedVolatility: null }, { close: 10, impliedVolatility: 0.5 }];
    const { ivPercentile } = barIndicatorsOf(bars);
    expect(ivPercentile[20]).toBeNull();
    // 21 IVs in the window, the bar without one left out: the ten at 0.5 before it and its own are at or below it.
    expect(ivPercentile[21]).toEqual([0.5238, 11, 21]);
  });

  it("cuts the indicators of a whole file to a session's bars", () => {
    const all = barIndicatorsOf(rising);
    expect(sliceBarIndicators(all, 199, 201)).toEqual({ ivPercentile: all.ivPercentile.slice(199, 202) });
  });
});
