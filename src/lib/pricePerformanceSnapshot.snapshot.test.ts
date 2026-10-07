import { beforeEach, describe, expect, it, vi } from "vitest";
import { easternIsoDate } from "./easternIsoDate.js";

const mocks = vi.hoisted(() => {
  const state = {
    rawRows: [] as Record<string, unknown>[],
    barRows: [] as { ticker_id: string; close_price: string }[],
    rawCalls: [] as { sql: string; bindings: unknown[] }[],
    barQueryOperations: [] as [string, ...unknown[]][],
    trendClosesCalls: [] as number[][],
    ivMetricsCalls: [] as string[],
    completedSessionCalls: [] as Date[],
    completedThroughDate: "2026-10-05",
    expectedSessionDate: "2026-10-05",
    liveSessionDate: "2026-10-06",
    rawDelayMs: 0,
  };
  const barBuilder: Record<string, unknown> = {};
  for (const operation of ["whereIn", "andWhere", "andWhereRaw", "orderBy"]) {
    barBuilder[operation] = (...args: unknown[]) => {
      state.barQueryOperations.push([operation, ...args]);
      return barBuilder;
    };
  }
  barBuilder.select = () => Promise.resolve(state.barRows);
  const db = Object.assign(() => barBuilder, {
    raw: async (sql: string, bindings: unknown[]) => {
      state.rawCalls.push({ sql, bindings });
      if (state.rawDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.rawDelayMs));
      return { rows: state.rawRows };
    },
  });
  return { state, db };
});
vi.mock("../db/connection.js", () => ({ db: mocks.db }));
vi.mock("./ivMetrics.js", () => ({
  computeIvMetrics: async (tickerId: string) => {
    mocks.state.ivMetricsCalls.push(tickerId);
    return { ivRank: 55, ivPercentile: 60, ivWindowDays: 250 };
  },
}));
vi.mock("./priceTrends.js", () => ({
  computePriceTrend: (closes: number[]) => {
    mocks.state.trendClosesCalls.push(closes);
    return { macdTrend: "Bullish", maTrend: "uptrend" };
  },
}));
vi.mock("./marketSessionStatus.js", () => ({
  // The grace window moves "now" back; the mock tells the two calls apart by that offset.
  lastCompletedSessionDate: async (now: Date) => {
    mocks.state.completedSessionCalls.push(now);
    return mocks.state.completedSessionCalls.length % 2 === 1 ? mocks.state.completedThroughDate : mocks.state.expectedSessionDate;
  },
  liveSessionDate: async () => mocks.state.liveSessionDate,
  easternIsoDate: (instant: Date) => instant.toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
}));

type SnapshotModule = typeof import("./pricePerformanceSnapshot.js");

const rawRowFor = (overrides: Record<string, unknown> = {}) => ({
  tickerId: "t-aapl",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  latestDate: "2026-10-05",
  latestClose: "110.00",
  dailyLow: "108.00",
  dailyHigh: "111.00",
  close24hAgo: "100.00",
  close48hAgo: "125.00",
  close72hAgo: null,
  close1wAgo: "0",
  close1mAgo: "88.00",
  close3mAgo: "100.00",
  close1yAgo: "55.00",
  liveClose24hAgo: "110.00",
  liveClose48hAgo: "100.00",
  liveClose72hAgo: "125.00",
  liveClose1wAgo: "90.00",
  liveClose1mAgo: "88.00",
  liveClose3mAgo: null,
  liveClose1yAgo: "50.00",
  signalsEnabled: true,
  weeklyLow: "98.00",
  weeklyHigh: "112.00",
  monthlyLow: "80.00",
  monthlyHigh: "115.00",
  impliedVolatility: "0.31",
  avgOptionVolume: "12000",
  ...overrides,
});

