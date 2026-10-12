import { describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { buildSeedFailureMessage, seedDaySignals, selectDaySignalExpiries, type DaySignalsSeedDependencies } from "./daySignalsSeed.js";
import type { SignalCandidate, SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";
import { openDaysFromCalendarRows } from "./marketSessionStatus.js";
import { fixtureCandidateModel, fixtureModelForecast, fixtureTradingSessions } from "./testSupport/valuationModelFixtures.js";
import type { SignalModelPrediction } from "./signalModelPredictionsStore.js";

// Every weekday of 2026-27: the sessions the fixtures' contracts live through (scoring counts only those after its date).
const fixtureWeekdaySessions = openDaysFromCalendarRows("2026-01-01", "2027-12-31", []);

// A candidate ranked by the model: calibrated annualized return first, then expected P&L per contract.
const candidate = (expiry: string, calibratedAnnualizedReturn: number, expectedPnlDollars: number, edgeMargin = 0.25): SignalCandidate =>
  ({ expiry, strike: 100, strategyKey: "cash_secured_put", model: fixtureCandidateModel({ calibratedAnnualizedReturn, expectedPnlDollars, edgeMargin }) }) as SignalCandidate;

describe("selectDaySignalExpiries", () => {
  it("takes the distinct expiries of the top 10 candidates with a positive expected P&L, ranked as Pluto ranks them, in first-appearance order, capped at 3", () => {
    const candidates = [
      candidate("2026-12-18", 0.02, 30),
      candidate("2026-10-16", 0.6, 140, 0.35),
      candidate("2026-10-16", 0.5, 120),
      candidate("2026-11-20", 0.4, 100),
      candidate("2026-10-09", 0.3, 90),
      candidate("2026-10-30", 0.3, 80),
      candidate("2026-10-16", 0.01, 10),
    ];
    const seeds = selectDaySignalExpiries(candidates);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-10-16", "2026-11-20", "2026-10-09"]);
    expect(seeds.map((seed) => seed.rank)).toEqual([1, 2, 3]);
    expect(seeds[0]).toMatchObject({ seedBestExpectedPnlDollars: 140, seedBestEdgeMargin: 0.35 });
  });

  it("ignores candidates the model expects to lose on, and unvalued ones, however they would rank", () => {
    const unvalued = { expiry: "2026-10-23", strike: 100, strategyKey: "cash_secured_put", model: null } as SignalCandidate;
    const seeds = selectDaySignalExpiries([candidate("2026-10-16", 2, -1), candidate("2026-11-20", 1, 0), unvalued, candidate("2026-12-18", 0.01, 5)]);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-12-18"]);
  });

  it("ranks by the calibrated annualized return before the expected P&L", () => {
    const seeds = selectDaySignalExpiries([candidate("2026-10-16", 0.1, 500), candidate("2026-11-20", 0.3, 20)], { topCandidates: 10, maxExpiries: 1 });
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-11-20"]);
  });

  it("only looks at the top 10 candidates: an expiry that first appears at rank 11 is not pooled", () => {
    const top = Array.from({ length: 10 }, (_, index) => candidate("2026-10-16", 1 - index * 0.01, 100));
    const seeds = selectDaySignalExpiries([...top, candidate("2026-11-20", 0.5, 100)]);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-10-16"]);
  });

  it("appends every open short leg's expiry after the ranked ones, outside the cap, without duplicating one already pooled (Roll Signals)", () => {
    const list = [candidate("2026-10-16", 1, 200), candidate("2026-10-23", 0.9, 150), candidate("2026-10-30", 0.8, 100), candidate("2026-11-06", 0.7, 90)];
    const seeds = selectDaySignalExpiries(list, undefined, ["2026-11-20", "2026-10-23", "2026-11-20"]);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-10-16", "2026-10-23", "2026-10-30", "2026-11-20"]);
    expect(seeds.map((seed) => seed.rank)).toEqual([1, 2, 3, 4]);
    expect(seeds[3]).toMatchObject({ seedBestExpectedPnlDollars: 0, seedBestEdgeMargin: 0 });
    // A held leg on a ticker with no positive candidate still gets a pool.
    expect(selectDaySignalExpiries([candidate("2026-10-16", -1, -10)], undefined, ["2026-10-16"]).map((seed) => seed.expiry)).toEqual(["2026-10-16"]);
  });

  it("returns nothing for a ticker with no positive candidate", () => {
    expect(selectDaySignalExpiries([])).toEqual([]);
    expect(selectDaySignalExpiries([candidate("2026-10-16", -0.2, -50)])).toEqual([]);
  });
});

// --- seedDaySignals -----------------------------------------------------------

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const slice = (expiry: string, years: number): SignalSurfaceSlice => ({
  expiry,
  status: "ok",
  parameters: params,
  kMin: -0.4,
  kMax: 0.4,
  yearsToExpiry: years,
  forwardPrice: forward,
  pointCount: 20,
  rmseVolatility: 0.01,
  minButterflyDensity: 0.8,
  droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 },
  calendarChecks: 0,
  calendarViolations: 0,
});
function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}
function inputsFor(symbol: string, tradingDateIso: string, forecastVolatility: number): TickerSignalsInputs {
  return {
    tickerId: `id-${symbol}`,
    symbol,
    companyName: null,
    sector: null,
    header: { snapshotId: `snap-${symbol}`, tradingDateIso, capturedAt: `${tradingDateIso}T14:00:00Z`, underlyingPrice: forward, riskFreeRatePercent: rate * 100, fitCompletedAt: "2026-09-21T14:06:00Z", fitIssue: null },
    slices: [slice("2026-10-21", years30)],
    quotes: [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30)],
    dayQuotes: [],
    forecast: { volatility: forecastVolatility, windowDays: 63 },
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    momentum: null,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: null,
    freeShares: 0,
    openShortLegs: [],
    dailyBarCount: 1000,
    dividendCadenceUnknown: false,
    todayEasternIso: tradingDateIso,
    openSessionDatesIso: fixtureWeekdaySessions,
    modelForecast: fixtureModelForecast(forecastVolatility),
    tradingSessions: fixtureTradingSessions,
    valuationGroup: "stock",
  };
}
const settings = { minAnnualizedYieldPct: 0, deltaTargetMin: 0, deltaTargetMax: 1, recoveryDteMin: 1, recoveryDteMax: 14, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0, commissionWarnSharePctOfPremium: 5, priceCheckMaxDeviationPct: 10, priceCheckMinToleranceDollars: 0.05, spreadCostChargedPct: 100, orderUnfilledCancelMinutes: 15 };

