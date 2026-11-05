import { describe, expect, it } from "vitest";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import type { BacktestSettings } from "../backtestTypes.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { validateBacktestBookPageQuery, validateBacktestSettingsOverrides, validateCreateBacktestSessionRequest, type BacktestSessionRequestContext, type DataFilePeriodContents } from "./backtestSessionRequest.js";

const snapshot: BacktestSettings = {
  pluto: {
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
    commissionWarnSharePctOfPremium: 5,
    priceCheckMaxDeviationPct: 10,
    priceCheckMinToleranceDollars: 0.05,
    spreadCostChargedPct: 50,
    orderUnfilledCancelMinutes: 30,
  },
  kellyFraction: 0.25,
  // A lab set to Vol Farmer v4: a session on the shared account, its starting value given.
  decisionMaker: "vol_farmer_v4",
};

const context: BacktestSessionRequestContext = {
  snapshot,
  editablePaths: editableBacktestSettingPaths,
  coverageFor: (symbol) =>
    symbol === "AAOI" ? { firstDate: "2020-01-02", lastDate: "2026-10-09" } : symbol === "HOOD" ? { firstDate: "2021-07-29", lastDate: "2026-10-09" } : symbol === "INTC" ? { firstDate: "2020-01-02", lastDate: "2026-06-30" } : symbol === "OLDF" ? { firstDate: "2016-01-04", lastDate: "2019-12-31" } : symbol === "EMPTY" ? { firstDate: null, lastDate: null } : null,
  periodContentsFor: () => wholePeriod,
};
/** A file that holds every weekday of the period, intraday quotes included. */
const wholePeriod: DataFilePeriodContents = { missingWeekdays: 0, firstMissingWeekday: null, lastMissingWeekday: null, completeDays: 100, completeDaysWithoutIntradayQuotes: 0 };

const validRequest = { name: " Edge Yield 20% ", symbol: "aaoi", startDate: "2021-01-04", endDate: "2026-09-30", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} };