describe("getPricePerformanceSnapshot", () => {
  let snapshotModule: SnapshotModule;

  beforeEach(async () => {
    Object.assign(mocks.state, {
      rawRows: [rawRowFor()],
      barRows: [],
      rawCalls: [],
      barQueryOperations: [],
      trendClosesCalls: [],
      ivMetricsCalls: [],
      completedSessionCalls: [],
      completedThroughDate: "2026-10-05",
      expectedSessionDate: "2026-10-05",
      rawDelayMs: 0,
    });
    vi.resetModules();
    snapshotModule = await import("./pricePerformanceSnapshot.js");
  });

  const now = new Date("2026-10-06T14:00:00Z");

  it("builds a row from the raw SQL row: percent changes against each reference close, strings kept as stored", async () => {
    const { tickers } = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(tickers).toHaveLength(1);
    expect(tickers[0]).toEqual({
      symbol: "AAPL",
      companyName: "Apple Inc.",
      latestDate: "2026-10-05",
      latestClose: "110.00",
      dailyLow: "108.00",
      dailyHigh: "111.00",
      weeklyLow: "98.00",
      weeklyHigh: "112.00",
      monthlyLow: "80.00",
      monthlyHigh: "115.00",
      change24h: 10,
      change48h: -12,
      change72h: null,
      change1w: null,
      change1m: 25,
      change3m: 10,
      change1y: 100,
      referenceCloses: { close24hAgo: 100, close48hAgo: 125, close72hAgo: null, close1wAgo: 0, close1mAgo: 88, close3mAgo: 100, close1yAgo: 55 },
      liveReferenceCloses: { close24hAgo: 110, close48hAgo: 100, close72hAgo: 125, close1wAgo: 90, close1mAgo: 88, close3mAgo: null, close1yAgo: 50 },
      macdTrend: "Bullish",
      maTrend: "uptrend",
      signalsEnabled: true,
      impliedVolatility: "0.31",
      avgOptionVolume: "12000",
      ivRank: 55,
      ivPercentile: 60,
      ivWindowDays: 250,
      isBehind: false,
    });
  });

  it("a Signals-off ticker has no IV or option volume (its nightly IV snapshot is skipped, so the stored one would be stale)", async () => {
    mocks.state.rawRows = [rawRowFor({ signalsEnabled: false })];
    const { tickers } = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(tickers[0]).toMatchObject({ signalsEnabled: false, impliedVolatility: null, avgOptionVolume: null, change1y: 100 });
  });

  it("binds the completed-session date to the latest-bar lookup, then the live session date, and asks for the completed session twice (now, and now minus 150 minutes)", async () => {
    await snapshotModule.getPricePerformanceSnapshot(now);
    expect(mocks.state.rawCalls[0]!.bindings).toEqual(["2026-10-05", "2026-10-06"]);
    expect(mocks.state.completedSessionCalls.map((date) => date.toISOString())).toEqual(["2026-10-06T14:00:00.000Z", "2026-10-06T11:30:00.000Z"]);
  });

  it("restricts to the active shortlist in the SQL and orders by symbol", async () => {
    await snapshotModule.getPricePerformanceSnapshot(now);
    const sql = mocks.state.rawCalls[0]!.sql;
    expect(sql).toContain("se.removed_at IS NULL");
    expect(sql).toContain("ORDER BY t.symbol");
  });

  it("reports meta with the completed and expected session dates and a current data flag", async () => {
    const { meta } = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(meta).toEqual({ completedThroughDate: "2026-10-05", expectedSessionDate: "2026-10-05", isDataCurrent: true, behindSymbols: [], liveSessionDate: "2026-10-06" });
  });

  it("flags only the tickers whose latest bar predates the expected session", async () => {
    mocks.state.expectedSessionDate = "2026-10-05";
    mocks.state.rawRows = [rawRowFor(), rawRowFor({ tickerId: "t-msft", symbol: "MSFT", latestDate: "2026-10-02" })];
    const { tickers, meta } = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(tickers.map((row) => [row.symbol, row.isBehind])).toEqual([["AAPL", false], ["MSFT", true]]);
    expect(meta).toMatchObject({ isDataCurrent: false, behindSymbols: ["MSFT"] });
  });

  it("uses the grace-shifted session as expected: data one session behind the completed one is not yet behind", async () => {
    mocks.state.completedThroughDate = "2026-10-05";
    mocks.state.expectedSessionDate = "2026-10-02";
    mocks.state.rawRows = [rawRowFor({ latestDate: "2026-10-02" })];
    const { meta, tickers } = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(meta).toMatchObject({ completedThroughDate: "2026-10-05", expectedSessionDate: "2026-10-02", isDataCurrent: true });
    expect(tickers[0]!.isBehind).toBe(false);
  });

  it("loads every ticker's closes in one query bounded by the completed date and hands them to the trend in ascending order", async () => {
    mocks.state.rawRows = [rawRowFor(), rawRowFor({ tickerId: "t-msft", symbol: "MSFT" })];
    mocks.state.barRows = [
      { ticker_id: "t-aapl", close_price: "100.5" },
      { ticker_id: "t-aapl", close_price: "101.5" },
      { ticker_id: "t-msft", close_price: "400" },
    ];
    await snapshotModule.getPricePerformanceSnapshot(now);
    expect(mocks.state.barQueryOperations).toContainEqual(["whereIn", "ticker_id", ["t-aapl", "t-msft"]]);
    expect(mocks.state.barQueryOperations).toContainEqual(["andWhere", "trading_date", "<=", "2026-10-05"]);
    expect(mocks.state.trendClosesCalls).toEqual([[100.5, 101.5], [400]]);
  });

  it("passes an empty close list to the trend for a ticker with no bars", async () => {
    await snapshotModule.getPricePerformanceSnapshot(now);
    expect(mocks.state.trendClosesCalls).toEqual([[]]);
  });

  it("skips the bar query and ranking work for an empty shortlist, and reports data as current", async () => {
    mocks.state.rawRows = [];
    const snapshot = await snapshotModule.getPricePerformanceSnapshot(now);
    expect(snapshot.tickers).toEqual([]);
    expect(snapshot.meta.isDataCurrent).toBe(true);
    expect(mocks.state.barQueryOperations).toEqual([]);
    expect(mocks.state.ivMetricsCalls).toEqual([]);
  });

  describe("caching", () => {
    it("serves a second call inside 60 seconds from the cache", async () => {
      const first = await snapshotModule.getPricePerformanceSnapshot(now);
      const second = await snapshotModule.getPricePerformanceSnapshot(new Date(now.getTime() + 59_999));
      expect(second).toBe(first);
      expect(mocks.state.rawCalls).toHaveLength(1);
    });

    it("recomputes at exactly 60 seconds", async () => {
      const first = await snapshotModule.getPricePerformanceSnapshot(now);
      const second = await snapshotModule.getPricePerformanceSnapshot(new Date(now.getTime() + 60_000));
      expect(second).not.toBe(first);
      expect(mocks.state.rawCalls).toHaveLength(2);
    });

    it("recomputes when the Eastern date changed even inside the TTL", async () => {
      // 03:59:30 UTC is 23:59:30 Eastern on the 5th; 04:00:10 UTC is 00:00:10 Eastern on the 6th.
      await snapshotModule.getPricePerformanceSnapshot(new Date("2026-10-06T03:59:30Z"));
      await snapshotModule.getPricePerformanceSnapshot(new Date("2026-10-06T04:00:10Z"));
      expect(mocks.state.rawCalls).toHaveLength(2);
    });

    it("recomputes after an explicit invalidation", async () => {
      await snapshotModule.getPricePerformanceSnapshot(now);
      snapshotModule.invalidatePricePerformanceSnapshot();
      await snapshotModule.getPricePerformanceSnapshot(now);
      expect(mocks.state.rawCalls).toHaveLength(2);
    });

    it("shares one computation between concurrent callers", async () => {
      mocks.state.rawDelayMs = 10;
      const [first, second] = await Promise.all([snapshotModule.getPricePerformanceSnapshot(now), snapshotModule.getPricePerformanceSnapshot(now)]);
      expect(second).toBe(first);
      expect(mocks.state.rawCalls).toHaveLength(1);
    });

    it("does not cache a failed computation and lets the next call retry", async () => {
      mocks.state.rawRows = null as never;
      await expect(snapshotModule.getPricePerformanceSnapshot(now)).rejects.toThrow();
      mocks.state.rawRows = [rawRowFor()];
      const snapshot = await snapshotModule.getPricePerformanceSnapshot(now);
      expect(snapshot.tickers).toHaveLength(1);
    });
  });
});
