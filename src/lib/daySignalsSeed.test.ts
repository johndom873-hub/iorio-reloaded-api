import { describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { seedDaySignals, selectDaySignalExpiries, type DaySignalsSeedDependencies } from "./daySignalsSeed.js";
import type { SignalCandidate, SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";

const candidate = (expiry: string, netEdge: number, edgeDollars: number): SignalCandidate => ({ expiry, netEdge, edgeDollars, strike: 100, strategyKey: "cash_secured_put" }) as SignalCandidate;

describe("selectDaySignalExpiries", () => {
  it("takes the distinct expiries of the top 10 positive-net-Edge candidates by Edge $, in first-appearance order, capped at 3", () => {
    const candidates = [
      candidate("2026-12-18", 0.02, 30),
      candidate("2026-10-16", 0.06, 140),
      candidate("2026-10-16", 0.05, 120),
      candidate("2026-11-20", 0.04, 100),
      candidate("2026-10-09", 0.03, 90),
      candidate("2026-10-30", 0.03, 80),
      candidate("2026-10-16", 0.01, 10),
    ];
    const seeds = selectDaySignalExpiries(candidates);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-10-16", "2026-11-20", "2026-10-09"]);
    expect(seeds.map((seed) => seed.rank)).toEqual([1, 2, 3]);
    expect(seeds[0]).toMatchObject({ seedBestEdgeDollars: 140, seedBestNetEdge: 0.06 });
  });

  it("ignores Avoid candidates (net Edge <= 0) even when their Edge $ would rank them", () => {
    const seeds = selectDaySignalExpiries([candidate("2026-10-16", -0.01, 500), candidate("2026-11-20", 0, 400), candidate("2026-12-18", 0.01, 5)]);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-12-18"]);
  });

  it("only looks at the top 10 candidates: an expiry that first appears at rank 11 is not pooled", () => {
    const top = Array.from({ length: 10 }, (_, index) => candidate("2026-10-16", 0.05, 1000 - index));
    const seeds = selectDaySignalExpiries([...top, candidate("2026-11-20", 0.05, 1)]);
    expect(seeds.map((seed) => seed.expiry)).toEqual(["2026-10-16"]);
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
    header: { snapshotId: `snap-${symbol}`, tradingDateIso, capturedAt: `${tradingDateIso}T14:00:00Z`, underlyingPrice: forward, riskFreeRatePercent: rate * 100 },
    slices: [slice("2026-10-21", years30)],
    quotes: [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30)],
    dayQuotes: [],
    forecast: { volatility: forecastVolatility, windowDays: 63 },
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    momentum: null,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: null,
    freeShares: 0,
    dailyBarCount: 1000,
    dividendCadenceUnknown: false,
    todayEasternIso: tradingDateIso,
  };
}
const settings = { maxDeltaDriftPct: 100, minAnnualizedYieldPct: 0, maxNetDelta: 1, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 };

function seedDependencies(overrides: Partial<DaySignalsSeedDependencies> = {}) {
  const replaceDaySignalPool = vi.fn(async () => {});
  const deps: DaySignalsSeedDependencies = {
    loadShortlistTickers: async () => [
      { tickerId: "id-RICH", symbol: "RICH", companyName: null, sector: null },
      { tickerId: "id-CHEAP", symbol: "CHEAP", companyName: null, sector: null },
      { tickerId: "id-OLD", symbol: "OLD", companyName: null, sector: null },
    ],
    // RICH: surface IV (~20%) well above a 10% forecast -> positive edge; CHEAP: forecast 80% -> all Avoid; OLD: yesterday's snapshot.
    loadTickerSignalsInputs: async (ticker) => (ticker.symbol === "RICH" ? inputsFor("RICH", "2026-09-24", 0.1) : ticker.symbol === "CHEAP" ? inputsFor("CHEAP", "2026-09-24", 0.8) : inputsFor("OLD", "2026-09-23", 0.1)),
    loadAccountContext: async () => ({ freeCash: 50_000 }),
    loadSignalSettings: async () => settings,
    replaceDaySignalPool,
    now: () => new Date("2026-09-24T14:40:00Z"),
    ...overrides,
  };
  return { deps, replaceDaySignalPool };
}

describe("seedDaySignals", () => {
  it("pools only tickers with today's snapshot and a positive candidate, and replaces the whole pool in one call", async () => {
    const { deps, replaceDaySignalPool } = seedDependencies();
    const result = await seedDaySignals("2026-09-24", deps);
    expect(result).toEqual({ tradingDateIso: "2026-09-24", tickersScored: 2, tickersPooled: 1, expiriesPooled: 1, symbolsWithoutPool: ["CHEAP"], symbolsWithoutTodaySnapshot: ["OLD"] });
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
    const { deps, replaceDaySignalPool } = seedDependencies({ loadShortlistTickers: async () => [] });
    const result = await seedDaySignals("2026-09-24", deps);
    expect(result.tickersPooled).toBe(0);
    expect(replaceDaySignalPool).toHaveBeenCalledWith("2026-09-24", [], expect.any(Date));
  });
});