function seedDependencies(overrides: Partial<DaySignalsSeedDependencies> = {}) {
  const replaceDaySignalPool = vi.fn(async () => {});
  const recordSignalModelPredictions = vi.fn(async (_predictions: SignalModelPrediction[]) => {});
  const deps: DaySignalsSeedDependencies = {
    loadSignalsUniverseTickers: async () => [
      { tickerId: "id-RICH", symbol: "RICH", companyName: null, sector: null },
      { tickerId: "id-CHEAP", symbol: "CHEAP", companyName: null, sector: null },
      { tickerId: "id-OLD", symbol: "OLD", companyName: null, sector: null },
    ],
    // RICH: surface IV (~20%) well above a 10% forecast -> positive edge; CHEAP: forecast 80% -> all Avoid; OLD: yesterday's snapshot.
    loadTickerSignalsInputs: async (ticker) => (ticker.symbol === "RICH" ? inputsFor("RICH", "2026-09-24", 0.1) : ticker.symbol === "CHEAP" ? inputsFor("CHEAP", "2026-09-24", 0.8) : inputsFor("OLD", "2026-09-23", 0.1)),
    loadAccountContext: async () => ({ freeCash: 50_000 }),
    loadTradingSettings: async () => settings,
    replaceDaySignalPool,
    recordSignalModelPredictions,
    now: () => new Date("2026-09-24T14:40:00Z"),
    ...overrides,
  };
  return { deps, replaceDaySignalPool, recordSignalModelPredictions };
}

