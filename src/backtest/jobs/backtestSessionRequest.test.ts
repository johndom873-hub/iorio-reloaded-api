import { describe, expect, it } from "vitest";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import type { BacktestSettings } from "../backtestTypes.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { validateBacktestSettingsOverrides, validateCreateBacktestSessionRequest, type BacktestSessionRequestContext } from "./backtestSessionRequest.js";

const snapshot: BacktestSettings = {
  pluto: {
    capitalBudgetPct: 50,
    maxTickerExposurePct: 8,
    maxSectorExposurePct: 20,
    maxOpenPositions: 10,
    maxActionsPerSession: 10,
    orderSizePctOfBudget: 10,
    minCashReservePct: 5,
    minGrade: "good",
    minEdgeYieldPct: 15,
    maxAbsDelta: 0.3,
    minDte: 1,
    maxDte: 45,
    minAnnualizedYieldPct: 20,
    maxSpreadPct: 15,
    minOpenInterest: 100,
    minSessionVolume: 10,
    maxQuoteAgeMinutes: 5,
    maxContractsVolumeSharePct: 10,
    maxSliceRmseVp: 2,
    minSlicePointCount: 5,
    maxMidVsSurfaceIvVp: 5,
    maxIvShiftVp: 5,
    maxDayMoveMultiple: 3,
    stressRiskBudgetPct: 1,
    stressSigmas: 2,
    windowStartEt: "10:00",
    windowEndEt: "15:30",
    dailyLossBreakerPct: 2,
    spyStressBreakerPct: 3,
    maxEdgeMarginDriftPts: 5,
    tickerCooldownMinutes: 30,
    maxFillSlippagePct: 5,
  } as PlutoSettings,
  trading: {
    maxPositionPctOfPortfolio: 10,
    maxConcentrationPerTickerPct: 20,
    minCashReservePct: 5,
    deltaTargetMin: 0.15,
    deltaTargetMax: 0.3,
    recoveryDteMin: 7,
    recoveryDteMax: 45,
    minAnnualizedYieldPct: 20,
    commissionWarnSharePctOfPremium: 5,
    priceCheckMaxDeviationPct: 10,
    priceCheckMinToleranceDollars: 0.05,
    spreadCostChargedPct: 50,
    orderUnfilledCancelMinutes: 30,
  },
  kellyFraction: 0.25,
};

const context: BacktestSessionRequestContext = {
  snapshot,
  editablePaths: editableBacktestSettingPaths,
  coverageFor: (symbol) => (symbol === "AAOI" ? { firstDate: "2020-01-02", lastDate: "2026-10-09" } : symbol === "EMPTY" ? { firstDate: null, lastDate: null } : null),
};

const validRequest = { name: " Edge Yield 20% ", symbol: "aaoi", startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} };

describe("validateCreateBacktestSessionRequest", () => {
  it("accepts a valid request, trimming the name and normalizing the symbol", () => {
    const result = validateCreateBacktestSessionRequest(validRequest, context);
    expect(result).toEqual({ ok: true, value: { name: "Edge Yield 20%", symbol: "AAOI", startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} } });
  });

  it.each([
    [{ name: "  " }, "Give the session a name."],
    [{ symbol: "MSFT" }, "There is no data file for MSFT: download it first."],
    [{ symbol: "EMPTY" }, "The EMPTY data file has no complete days yet."],
    [{ symbol: "1BAD" }, 'Not a valid symbol: "1BAD"'],
    [{ startDate: "2021-13-01" }, "startDate must be a date (YYYY-MM-DD)."],
    [{ startDate: "2026-09-30" }, "The start date must be before the end date."],
    [{ startDate: "2019-12-31" }, "The AAOI data file covers 2020-01-02 to 2026-10-09: the dates must be inside it."],
    [{ endDate: "2026-10-12" }, "The AAOI data file covers 2020-01-02 to 2026-10-09: the dates must be inside it."],
    [{ startingValue: 0 }, "The starting account value must be a number above 0."],
    [{ startingValue: "1000000" }, "The starting account value must be a number above 0."],
    [{ tablesMode: "latest" }, "tablesMode must be one of walk_forward, current."],
  ])("refuses %j", (change, error) => {
    expect(validateCreateBacktestSessionRequest({ ...validRequest, ...change }, context)).toEqual({ ok: false, error });
  });
});

describe("validateBacktestSettingsOverrides", () => {
  it("keeps only the values that differ from the snapshot", () => {
    const result = validateBacktestSettingsOverrides({ pluto: { minEdgeYieldPct: 20, maxAbsDelta: 0.3 }, trading: { spreadCostChargedPct: 50 }, kellyFraction: 0.5 }, snapshot, editableBacktestSettingPaths);
    expect(result).toEqual({ ok: true, overrides: { pluto: { minEdgeYieldPct: 20 }, kellyFraction: 0.5 } });
  });

  it("refuses settings a session cannot change", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxActionsPerSession: 1 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.maxActionsPerSession cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ pluto: { modelId: "x" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.modelId cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ pluto: { maxIvShiftVp: 3 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.maxIvShiftVp cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ fixed: { forecastWindowDays: 30 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.fixed is not a setting a session can change." });
  });

  it("applies Pluto's and the trading settings' own rules, cross-field ones included", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxAbsDelta: 1.5 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "maxAbsDelta cannot be above 1." });
    expect(validateBacktestSettingsOverrides({ pluto: { minDte: 50 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "minDte cannot exceed maxDte." });
    expect(validateBacktestSettingsOverrides({ pluto: { minGrade: "best" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "minGrade must be one of strong, good, weak." });
    expect(validateBacktestSettingsOverrides({ trading: { deltaTargetMin: 0.4 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "deltaTargetMin cannot exceed deltaTargetMax." });
    expect(validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 120 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "spreadCostChargedPct must be between 0 and 100." });
    expect(validateBacktestSettingsOverrides({ trading: { maxPositionPctOfPortfolio: 101 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "maxPositionPctOfPortfolio must be between 0 and 100." });
    expect(validateBacktestSettingsOverrides({ trading: { maxConcentrationPerTickerPct: 30, minCashReservePct: 5 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { trading: { maxConcentrationPerTickerPct: 30 } } });
  });

  it("keeps the Kelly fraction above 0 and at most 1", () => {
    expect(validateBacktestSettingsOverrides({ kellyFraction: 0 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "kellyFraction must be a number above 0 and at most 1." });
    expect(validateBacktestSettingsOverrides({ kellyFraction: 1.2 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "kellyFraction must be a number above 0 and at most 1." });
  });
});