describe("Vol Farmer v4's allocations and excess allowance", () => {
  const { symbol: _oneSymbol, ...withoutSymbol } = validRequest;
  const request = (volFarmerV4: Record<string, unknown>) => validateCreateBacktestSessionRequest({ ...withoutSymbol, symbols: ["AAOI", "HOOD"], startDate: "2021-08-02", overrides: { volFarmerV4 } }, context);

  it("keeps each ticker's set allocation and the allowance as the session's", () => {
    expect(request({ tickerAllocationPct: { AAOI: 60 }, excessAllowancePct: 26.3158 })).toMatchObject({ ok: true, value: { overrides: { volFarmerV4: { tickerAllocationPct: { AAOI: 60 }, excessAllowancePct: 26.3158 } } } });
  });

  it("refuses an allowance out of range, an allocation of 0 or above 100, set ones above 100% together and a symbol not in the session", () => {
    expect(request({ excessAllowancePct: -1 })).toEqual({ ok: false, error: "volFarmerV4.excessAllowancePct must be a number from 0 to 1000." });
    expect(request({ excessAllowancePct: 1001 })).toEqual({ ok: false, error: "volFarmerV4.excessAllowancePct must be a number from 0 to 1000." });
    expect(request({ tickerAllocationPct: [] })).toEqual({ ok: false, error: "volFarmerV4.tickerAllocationPct must be an object of symbols." });
    expect(request({ tickerAllocationPct: { AAOI: 0 } })).toEqual({ ok: false, error: "volFarmerV4.tickerAllocationPct.AAOI must be a number above 0 and at most 100." });
    expect(request({ tickerAllocationPct: { AAOI: 101 } })).toEqual({ ok: false, error: "volFarmerV4.tickerAllocationPct.AAOI must be a number above 0 and at most 100." });
    expect(request({ tickerAllocationPct: { AAOI: 60, HOOD: 50 } })).toEqual({ ok: false, error: "volFarmerV4.tickerAllocationPct: the set allocations add up to 110%, at most 100%." });
    expect(request({ tickerAllocationPct: { INTC: 10 } })).toEqual({ ok: false, error: "volFarmerV4.tickerAllocationPct.INTC: INTC is not one of the session's symbols." });
  });

  it("keeps the session's Always hold the stock and each ticker's own, refusing other values and a symbol not in the session", () => {
    expect(request({ alwaysHoldTheStock: "off", tickerAlwaysHoldTheStock: { HOOD: "on" } })).toMatchObject({ ok: true, value: { overrides: { volFarmerV4: { alwaysHoldTheStock: "off", tickerAlwaysHoldTheStock: { HOOD: "on" } } } } });
    expect(request({ alwaysHoldTheStock: true })).toEqual({ ok: false, error: "volFarmerV4.alwaysHoldTheStock must be one of on, off." });
    expect(request({ tickerAlwaysHoldTheStock: [] })).toEqual({ ok: false, error: "volFarmerV4.tickerAlwaysHoldTheStock must be an object of symbols." });
    expect(request({ tickerAlwaysHoldTheStock: { HOOD: "sometimes" } })).toEqual({ ok: false, error: "volFarmerV4.tickerAlwaysHoldTheStock.HOOD must be one of on, off." });
    expect(request({ tickerAlwaysHoldTheStock: { INTC: "off" } })).toEqual({ ok: false, error: "volFarmerV4.tickerAlwaysHoldTheStock.INTC: INTC is not one of the session's symbols." });
  });
});

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
    expect(several({ symbols: Array.from({ length: 61 }, (_, index) => `S${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + Math.floor(index / 26))}`) })).toEqual({ ok: false, error: "A session takes at most 60 symbols." });
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
    const result = validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 40 }, steadyStake: { stakePct: 70, callAbsDelta: 0.2 } }, snapshot, editableBacktestSettingPaths);
    expect(result).toEqual({ ok: true, overrides: { trading: { spreadCostChargedPct: 40 }, steadyStake: { stakePct: 70 } } });
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
    expect(validateBacktestSettingsOverrides({ model: { gradeStrongMarginPct: 30 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.model is not a setting a session can change." });
    expect(validateBacktestSettingsOverrides({ kellyFraction: 0.5 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.kellyFraction is not a setting a session can change." });
  });

  it("applies the trading settings' own rules to the spread cost share", () => {
    expect(validateBacktestSettingsOverrides({ trading: { spreadCostChargedPct: 120 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "spreadCostChargedPct must be between 0 and 100." });
  });

  it("refuses every retired decision maker and takes the Steady Stake and Vol Farmer v4", () => {
    const retired = { ok: false, error: "This decision maker was retired (the rules and llm backtests with Signals, the original Vol Farmer on 30 Oct 2026, the CC + Put Ladder and Vol Farmer v2 and v3 on 2 Nov 2026); its past sessions stay readable." };
    for (const decisionMaker of ["rules", "llm", "vol_farmer", "baseline", "vol_farmer_v2", "vol_farmer_v3"]) {
      expect(validateBacktestSettingsOverrides({ decisionMaker }, snapshot, editableBacktestSettingPaths)).toEqual(retired);
      expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker } }, context)).toEqual(retired);
    }
    expect(validateBacktestSettingsOverrides({ decisionMaker: "coin" }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "decisionMaker must be steady_stake or vol_farmer_v4." });
    expect(validateBacktestSettingsOverrides({ decisionMaker: "vol_farmer_v4" }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: {} });
    // Vol Farmer v4: every value its own, each checked under its own name.
    expect(validateBacktestSettingsOverrides({ decisionMaker: "steady_stake", volFarmerV4: { firstPositionPct: 70, callMaxAbsDelta: 0.4 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { decisionMaker: "steady_stake", volFarmerV4: { firstPositionPct: 70, callMaxAbsDelta: 0.4 } } });
    expect(validateBacktestSettingsOverrides({ volFarmerV4: { callMaxAbsDelta: 1.2 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmerV4.callMaxAbsDelta must be a number from 0.01 to 0.99." });
    expect(validateBacktestSettingsOverrides({ volFarmerV4: { firstPositionPct: 95 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmerV4.firstPositionPct must be a number from 10 to 90." });
    expect(validateBacktestSettingsOverrides({ volFarmerV4: { rebalanceBandPct: 51 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmerV4.rebalanceBandPct must be a number from 0 to 50." });
    expect(validateBacktestSettingsOverrides({ volFarmerV4: { stakePct: 80 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "volFarmerV4.stakePct is not a Vol Farmer v4 setting." });
    // A lab still set to a retired decision maker (or a snapshot from before the choice, a rules one) starts nothing unless the request names another.
    for (const retiredSnapshot of [{ ...snapshot, decisionMaker: "baseline" as const }, { ...snapshot, decisionMaker: undefined }]) {
      expect(validateCreateBacktestSessionRequest(validRequest, { ...context, snapshot: retiredSnapshot })).toEqual(retired);
      expect(validateCreateBacktestSessionRequest({ ...validRequest, overrides: { decisionMaker: "steady_stake" } }, { ...context, snapshot: retiredSnapshot })).toMatchObject({ ok: true, value: { overrides: { decisionMaker: "steady_stake" } } });
    }
  });

  it("refuses changes to the retired decision makers' settings: the CC + Put Ladder's, the original Vol Farmer's, v2's and v3's", () => {
    for (const [overrides, path] of [
      [{ baseline: { ladderRungs: 3 } }, "baseline.ladderRungs"],
      [{ volFarmer: { putMinDte: 30 } }, "volFarmer.putMinDte"],
      [{ volFarmerV2: { firstPositionPct: 60 } }, "volFarmerV2.firstPositionPct"],
      [{ volFarmerV3: { rebalanceBandPct: 10 } }, "volFarmerV3.rebalanceBandPct"],
    ] as const) {
      expect(validateBacktestSettingsOverrides(overrides, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: `${path} cannot be changed for a session.` });
    }
  });

  it("takes the Steady Stake as decision maker with its own values, each checked, on a starting value", () => {
    expect(validateBacktestSettingsOverrides({ decisionMaker: "steady_stake", steadyStake: { stakePct: 70, putCashPct: 0, callAbsDelta: 0.2 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: true, overrides: { decisionMaker: "steady_stake", steadyStake: { stakePct: 70, putCashPct: 0 } } });
    expect(validateBacktestSettingsOverrides({ steadyStake: { stakePct: 0 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "steadyStake.stakePct must be a number from 1 to 100." });
    expect(validateBacktestSettingsOverrides({ steadyStake: { ladderRungs: 3 } }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "steadyStake.ladderRungs is not a Steady Stake setting." });
    expect(validateBacktestSettingsOverrides({ steadyStake: 70 }, snapshot, editableBacktestSettingPaths)).toEqual({ ok: false, error: "overrides.steadyStake must be an object." });
    expect(validateCreateBacktestSessionRequest({ ...validRequest, endDate: "2026-06-30", overrides: { decisionMaker: "steady_stake" } }, context)).toMatchObject({ ok: true, value: { bookMode: "shared_account", overrides: { decisionMaker: "steady_stake" } } });
  });
});

describe("one shared account (the per-ticker pots were the CC + Put Ladder's)", () => {
  const twoTickers = { ...validRequest, symbols: ["HOOD", "AAOI"], symbol: undefined, startDate: "2021-08-02" };

  it("runs every session on one shared account with a starting value", () => {
    expect(validateCreateBacktestSessionRequest(twoTickers, context)).toMatchObject({ ok: true, value: { startingValue: 1_000_000, bookMode: "shared_account", symbolSettings: null, symbolResolution: null, settingsSource: null, potsFromStartingValue: null } });
    expect(validateCreateBacktestSessionRequest({ ...twoTickers, startingValue: undefined }, context)).toEqual({ ok: false, error: "The starting account value must be a number above 0." });
  });

  it("refuses per-ticker values", () => {
    expect(validateCreateBacktestSessionRequest({ ...twoTickers, symbolSettings: { HOOD: { potDollars: 1 } } }, context)).toEqual({ ok: false, error: "symbolSettings were the CC + Put Ladder's per-ticker values, retired on 2 Nov 2026." });
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