describe("seedDaySignals", () => {
  it("pools only tickers with today's snapshot and a positive candidate, and replaces the whole pool in one call", async () => {
    const { deps, replaceDaySignalPool, recordSignalModelPredictions } = seedDependencies();
    const result = await seedDaySignals("2026-09-24", deps);
    const predictions = recordSignalModelPredictions.mock.calls[0]![0];
    expect(result).toEqual({ tradingDateIso: "2026-09-24", tickersScored: 2, tickersPooled: 1, expiriesPooled: 1, symbolsWithoutPool: ["CHEAP"], symbolsWithoutTodaySnapshot: ["OLD"], accountContextUnavailable: false, modelPredictionsRecorded: predictions.length });
    expect(replaceDaySignalPool).toHaveBeenCalledTimes(1);
    const [tradingDateIso, seeds, seededAt] = replaceDaySignalPool.mock.calls[0]! as unknown as [string, { tickerId: string; snapshotId: string; expiries: { expiry: string; rank: number }[] }[], Date];
    expect(tradingDateIso).toBe("2026-09-24");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ tickerId: "id-RICH", snapshotId: "snap-RICH", expiries: [{ expiry: "2026-10-21", rank: 1 }] });
    expect(seededAt.toISOString()).toBe("2026-09-24T14:40:00.000Z");
  });

  it("still seeds when the account summary is unavailable (free cash never affects the ranking)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = seedDependencies({
      loadAccountContext: async () => {
        throw new Error("IBKR not ready");
      },
    });
    const result = await seedDaySignals("2026-09-24", deps);
    expect(result.tickersPooled).toBe(1);
    warn.mockRestore();
  });

  it("writes an empty pool (still wiping yesterday's) when nothing qualifies", async () => {
    const { deps, replaceDaySignalPool } = seedDependencies({ loadSignalsUniverseTickers: async () => [] });
    const result = await seedDaySignals("2026-09-24", deps);
    expect(result.tickersPooled).toBe(0);
    expect(replaceDaySignalPool).toHaveBeenCalledWith("2026-09-24", [], expect.any(Date));
  });
});

describe("seed model prediction log", () => {
  it("logs every valued candidate of every scored ticker, priced at the snapshot's own moment, the ones the model expects to lose on included", async () => {
    const { deps, recordSignalModelPredictions } = seedDependencies();
    await seedDaySignals("2026-09-24", deps);
    expect(recordSignalModelPredictions).toHaveBeenCalledTimes(1);
    const predictions = recordSignalModelPredictions.mock.calls[0]![0];
    expect(new Set(predictions.map((prediction) => prediction.tickerId))).toEqual(new Set(["id-RICH", "id-CHEAP"]));
    expect(predictions).toHaveLength(4);
    const richPut = predictions.find((prediction) => prediction.tickerId === "id-RICH" && prediction.right === "P")!;
    const cheapPut = predictions.find((prediction) => prediction.tickerId === "id-CHEAP" && prediction.right === "P")!;
    expect(richPut).toMatchObject({ tradingDateIso: "2026-09-24", expiry: "2026-10-21", strike: 90, quoteSource: "snapshot", valuedAtIso: "2026-09-24T14:00:00.000Z", spot: forward });
    expect(richPut.expectedPnlDollars).toBeGreaterThan(0);
    expect(cheapPut.expectedPnlDollars).toBeLessThan(0);
    expect(cheapPut.grade).toBe("avoid");
  });

  it("still writes the pool when the log write fails, and says so in the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, replaceDaySignalPool } = seedDependencies({ recordSignalModelPredictions: async () => { throw new Error("pg down"); } });
    const result = await seedDaySignals("2026-09-24", deps);
    expect(replaceDaySignalPool).toHaveBeenCalledTimes(1);
    expect(result.tickersPooled).toBe(1);
    expect(result.modelPredictionsRecorded).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pg down"));
    warn.mockRestore();
  });
});

describe("seed failure reporting", () => {
  it("flags an unavailable account summary", async () => {
    const { deps } = seedDependencies({ loadAccountContext: async () => { throw new Error("no IBKR"); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await seedDaySignals("2026-09-24", deps);
    expect(result.accountContextUnavailable).toBe(true);
    expect(buildSeedFailureMessage(result)).toContain("account summary unavailable");
  });

  it("names tickers without today's snapshot and is silent when everything is present", async () => {
    const { deps } = seedDependencies();
    const result = await seedDaySignals("2026-09-24", deps);
    expect(buildSeedFailureMessage(result)).toBe("no snapshot for today, so no Day Signals pool: OLD");
    expect(buildSeedFailureMessage({ ...result, symbolsWithoutTodaySnapshot: [], accountContextUnavailable: false })).toBeUndefined();
  });
});
