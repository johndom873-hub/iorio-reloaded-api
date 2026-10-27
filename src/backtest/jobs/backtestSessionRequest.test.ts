import { describe, expect, it } from "vitest";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import type { BacktestSettings } from "../backtestTypes.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { validateBacktestBookPageQuery, validateBacktestSettingsOverrides, validateCreateBacktestSessionRequest, type BacktestSessionRequestContext, type DataFilePeriodContents } from "./backtestSessionRequest.js";

const snapshot: BacktestSettings = {
  pluto: {
    capitalBudgetPct: 50,
    maxQuoteAgeMinutes: 5,
    windowStartEt: "10:00",
    windowEndEt: "15:30",
    dailyLossBreakerPct: 2,
    maxFillSlippagePct: 5,
  } as PlutoSettings,
  trading: {
    maxOrderPctOfPortfolio: 10,
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
  // A lab set to Vol Farmer v2: a session on the shared account, its starting value given.
  decisionMaker: "vol_farmer_v2",
};

const context: BacktestSessionRequestContext = {
  snapshot,
  editablePaths: editableBacktestSettingPaths,
  coverageFor: (symbol) =>
    symbol === "AAOI" ? { firstDate: "2020-01-02", lastDate: "2026-10-09" } : symbol === "HOOD" ? { firstDate: "2021-07-29", lastDate: "2026-10-09" } : symbol === "INTC" ? { firstDate: "2020-01-02", lastDate: "2026-06-30" } : symbol === "OLDF" ? { firstDate: "2016-01-04", lastDate: "2019-12-31" } : symbol === "EMPTY" ? { firstDate: null, lastDate: null } : null,
  periodContentsFor: () => wholePeriod,
  tickerValuesFor: () => null,
  defaultPotDollars: null,
};
/** A file that holds every weekday of the period, intraday quotes included. */
const wholePeriod: DataFilePeriodContents = { missingWeekdays: 0, firstMissingWeekday: null, lastMissingWeekday: null, completeDays: 100, completeDaysWithoutIntradayQuotes: 0 };

const validRequest = { name: " Edge Yield 20% ", symbol: "aaoi", startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} };

