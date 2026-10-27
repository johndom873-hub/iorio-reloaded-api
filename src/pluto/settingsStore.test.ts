import { describe, expect, it } from "vitest";
import { plutoSettingsColumns, validatePlutoSettingsInput, type PlutoSettings } from "./settingsStore.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";

// The approved defaults (2026-09-28), as the store would read them back.
const current: PlutoSettings = {
  ...plutoLadderSettingsFixture,
  capitalBudgetPct: 30, maxTickerPctOfBudget: 10, maxSectorPctOfBudget: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeYieldPct: 15, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxDayMoveMultiple: 3, stressRiskBudgetPct: 0, stressSigmas: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeMarginDriftPts: 10, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
  modelId: "openai/gpt-6-luna", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 3, confidenceFloor: 0.6, consecutiveModelFailuresBreaker: 3, promptVersion: "v1",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 5, maxEnabledTickers: 15, messageRateLimitPerSecond: 8,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2,
  updatedAt: "2026-09-28T00:00:00.000Z", updatedByUserId: null,
};

describe("validatePlutoSettingsInput", () => {
  it("accepts an empty change and sane values", () => {
    expect(validatePlutoSettingsInput({}, current)).toBeNull();
    expect(validatePlutoSettingsInput({ capitalBudgetPct: 25, minGrade: "strong", windowEndEt: "15:00" }, current)).toBeNull();
  });
  it("rejects unknown fields, wrong kinds and out-of-range numbers", () => {
    expect(validatePlutoSettingsInput({ nope: 1 } as never, current)).toMatch(/not a Pluto setting/);
    expect(validatePlutoSettingsInput({ capitalBudgetPct: "30" as never }, current)).toMatch(/must be a number/);
    expect(validatePlutoSettingsInput({ maxOpenPositions: 2.5 }, current)).toMatch(/whole number/);
    expect(validatePlutoSettingsInput({ confidenceFloor: 1.2 }, current)).toMatch(/cannot be above 1/);
    expect(validatePlutoSettingsInput({ minEdgeYieldPct: -1 }, current)).toMatch(/cannot be below 0/);
  });
  it("rejects bad enums and malformed times", () => {
    expect(validatePlutoSettingsInput({ minGrade: "avoid" as never }, current)).toMatch(/one of strong, good, weak/);
    expect(validatePlutoSettingsInput({ reasoningEffort: "max" as never }, current)).toMatch(/one of low, medium, high/);
    expect(validatePlutoSettingsInput({ windowStartEt: "9:45" }, current)).toMatch(/HH:MM/);
  });
  it("checks cross-field rules against the merged result", () => {
    expect(validatePlutoSettingsInput({ minDte: 50 }, current)).toMatch(/minDte cannot exceed maxDte/);
    expect(validatePlutoSettingsInput({ windowStartEt: "15:30" }, current)).toMatch(/before windowEndEt/);
    expect(validatePlutoSettingsInput({ minDte: 50, maxDte: 60 }, current)).toBeNull();
  });
  it("checks the ladder's values with the backtest's bounds", () => {
    expect(validatePlutoSettingsInput({ ladderMinAbsDelta: 0 }, current)).toMatch(/above 0/);
    expect(validatePlutoSettingsInput({ ladderMinAbsDelta: 0.35 }, current)).toMatch(/cannot exceed ladderMaxAbsDelta/);
    expect(validatePlutoSettingsInput({ ladderMinDte: 0 }, current)).toBeNull();
    expect(validatePlutoSettingsInput({ ladderMaxDte: 46 }, current)).toMatch(/cannot be above 45/);
    expect(validatePlutoSettingsInput({ ladderMinDte: 10, ladderMaxDte: 5 }, current)).toMatch(/ladderMinDte cannot exceed/);
    expect(validatePlutoSettingsInput({ ladderMaxSpreadPctOfMid: 0 }, current)).toMatch(/above 0/);
    expect(validatePlutoSettingsInput({ ladderRungs: 2.5 }, current)).toMatch(/whole number/);
    expect(validatePlutoSettingsInput({ ladderSharesPct: 100 }, current)).toMatch(/cannot be above 99/);
    expect(validatePlutoSettingsInput({ ladderShockMinPct: 85 }, current)).toMatch(/ladderShockMinPct cannot exceed/);
    expect(validatePlutoSettingsInput({ ladderMaxWorkingOrdersPerTicker: 0 }, current)).toMatch(/cannot be below 1/);
  });

  it("every settings field has a column mapping", () => {
    const fields = Object.keys(current).filter((key) => key !== "updatedAt" && key !== "updatedByUserId");
    expect(Object.keys(plutoSettingsColumns).sort()).toEqual(fields.sort());
  });
});
