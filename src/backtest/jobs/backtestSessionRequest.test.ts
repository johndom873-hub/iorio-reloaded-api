import { describe, expect, it } from "vitest";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import type { BacktestSettings } from "../backtestTypes.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { validateBacktestBookPageQuery, validateBacktestSettingsOverrides, validateCreateBacktestSessionRequest, type BacktestSessionRequestContext, type DataFilePeriodContents } from "./backtestSessionRequest.js";

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
  coverageFor: (symbol) =>
    symbol === "AAOI" ? { firstDate: "2020-01-02", lastDate: "2026-10-09" } : symbol === "HOOD" ? { firstDate: "2021-07-29", lastDate: "2026-10-09" } : symbol === "INTC" ? { firstDate: "2020-01-02", lastDate: "2026-06-30" } : symbol === "OLDF" ? { firstDate: "2016-01-04", lastDate: "2019-12-31" } : symbol === "EMPTY" ? { firstDate: null, lastDate: null } : null,
  periodContentsFor: () => wholePeriod,
  claudeCliAvailable: true,
};
/** BACKTEST_CLAUDE_CLI_PATH is set. */
const withClaudeCli = { claudeCliAvailable: true };
/** A file that holds every weekday of the period, intraday quotes included. */
const wholePeriod: DataFilePeriodContents = { missingWeekdays: 0, firstMissingWeekday: null, lastMissingWeekday: null, completeDays: 100, completeDaysWithoutIntradayQuotes: 0 };

const validRequest = { name: " Edge Yield 20% ", symbol: "aaoi", startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} };