describe("validateCreateBacktestSessionRequest", () => {
  it("accepts a valid request, trimming the name and normalizing the symbol", () => {
    const result = validateCreateBacktestSessionRequest(validRequest, context);
    expect(result).toEqual({ ok: true, value: { name: "Edge Yield 20%", symbols: ["AAOI"], startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {}, bookMode: "shared_account", symbolSettings: null, symbolResolution: null, settingsSource: null, potsFromStartingValue: null }, warnings: [] });
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
    const result = validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 40 }, baseline: { ladderRungs: 3, entry: "put" } }, snapshot, editableBacktestSettingPaths);
    expect(result).toEqual({ ok: true, overrides: { trading: { spreadCostChargedPct: 40 }, baseline: { ladderRungs: 3 } } });
    expect(validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 50 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: {} });
  });

  it("refuses settings a session cannot change", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { maxQuoteAgeMinutes: 1 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.maxQuoteAgeMinutes cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ pluto: { modelId: "x" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.modelId cannot be changed for a session." });
    // The window is shown, not changed: the looks follow Pluto's own.
    expect(validateBacktestSettingsOverrides({ pluto: { windowStartEt: "11:00" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.windowStartEt cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ fixed: { forecastWindowDays: 30 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.fixed is not a setting a session can change." });
  });

  it("refuses the retired rules' settings: Pluto's, the trading settings but the spread cost share, the policy, the model and the Kelly fraction", () => {
    expect(validateBacktestSettingsOverrides({ pluto: { minEdgeYieldPct: 20 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.minEdgeYieldPct cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ pluto: { dailyLossBreakerPct: 3 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "pluto.dailyLossBreakerPct cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ trading: { deltaTargetMin: 0.2 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "trading.deltaTargetMin cannot be changed for a session." });
    expect(validateBacktestSettingsOverrides({ policy: { roll: "never" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.policy is not a setting a session can change." });
    expect(validateBacktestSettingsOverrides({ model: { forecastMethod: "implied_volatility_30_day" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.model is not a setting a session can change." });
    expect(validateBacktestSettingsOverrides({ kellyFraction: 0.5 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.kellyFraction is not a setting a session can change." });
  });

  it("applies the trading settings' own rules to the spread cost share", () => {
    expect(validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 120 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "spreadCostChargedPct must be between 0 and 100." });
  });

  it("refuses the retired rules and AI model as decision makers, and takes the others", () => {
    const retired = { ok: false, error: "The rules and llm backtests were retired with Signals; their past sessions stay readable." };
    expect(validateBacktestSettingsOverrides({ decisionMaker: "rules" }, snapshot, editableBacktestSettingPaths)).toEqual(retired);
    expect(validateBacktestSettingsOverrides({ decisionMaker: "llm" }, snapshot, editableBacktestSettingPaths)).toEqual(retired);
    expect(validateBacktestSettingsOverrides({ decisionMaker: "coin" }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "decisionMaker must be baseline, steady_stake, vol_farmer or vol_farmer_v2." });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "vol_farmer_v2" }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: {} });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "baseline", baseline: { entry: "covered_call", maxAbsDelta: 0.4 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { decisionMaker: "baseline", baseline: { entry: "covered_call", maxAbsDelta: 0.4 } } });
    expect(validateBacktestSettingsOverrides({ baseline: { minAbsDelta: 0.7 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "baseline.minAbsDelta must not be above baseline.maxAbsDelta." });
    expect(validateBacktestSettingsOverrides({ baseline: { strangle: true } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "baseline.strangle cannot be changed for a session." });
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "rules" } }, context)).toEqual(retired);
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "llm" } }, context)).toEqual(retired);
    // A lab still set to a retired decision maker (or a snapshot from before the choice, a rules one) starts nothing unless the request names another.
    for (const retiredSnapshot of [{ ...snapshot, decisionMaker: "rules" as const }, { ...snapshot, decisionMaker: undefined }]) {
      expect(validateCreateBacktestSessionRequest(validRequest, { ...context, snapshot: retiredSnapshot })).toEqual(retired);
      expect(validateCreateBacktestSessionRequest({ ...validRequest, overrides: { decisionMaker: "steady_stake" } }, { ...context, snapshot: retiredSnapshot })).toMatchObject({ ok: true, value: { overrides: { decisionMaker: "steady_stake" } } });
    }
  });

  it("takes the Steady Stake as decision maker with its own values, each checked, on a starting value", () => {
    expect(validateBacktestSettingsOverrides({ decisionMaker: "steady_stake", steadyStake: { stakePct: 70, putCashPct: 0, callAbsDelta: 0.2 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { decisionMaker: "steady_stake", steadyStake: { stakePct: 70, putCashPct: 0 } } });
    expect(validateBacktestSettingsOverrides({ steadyStake: { stakePct: 0 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "steadyStake.stakePct must be a number from 1 to 100." });
    expect(validateBacktestSettingsOverrides({ steadyStake: { ladderRungs: 3 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "steadyStake.ladderRungs is not a Steady Stake setting." });
    expect(validateBacktestSettingsOverrides({ steadyStake: 70 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.steadyStake must be an object." });
    // The Vol Farmer: only the values that differ from the defaults are kept; ranges in order, Calls up to the 45 days the engine reads.
    expect(validateBacktestSettingsOverrides({ decisionMaker: "vol_farmer", volFarmer: { putMinDte: 30, putMaxDte: 360, protectionFallPct: 20 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { decisionMaker: "vol_farmer", volFarmer: { putMinDte: 30 } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putMinDte: 400 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.putMinDte must not be above volFarmer.putMaxDte." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { callMaxDte: 60 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.callMaxDte must be a whole number from 0 to 45 (the Calls the engine reads)." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putMaxStrikeAbovePricePct: 12 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.putMaxStrikeAbovePricePct must be a number from −20 to 10." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { stakePct: 70 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.stakePct is not a Vol Farmer setting." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putCashReservePct: 60 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.putCashReservePct must be a number from 0 to 50." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { crossing: "hold_to_expiry", putExpiry: "with_the_call", hedgeRuleCallPremiums: "included", minPutProtectionPct: 20, hedgeWithoutCall: "put" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { volFarmer: { crossing: "hold_to_expiry", putExpiry: "with_the_call", hedgeRuleCallPremiums: "included", minPutProtectionPct: 20, hedgeWithoutCall: "put" } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { crossing: "roll" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.crossing must be one of unwind, hold_to_expiry, unwind_if_net_positive." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { callExpiry: "next", crossing: "unwind_if_net_positive", hedgeAfterExpiry: "sell_if_in_profit", afterAssignment: "continue_if_under_water", hedgeRuleStockPnl: "included" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { volFarmer: { callExpiry: "next", crossing: "unwind_if_net_positive", hedgeAfterExpiry: "sell_if_in_profit", afterAssignment: "continue_if_under_water", hedgeRuleStockPnl: "included" } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { afterAssignment: "rebuy" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.afterAssignment must be one of end, continue_if_under_water." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putChoice: "cheapest_per_year", hedgeWithoutCall: "cheapest_per_year" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { volFarmer: { putChoice: "cheapest_per_year", hedgeWithoutCall: "cheapest_per_year" } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putChoice: "cheapest" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.putChoice must be one of most_protection, cheapest_per_year." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { minPutProtectionPct: 120 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.minPutProtectionPct must be a number from 0 to 100." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { maxPutCostPctOfCallPremium: 600 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.maxPutCostPctOfCallPremium must be a number from 0 to 500." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putCashIn: "when_no_call", cashInPutMinProtectionPct: 30 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { volFarmer: { putCashIn: "when_no_call", cashInPutMinProtectionPct: 30 } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { putCashIn: "always" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.putCashIn must be one of none, when_no_call." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { hedge: "none" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { volFarmer: { hedge: "none" } } });
    expect(validateBacktestSettingsOverrides({ volFarmer: { hedge: "call" } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.hedge must be one of put, none." });
    expect(validateBacktestSettingsOverrides({ volFarmer: { cashInPutMinProtectionPct: -5 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmer.cashInPutMinProtectionPct must be a number from 0 to 100." });
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "steady_stake" } }, context)).toMatchObject({ ok: true, value: { bookMode: "shared_account", overrides: { decisionMaker: "steady_stake" } } });
  });
});

describe("per-ticker pots (the baseline)", () => {
  const ladderOverrides = { decisionMaker: "baseline", baseline: { entry: "covered_call", putsWhenNoCall: "reserve_ladder" } };
  const potsRequest = { name: "Pots", symbols: ["hood", "aaoi"], startDate: "2021-08-02", endDate: "2026-09-30", tablesMode: "walk_forward", overrides: ladderOverrides };
  const lab: BacktestSessionRequestContext = { ...context, tickerValuesFor: (symbol) => (symbol === "HOOD" ? { potDollars: 300_000, baseline: { ladderSharesPct: 30 } } : null), defaultPotDollars: 100_000 };
  const resolved = (body: Record<string, unknown>, requestContext: BacktestSessionRequestContext = lab) => {
    const result = validateCreateBacktestSessionRequest(body, requestContext);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it("splits a starting value equally: w = 1 ÷ tickers, every value the lab's global one", () => {
    const value = resolved({ ...potsRequest, startingValue: 200_000 }, { ...lab, tickerValuesFor: () => null });
    expect(value).toMatchObject({ startingValue: 200_000, bookMode: "pots" });
    expect(value.symbolSettings!.HOOD).toMatchObject({ potDollars: 100_000, weight: 0.5, baseline: { ladderSharesPct: 50, ladderRungs: 5, minAbsDelta: 0.05 } });
    expect(value.symbolSettings!.HOOD!.source).toMatchObject({ potDollars: "session", ladderSharesPct: "global", minAbsDelta: "global" });
    expect(Object.keys(value.symbolSettings!)).toEqual(["HOOD", "AAOI"]);
  });

  it("takes a ticker's lab pot and values, else the lab's default pot; capital = Σ pots, w = pot ÷ Σ pots", () => {
    const value = resolved(potsRequest);
    expect(value.startingValue).toBe(400_000);
    expect(value.symbolSettings!.HOOD).toMatchObject({ potDollars: 300_000, weight: 0.75, baseline: { ladderSharesPct: 30 }, source: { potDollars: "ticker", ladderSharesPct: "ticker" } });
    expect(value.symbolSettings!.AAOI).toMatchObject({ potDollars: 100_000, weight: 0.25, baseline: { ladderSharesPct: 50 }, source: { potDollars: "global", ladderSharesPct: "global" } });
  });

  it("lets the session-wide overrides beat the ticker's lab values, and the request's ticker values beat both", () => {
    const sessionWide = { ...ladderOverrides, baseline: { ...ladderOverrides.baseline, ladderSharesPct: 70 } };
    const value = resolved({ ...potsRequest, overrides: sessionWide, symbolSettings: { aaoi: { potDollars: 50_000, baseline: { ladderSharesPct: 40, ladderRungs: 8 } } } });
    expect(value.symbolSettings!.HOOD).toMatchObject({ baseline: { ladderSharesPct: 70 }, source: { ladderSharesPct: "session", potDollars: "ticker" } });
    expect(value.symbolSettings!.AAOI).toMatchObject({ potDollars: 50_000, baseline: { ladderSharesPct: 40, ladderRungs: 8 }, source: { potDollars: "request", ladderSharesPct: "request", ladderRungs: "request" } });
    expect(value.startingValue).toBe(350_000);
  });

  it("ignores the tickers' lab values with settingsSource global", () => {
    const value = resolved({ ...potsRequest, settingsSource: "global" });
    expect(value.symbolSettings!.HOOD).toMatchObject({ potDollars: 100_000, weight: 0.5, baseline: { ladderSharesPct: 50 }, source: { potDollars: "global", ladderSharesPct: "global" } });
  });

  it("gives one ticker its whole starting value: weight 1, as when the tickers share one account", () => {
    const value = resolved({ ...potsRequest, symbols: ["HOOD"], startingValue: 250_000 });
    expect(value.symbolSettings!.HOOD).toMatchObject({ potDollars: 250_000, weight: 1 });
  });

  it.each([
    [{ startingValue: 200_000, symbolSettings: { HOOD: { potDollars: 10_000 } } }, lab, "Give either a starting value (split equally) or each ticker's pot, not both (HOOD has a pot)."],
    [{}, { ...lab, defaultPotDollars: null }, "AAOI has no pot: give the session a starting value or the ticker a pot."],
    [{ symbolSettings: { HOOD: { baseline: { maxDte: 10 } } } }, lab, "baseline.maxDte cannot differ between tickers: change it for the whole session."],
    [{ symbolSettings: { INTC: { potDollars: 10_000 } } }, lab, "symbolSettings.INTC: INTC is not one of the session's symbols."],
    [{ symbolSettings: { HOOD: { potDollars: -5 } } }, lab, "symbolSettings.HOOD.potDollars must be a number above 0."],
    [{ symbolSettings: { HOOD: { pot: 5 } } }, lab, "symbolSettings.HOOD.pot is not a ticker value (potDollars or baseline)."],
    [{ symbolSettings: { AAOI: { baseline: { ladderRungs: 0 } } } }, lab, "AAOI: baseline.ladderRungs must be a whole number from 1 to 20."],
    [{ symbolSettings: { AAOI: { baseline: { minAbsDelta: 0.4, maxAbsDelta: 0.3 } } } }, lab, "AAOI: baseline.minAbsDelta must not be above baseline.maxAbsDelta."],
    [{ settingsSource: "mine" }, lab, "settingsSource must be per_ticker or global."],
  ])("refuses %j", (change, requestContext, error) => {
    expect(validateCreateBacktestSessionRequest({ ...potsRequest, ...change }, requestContext)).toMatchObject({ ok: false, error });
  });

  it("records how the session was asked for, for Run again", () => {
    expect(resolved({ ...potsRequest, startingValue: 200_000 })).toMatchObject({ settingsSource: "per_ticker", potsFromStartingValue: true });
    expect(resolved({ ...potsRequest, settingsSource: "global" })).toMatchObject({ settingsSource: "global", potsFromStartingValue: false });
  });

  it("gives each value not from the lab's global values the value a reset returns to", () => {
    const value = resolved({ ...potsRequest, symbolSettings: { HOOD: { potDollars: 50_000, baseline: { ladderSharesPct: 40 } } } });
    // HOOD: share level 40 (this session) over its lab 30; pot $50,000 over its lab $300,000. AAOI keeps the global values: nothing to reset.
    expect(value.symbolResolution!.HOOD!.fallback).toEqual({ ladderSharesPct: { value: 30, source: "ticker" }, potDollars: { value: 300_000, source: "ticker" } });
    expect(value.symbolResolution!.AAOI!.fallback).toEqual({});
    expect(value.symbolResolution!.AAOI!.problems).toEqual([]);
  });

  it("resolves every ticker even when some cannot run, each with its own problems, the create refused on the first", () => {
    const result = validateCreateBacktestSessionRequest({ ...potsRequest, symbolSettings: { HOOD: { baseline: { ladderRungs: 0 } } } }, { ...lab, defaultPotDollars: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("HOOD: baseline.ladderRungs must be a whole number from 1 to 20.");
    const { capital, bySymbol } = result.symbolResolution!;
    // AAOI has no pot (no lab pot, no default): capital and weights are unknown.
    expect(capital).toBeNull();
    expect(bySymbol.HOOD).toMatchObject({ potDollars: 300_000, weight: null, problems: [{ key: "ladderRungs", message: "baseline.ladderRungs must be a whole number from 1 to 20." }] });
    expect(bySymbol.AAOI).toMatchObject({ potDollars: null, weight: null, problems: [{ key: "potDollars", message: "AAOI has no pot: give the session a starting value or the ticker a pot." }] });
  });

  it("keeps the rules and the AI model on one shared account with a starting value", () => {
    const rules = { ...validRequest, symbols: ["HOOD", "AAOI"], symbol: undefined, startDate: "2021-08-02" };
    expect(validateCreateBacktestSessionRequest(rules, lab)).toMatchObject({ ok: true, value: { startingValue: 1_000_000, bookMode: "shared_account", symbolSettings: null } });
    expect(validateCreateBacktestSessionRequest({ ...rules, startingValue: undefined }, lab)).toEqual({ ok: false, error: "The starting account value must be a number above 0." });
    expect(validateCreateBacktestSessionRequest({ ...rules, symbolSettings: { HOOD: { potDollars: 1 } } }, lab)).toEqual({ ok: false, error: "symbolSettings apply to the baseline only." });
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