describe("validateCreateBacktestSessionRequest", () => {
  it("accepts a valid request, trimming the name and normalizing the symbol", () => {
    const result = validateCreateBacktestSessionRequest(validRequest, context);
    expect(result).toEqual({ ok: true, value: { name: "Edge Yield 20%", symbols: ["AAOI"], startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} }, warnings: [] });
  });

  it("refuses a period in which a symbol's file has weekdays with nothing stored, naming the symbol and how many", () => {
    const { symbol: _oneSymbol, ...withoutSymbol } = validRequest;
    const asked: string[] = [];
    const partlyDownloaded: BacktestSessionRequestContext = {
      ...context,
      periodContentsFor: (symbol, startDate, endDate) => {
        asked.push(`${symbol} ${startDate} ${endDate}`);
        return symbol === "INTC" ? { ...wholePeriod, missingWeekdays: 828, firstMissingWeekday: "2021-09-13", lastMissingWeekday: "2024-11-13" } : wholePeriod;
      },
    };
    const several = (change: Record<string, unknown> = {}) => validateCreateBacktestSessionRequest({ ...withoutSymbol, symbols: ["AAOI", "INTC"], startDate: "2021-01-04", endDate: "2026-06-30", ...change }, partlyDownloaded);
    expect(several()).toEqual({ ok: false, error: "INTC's file has 828 weekdays missing between 2021-09-13 and 2024-11-13: finish its download or shorten the period." });
    // Each file is asked about the session's own period.
    expect(asked).toEqual(["AAOI 2021-01-04 2026-06-30", "INTC 2021-01-04 2026-06-30"]);
    expect(several({ symbols: ["AAOI"] })).toMatchObject({ ok: true });
    const oneDay: BacktestSessionRequestContext = { ...context, periodContentsFor: () => ({ ...wholePeriod, missingWeekdays: 1, firstMissingWeekday: "2024-03-28", lastMissingWeekday: "2024-03-28" }) };
    expect(validateCreateBacktestSessionRequest(validRequest, oneDay)).toEqual({ ok: false, error: "AAOI's file has 1 weekday missing on 2024-03-28: finish its download or shorten the period." });
  });

  it("warns, without refusing, about the days a symbol's file has no intraday quotes for", () => {
    const { symbol: _oneSymbol, ...withoutSymbol } = validRequest;
    const withoutIntraday: BacktestSessionRequestContext = { ...context, periodContentsFor: (symbol) => (symbol === "AAOI" ? { ...wholePeriod, completeDays: 1618, completeDaysWithoutIntradayQuotes: 1618 } : symbol === "INTC" ? { ...wholePeriod, completeDays: 1302, completeDaysWithoutIntradayQuotes: 3 } : wholePeriod) };
    const result = validateCreateBacktestSessionRequest({ ...withoutSymbol, symbols: ["AAOI", "HOOD", "INTC"], startDate: "2021-08-02", endDate: "2026-06-30" }, withoutIntraday);
    expect(result).toMatchObject({
      ok: true,
      warnings: ["AAOI: 1,618 of its 1,618 days in the period have no intraday quotes: on those days it gets one look, at 10:00.", "INTC: 3 of its 1,302 days in the period have no intraday quotes: on those days it gets one look, at 10:00."],
    });
  });

  it("takes a list of symbols for one book: normalized, in the order given, each once", () => {
    const { symbol: _oneSymbol, ...withoutSymbol } = validRequest;
    const result = validateCreateBacktestSessionRequest({ ...withoutSymbol, symbols: ["hood", "AAOI", " Hood "], startDate: "2021-08-02", endDate: "2026-06-30" }, context);
    expect(result).toMatchObject({ ok: true, value: { symbols: ["HOOD", "AAOI"] } });
    // The list wins over the single symbol of an older request.
    expect(validateCreateBacktestSessionRequest({ ...validRequest, symbols: ["INTC"], endDate: "2026-06-30" }, context)).toMatchObject({ ok: true, value: { symbols: ["INTC"] } });
  });

  it("keeps a session of several symbols inside the period all their files cover, naming the file that limits it", () => {
    const { symbol: _oneSymbol, ...withoutSymbol } = validRequest;
    const several = (change: Record<string, unknown>) => validateCreateBacktestSessionRequest({ ...withoutSymbol, symbols: ["AAOI", "HOOD", "INTC"], startDate: "2021-08-02", endDate: "2026-06-30", ...change }, context);
    expect(several({})).toMatchObject({ ok: true });
    expect(several({ startDate: "2021-01-04" })).toEqual({ ok: false, error: "The data files together cover 2021-07-29 to 2026-06-30 (HOOD starts 2021-07-29): the dates must be inside that." });
    expect(several({ endDate: "2026-09-30" })).toEqual({ ok: false, error: "The data files together cover 2021-07-29 to 2026-06-30 (INTC ends 2026-06-30): the dates must be inside that." });
    expect(several({ startDate: "2021-01-04", endDate: "2026-09-30" })).toEqual({ ok: false, error: "The data files together cover 2021-07-29 to 2026-06-30 (HOOD starts 2021-07-29, INTC ends 2026-06-30): the dates must be inside that." });
    expect(several({ symbols: ["AAOI", "MSFT"] })).toEqual({ ok: false, error: "There is no data file for MSFT: download it first." });
    expect(several({ symbols: ["HOOD", "OLDF"] })).toEqual({ ok: false, error: "The data files do not overlap: HOOD starts 2021-07-29, after OLDF ends 2019-12-31." });
    expect(several({ symbols: [] })).toEqual({ ok: false, error: "Give the session at least one symbol." });
    expect(several({ symbols: "AAOI" })).toEqual({ ok: false, error: "Give the session at least one symbol." });
    expect(several({ symbols: Array.from({ length: 31 }, (_, index) => `S${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + Math.floor(index / 26))}`) })).toEqual({ ok: false, error: "A session takes at most 30 symbols." });
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
    const result = validateBacktestSettingsOverrides({ pluto: { minEdgeYieldPct: 20, maxAbsDelta: 0.3 }, trading: { spreadCostChargedPct: 50 }, kellyFraction: 0.5 }, snapshot, editableBacktestSettingPaths, withClaudeCli);
    expect(result).toEqual({ ok: true, overrides: { pluto: { minEdgeYieldPct: 20 }, kellyFraction: 0.5 } });
  });

  it("lets a session change the sector cap, which binds once several symbols share the book", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxSectorExposurePct: 25 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { pluto: { maxSectorExposurePct: 25 } } });
    expect(validateBacktestSettingsOverrides({ pluto: { maxSectorExposurePct: 101 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toMatchObject({ ok: false });
  });

  it("refuses settings a session cannot change", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxQuoteAgeMinutes: 1 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "pluto.maxQuoteAgeMinutes cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ pluto: { modelId: "x" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "pluto.modelId cannot be changed for a session." });
    // The window is shown, not changed: the looks follow Pluto's own.
    expect(validateBacktestSettingsOverrides({ pluto: { windowStartEt: "11:00" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "pluto.windowStartEt cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ fixed: { forecastWindowDays: 30 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "overrides.fixed is not a setting a session can change." });
  });

  it("lets a session change what the looks inside the window brought into play: the system checks and the intraday IV-shift limit", () => {
    const changes = { maxIvShiftVp: 3, maxActionsPerSession: 4, tickerCooldownMinutes: 90, dailyLossBreakerPct: 3, spyStressBreakerPct: 2 };
    expect(validateBacktestSettingsOverrides({ pluto: changes }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { pluto: changes } });
    expect(validateBacktestSettingsOverrides({ pluto: { dailyLossBreakerPct: 101 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "dailyLossBreakerPct cannot be above 100." });
    expect(validateBacktestSettingsOverrides({ pluto: { tickerCooldownMinutes: 7.5 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "tickerCooldownMinutes must be a whole number." });
  });

  it("applies Pluto's and the trading settings' own rules, cross-field ones included", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxAbsDelta: 1.5 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "maxAbsDelta cannot be above 1." });
    expect(validateBacktestSettingsOverrides({ pluto: { minDte: 50 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "minDte cannot exceed maxDte." });
    expect(validateBacktestSettingsOverrides({ pluto: { minGrade: "best" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "minGrade must be one of strong, good, weak." });
    expect(validateBacktestSettingsOverrides({ trading: { deltaTargetMin: 0.4 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "deltaTargetMin cannot exceed deltaTargetMax." });
    expect(validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 120 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "spreadCostChargedPct must be between 0 and 100." });
    expect(validateBacktestSettingsOverrides({ trading: { maxPositionPctOfPortfolio: 101 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "maxPositionPctOfPortfolio must be between 0 and 100." });
    expect(validateBacktestSettingsOverrides({ trading: { maxConcentrationPerTickerPct: 30, minCashReservePct: 5 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { trading: { maxConcentrationPerTickerPct: 30 } } });
  });

  it("takes the decision rules as choices, keeping only those that differ from the defaults", () => {
    expect(validateBacktestSettingsOverrides({ policy: { roll: "never", buyback: "when_offered", sharesInProfit: "always_sell" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { policy: { roll: "never", sharesInProfit: "always_sell" } } });
    expect(validateBacktestSettingsOverrides({ policy: { roll: "flagged_legs" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: {} });
    // Against a snapshot that stored another rule, the default is a change.
    expect(validateBacktestSettingsOverrides({ policy: { roll: "flagged_legs" } }, { ...snapshot, policy: { roll: "never", buyback: "when_offered", sharesInProfit: "call_else_sell", eventClose: "stress_vs_remaining", afterBlockedChoice: "stop" } }, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { policy: { roll: "flagged_legs" } } });
    expect(validateBacktestSettingsOverrides({ policy: { roll: "sometimes" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "policy.roll must be one of flagged_legs, any_eligible, never." });
    expect(validateBacktestSettingsOverrides({ policy: { buyback: true } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "policy.buyback must be one of when_offered, never." });
    expect(validateBacktestSettingsOverrides({ policy: { eventClose: "never" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { policy: { eventClose: "never" } } });
    expect(validateBacktestSettingsOverrides({ policy: { eventClose: "sometimes" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "policy.eventClose must be one of stress_vs_remaining, never, always." });
    expect(validateBacktestSettingsOverrides({ policy: { openOrder: "x" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "policy.openOrder cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ policy: "never" }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "overrides.policy must be an object." });
    // Choosing again after a refusal is the default; stopping the look is the change.
    expect(validateBacktestSettingsOverrides({ policy: { afterBlockedChoice: "try_next" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: {} });
    expect(validateBacktestSettingsOverrides({ policy: { afterBlockedChoice: "stop" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { policy: { afterBlockedChoice: "stop" } } });
    expect(validateBacktestSettingsOverrides({ policy: { afterBlockedChoice: "retry" } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "policy.afterBlockedChoice must be one of try_next, stop." });
  });

  it("takes the AI model as decision maker only when the Claude Code CLI is configured; the rules stay the default", () => {
    expect(validateBacktestSettingsOverrides({ decisionMaker: "rules" }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: {} });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "llm" }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: true, overrides: { decisionMaker: "llm" } });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "llm" }, snapshot, editableBacktestSettingPaths, { claudeCliAvailable: false })).toEqual({
      ok: false,
      error: "The AI model as decision maker needs BACKTEST_CLAUDE_CLI_PATH in the API's .env (the Claude Code CLI to call): set it and restart the API.",
    });
    // Without the CLI the rules can still be chosen.
    expect(validateBacktestSettingsOverrides({ decisionMaker: "rules" }, snapshot, editableBacktestSettingPaths, { claudeCliAvailable: false })).toEqual({ ok: true, overrides: {} });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "coin" }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "decisionMaker must be rules, llm or baseline." });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "baseline", baseline: { entry: "buy_write", maxAbsDelta: 0.4 } }, snapshot, editableBacktestSettingPaths, { claudeCliAvailable: false })).toEqual({ ok: true, overrides: { decisionMaker: "baseline", baseline: { entry: "buy_write", maxAbsDelta: 0.4 } } });
    expect(validateBacktestSettingsOverrides({ baseline: { minAbsDelta: 0.7 } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "baseline.minAbsDelta must not be above baseline.maxAbsDelta." });
    expect(validateBacktestSettingsOverrides({ baseline: { strangle: true } }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "baseline.strangle cannot be changed for a session." });
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "llm" } }, { ...context, claudeCliAvailable: false })).toMatchObject({ ok: false, error: expect.stringContaining("BACKTEST_CLAUDE_CLI_PATH") });
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "llm" } }, context)).toMatchObject({ ok: true, value: { overrides: { decisionMaker: "llm" } } });
  });

  it("keeps the Kelly fraction above 0 and at most 1", () => {
    expect(validateBacktestSettingsOverrides({ kellyFraction: 0 }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "kellyFraction must be a number above 0 and at most 1." });
    expect(validateBacktestSettingsOverrides({ kellyFraction: 1.2 }, snapshot, editableBacktestSettingPaths, withClaudeCli)).toEqual({ ok: false, error: "kellyFraction must be a number above 0 and at most 1." });
  });
});

describe("validateBacktestBookPageQuery", () => {
  const actionsQuery = (raw: Record<string, unknown>) => validateBacktestBookPageQuery(raw, { outcomeAllowed: true });

  it("reads every action of the session, 200 a page, when nothing is asked", () => {
    expect(actionsQuery({})).toEqual({ ok: true, filters: { from: null, to: null, symbol: null, outcome: null, limit: 200, offset: 0 } });
    expect(actionsQuery({ from: "", symbol: " " })).toEqual({ ok: true, filters: { from: null, to: null, symbol: null, outcome: null, limit: 200, offset: 0 } });
  });

  it("takes trading dates, a symbol, an outcome and a page", () => {
    expect(actionsQuery({ from: "2024-01-02", to: "2024-03-28", symbol: "smci", outcome: "blocked", limit: "1000", offset: "400" })).toEqual({ ok: true, filters: { from: "2024-01-02", to: "2024-03-28", symbol: "SMCI", outcome: "blocked", limit: 1000, offset: 400 } });
  });

  it.each([
    [{ from: "2024-02-30" }, "from must be a date (YYYY-MM-DD)."],
    [{ to: "March" }, "to must be a date (YYYY-MM-DD)."],
    [{ from: "2024-03-01", to: "2024-02-01" }, "from must be on or before to."],
    [{ symbol: "1abc" }, 'Not a valid symbol: "1abc"'],
    [{ outcome: "open" }, "outcome must be filled or blocked."],
    [{ limit: "0" }, "limit must be a whole number from 1 to 1000."],
    [{ limit: "2.5" }, "limit must be a whole number from 1 to 1000."],
    [{ offset: "-3" }, "offset must be a whole number from 0."],
  ])("refuses %j", (raw, error) => {
    expect(actionsQuery(raw)).toEqual({ ok: false, error });
  });

  it("has no outcome filter for fills", () => {
    expect(validateBacktestBookPageQuery({ outcome: "filled" }, { outcomeAllowed: false })).toEqual({ ok: false, error: "outcome filters actions only." });
  });
});
