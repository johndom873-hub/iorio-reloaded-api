import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceBar } from "./fetchTickerOverview.js";

interface RecordedQuery {
  table: string;
  operations: { method: string; args: unknown[] }[];
}

const mocks = vi.hoisted(() => {
  const queries: { table: string; operations: { method: string; args: unknown[] }[] }[] = [];
  const state = { resolveQuery: (_query: (typeof queries)[number]): unknown => undefined };

  // Every chained method records itself and returns the same builder; awaiting the builder resolves to whatever the
  // test's resolveQuery returns for that table and operation set, mimicking knex's thenable query builder.
  function createBuilder(table: string): object {
    const query: (typeof queries)[number] = { table, operations: [] };
    queries.push(query);
    const builder: object = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) => Promise.resolve().then(() => state.resolveQuery(query)).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            query.operations.push({ method: String(property), args });
            if (property === "modify") (args[0] as (target: object) => void)(builder);
            return builder;
          };
        },
      },
    );
    return builder;
  }

  const rawMock = vi.fn((_sql: string, _bindings?: unknown[]): unknown => undefined);
  const db = Object.assign((table: string) => createBuilder(table), { raw: rawMock });
  return {
    queries,
    state,
    db,
    rawMock,
    fetchHistoricalBarsRaw: vi.fn(),
    lastCompletedSessionDate: vi.fn(),
    connectToIbkrGateway: vi.fn(),
    borrow: vi.fn(),
    allocateReqId: vi.fn(),
    requestRealtimeMarketData: vi.fn(),
  };
});

vi.mock("../db/connection.js", () => ({ db: mocks.db }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connectToIbkrGateway }));
vi.mock("./sharedReadConnection.js", () => ({
  nextReqIdFor: (_ib: unknown, fallback: () => number) => fallback(),
  sharedReadConnection: { borrow: mocks.borrow, allocateReqId: mocks.allocateReqId },
}));
vi.mock("./requestMarketData.js", () => ({ requestRealtimeMarketData: mocks.requestRealtimeMarketData }));
vi.mock("./fetchTickerOverview.js", () => ({ fetchHistoricalBarsRaw: mocks.fetchHistoricalBarsRaw }));
vi.mock("../lib/marketSessionStatus.js", () => ({ lastCompletedSessionDate: mocks.lastCompletedSessionDate }));

const {
  dailyBarsAreCurrent,
  dailyTopUpDurationFor,
  daysBetweenUtc,
  fetchCachedIvBars,
  fetchCachedPriceBars,
  fetchDailyHistoryFromIbkr,
  getCachedChartBars,
  hasSufficientTickerHistory,
  intradayTopUpDurationFor,
  isFreshEnoughToSkipLiveFetch,
  ivBarsToDateMap,
  markLiveFetched,
  needsLiveFetch,
  subtractDuration,
  toDateOnlyString,
  topUpDailyBars,
  upsertDailyBars,
} = await import("./priceBarCache.js");
const { minDaysForIvPercentile } = await import("../lib/ivMetrics.js");

type Connection = Parameters<typeof getCachedChartBars>[0];

// Tuesday 2026-10-06 15:00 UTC.
const now = new Date("2026-10-06T15:00:00Z");
const connection = { ib: {}, disconnect: vi.fn() } as unknown as Connection;

// The freshness map is module-level and never cleared, so every test uses its own symbol.
let symbolCounter = 0;
function uniqueSymbol(): string {
  symbolCounter += 1;
  return `TST${symbolCounter}`;
}

function epochSeconds(isoInstant: string): number {
  return Date.parse(isoInstant) / 1000;
}

function dailyBar(tradingDate: string, close: number, volume = 1000): PriceBar {
  return { time: epochSeconds(`${tradingDate}T00:00:00Z`), open: close - 1, high: close + 2, low: close - 2, close, volume };
}

const tickerId = "ticker-1";

interface CannedRows {
  tickerRow: { id: string } | undefined;
  latestDaily: string | null;
  latestIntraday: string | null;
  dailyRows: Record<string, unknown>[];
  intradayRows: Record<string, unknown>[];
  ivRows: Record<string, unknown>[];
  weeklyRows: Record<string, unknown>[];
  countRow: Record<string, unknown>;
}

let canned: CannedRows;

function queriesOn(table: string): RecordedQuery[] {
  return mocks.queries.filter((query) => query.table === table);
}

function operationArgs(query: RecordedQuery, method: string): unknown[][] {
  return query.operations.filter((operation) => operation.method === method).map((operation) => operation.args);
}

function insertedRows(table: string): Record<string, unknown>[] {
  return queriesOn(table).flatMap((query) => operationArgs(query, "insert")).flatMap((args) => args[0] as Record<string, unknown>[]);
}

beforeEach(() => {
  vi.useFakeTimers({ now });
  mocks.queries.length = 0;
  canned = { tickerRow: { id: tickerId }, latestDaily: null, latestIntraday: null, dailyRows: [], intradayRows: [], ivRows: [], weeklyRows: [], countRow: { totalBars: "0", ivBars: "0" } };
  mocks.state.resolveQuery = (query) => {
    const has = (method: string) => query.operations.some((operation) => operation.method === method);
    if (query.table === "tickers") return canned.tickerRow;
    if (has("insert")) return undefined;
    if (query.table === "daily_price_bars") {
      if (has("max")) return { latest: canned.latestDaily };
      if (has("count")) return canned.countRow;
      if (has("whereNotNull")) return canned.ivRows;
      return canned.dailyRows;
    }
    if (query.table === "intraday_price_bars") {
      if (has("max")) return { latest: canned.latestIntraday };
      return canned.intradayRows;
    }
    throw new Error(`unexpected table ${query.table}`);
  };
  mocks.rawMock.mockReset();
  mocks.rawMock.mockImplementation((sql: string, bindings?: unknown[]) => ({ rows: canned.weeklyRows, sql, bindings }));
  mocks.fetchHistoricalBarsRaw.mockReset();
  mocks.fetchHistoricalBarsRaw.mockResolvedValue([]);
  mocks.lastCompletedSessionDate.mockReset();
  mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
  mocks.connectToIbkrGateway.mockReset();
  mocks.borrow.mockReset();
  mocks.allocateReqId.mockReset();
  mocks.allocateReqId.mockReturnValue(77);
  mocks.requestRealtimeMarketData.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subtractDuration", () => {
  const from = new Date("2026-10-06T12:00:00Z");

  it("subtracts days, weeks, months and years in UTC", () => {
    expect(subtractDuration(from, "5 D").toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(subtractDuration(from, "2 W").toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(subtractDuration(from, "1 M").toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(subtractDuration(from, "6 M").toISOString()).toBe("2026-04-06T12:00:00.000Z");
    expect(subtractDuration(from, "1 Y").toISOString()).toBe("2025-10-06T12:00:00.000Z");
    expect(subtractDuration(from, "20 Y").toISOString()).toBe("2006-10-06T12:00:00.000Z");
  });

  it("accepts lowercase units, no space and surrounding whitespace", () => {
    expect(subtractDuration(from, "3 d").toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(subtractDuration(from, "7D").toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(subtractDuration(from, "  2   W ").toISOString()).toBe("2026-09-22T12:00:00.000Z");
  });

  it("crosses a month boundary when subtracting days", () => {
    expect(subtractDuration(new Date("2026-03-02T00:00:00Z"), "5 D").toISOString()).toBe("2026-02-25T00:00:00.000Z");
  });

  it("does not mutate the date it was given", () => {
    const original = new Date("2026-10-06T12:00:00Z");
    subtractDuration(original, "1 Y");
    expect(original.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("throws for an unrecognized IBKR duration string", () => {
    expect(() => subtractDuration(from, "5 S")).toThrow("Unrecognized IBKR duration string: 5 S");
    expect(() => subtractDuration(from, "D 5")).toThrow("Unrecognized IBKR duration string: D 5");
    expect(() => subtractDuration(from, "")).toThrow("Unrecognized IBKR duration string: ");
  });
});

describe("daysBetweenUtc", () => {
  const from = new Date("2026-10-01T00:00:00Z");

  it("is 0 for the same instant", () => {
    expect(daysBetweenUtc(from, from)).toBe(0);
  });

  it("rounds any partial day up", () => {
    expect(daysBetweenUtc(from, new Date(from.getTime() + 1))).toBe(1);
    expect(daysBetweenUtc(from, new Date("2026-10-02T00:00:00Z"))).toBe(1);
    expect(daysBetweenUtc(from, new Date("2026-10-02T00:00:00.001Z"))).toBe(2);
    expect(daysBetweenUtc(from, new Date("2026-10-03T12:00:00Z"))).toBe(3);
  });

  it("never goes negative when the end is before the start", () => {
    expect(daysBetweenUtc(new Date("2026-10-06T00:00:00Z"), from)).toBe(0);
  });
});

describe("dailyTopUpDurationFor", () => {
  it("never asks for fewer than 5 days, even when the cache is current", () => {
    expect(dailyTopUpDurationFor(now, now)).toBe("5 D");
    expect(dailyTopUpDurationFor(new Date("2026-10-03T15:00:00Z"), now)).toBe("5 D");
  });

  it("asks for the gap plus 2 days once that exceeds the 5 day minimum", () => {
    expect(dailyTopUpDurationFor(new Date("2026-10-02T15:00:00Z"), now)).toBe("6 D");
    expect(dailyTopUpDurationFor(new Date("2026-09-26T15:00:00Z"), now)).toBe("12 D");
  });

  it("rounds a partial gap day up before adding the 2 days (latest bar 4.5 days old: 5 + 2 = 7)", () => {
    expect(dailyTopUpDurationFor(new Date("2026-10-02T03:00:00Z"), now)).toBe("7 D");
  });

  it("still tops up at exactly 365 days of gap (365 + 2 = 367 D)", () => {
    expect(dailyTopUpDurationFor(new Date("2025-10-06T15:00:00Z"), now)).toBe("367 D");
  });

  it("falls back to the full 20 Y backfill when the gap exceeds 365 days", () => {
    expect(dailyTopUpDurationFor(new Date("2025-10-05T15:00:00Z"), now)).toBe("20 Y");
    expect(dailyTopUpDurationFor(new Date("2020-01-01T00:00:00Z"), now)).toBe("20 Y");
  });
});

describe("intradayTopUpDurationFor", () => {
  const configured5D = { configured: "2 D", full: "7 D" };

  it("uses the configured top-up when the newest bar is recent (gap 1 + 1 = 2 D)", () => {
    expect(intradayTopUpDurationFor(new Date("2026-10-06T14:00:00Z"), now, configured5D.configured, configured5D.full)).toBe("2 D");
  });

  it("widens to the gap plus 1 day when the gap exceeds the configured window (3 + 1 = 4 D)", () => {
    expect(intradayTopUpDurationFor(new Date("2026-10-03T15:00:00Z"), now, configured5D.configured, configured5D.full)).toBe("4 D");
  });

  it("falls back to the full duration when the newest bar is older than the full window", () => {
    expect(intradayTopUpDurationFor(new Date("2026-09-28T15:00:00Z"), now, configured5D.configured, configured5D.full)).toBe("7 D");
  });

  it("falls back to the full duration when the newest bar sits exactly on the full window start", () => {
    expect(intradayTopUpDurationFor(new Date("2026-09-29T15:00:00Z"), now, configured5D.configured, configured5D.full)).toBe("7 D");
  });

  it("measures month durations on the calendar (1 M back from Oct 6 is Sep 6; a bar from Sep 20 is 16 days old: 16 + 1 = 17 D)", () => {
    expect(intradayTopUpDurationFor(new Date("2026-09-20T15:00:00Z"), now, "3 D", "1 M")).toBe("17 D");
    expect(intradayTopUpDurationFor(new Date("2026-09-05T15:00:00Z"), now, "3 D", "1 M")).toBe("1 M");
  });

  it("tolerates extra whitespace in the configured duration", () => {
    expect(intradayTopUpDurationFor(new Date("2026-10-06T14:00:00Z"), now, "  5   D ", "6 M")).toBe("5 D");
  });
});

describe("toDateOnlyString", () => {
  it("takes the UTC calendar date of a Date", () => {
    expect(toDateOnlyString(new Date("2026-10-06T23:59:59Z"))).toBe("2026-10-06");
    expect(toDateOnlyString(new Date("2026-10-06T00:00:00Z"))).toBe("2026-10-06");
  });

  it("uses the UTC date, not the date at the offset the instant was written in (Oct 6 23:30 at UTC-5 is Oct 7 UTC)", () => {
    expect(toDateOnlyString(new Date("2026-10-06T23:30:00-05:00"))).toBe("2026-10-07");
  });

  it("keeps only the first 10 characters of a string", () => {
    expect(toDateOnlyString("2026-10-06")).toBe("2026-10-06");
    expect(toDateOnlyString("2026-10-06T00:00:00.000Z")).toBe("2026-10-06");
  });
});

describe("ivBarsToDateMap", () => {
  it("keys each bar's close by its UTC trading date", () => {
    const map = ivBarsToDateMap([dailyBar("2026-10-02", 0.31), dailyBar("2026-10-05", 0.34)]);
    expect([...map.entries()]).toEqual([
      ["2026-10-02", 0.31],
      ["2026-10-05", 0.34],
    ]);
  });

  it("derives the date from the bar instant in UTC (23:59:59 UTC still belongs to that day)", () => {
    const lateBar: PriceBar = { time: epochSeconds("2026-10-05T23:59:59Z"), open: 0, high: 0, low: 0, close: 0.4, volume: 0 };
    expect(ivBarsToDateMap([lateBar]).get("2026-10-05")).toBe(0.4);
  });

  it("lets the last bar win when two bars share a date", () => {
    expect(ivBarsToDateMap([dailyBar("2026-10-02", 0.31), dailyBar("2026-10-02", 0.33)]).get("2026-10-02")).toBe(0.33);
  });

  it("returns an empty map for no bars", () => {
    expect(ivBarsToDateMap([]).size).toBe(0);
  });
});

describe("isFreshEnoughToSkipLiveFetch / markLiveFetched", () => {
  it("is not fresh until a live fetch was marked", () => {
    expect(isFreshEnoughToSkipLiveFetch(uniqueSymbol(), "1Y")).toBe(false);
  });

  it("is fresh for 30 seconds after the mark and stale from the 30th second on", () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "1Y");
    expect(isFreshEnoughToSkipLiveFetch(symbol, "1Y")).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(isFreshEnoughToSkipLiveFetch(symbol, "1Y")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isFreshEnoughToSkipLiveFetch(symbol, "1Y")).toBe(false);
  });

  it("tracks each symbol and range separately", () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "1Y");
    expect(isFreshEnoughToSkipLiveFetch(symbol, "5Y")).toBe(false);
    expect(isFreshEnoughToSkipLiveFetch(uniqueSymbol(), "1Y")).toBe(false);
  });

  it("re-marking restarts the 30 second window", () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "5D");
    vi.advanceTimersByTime(20_000);
    markLiveFetched(symbol, "5D");
    vi.advanceTimersByTime(20_000);
    expect(isFreshEnoughToSkipLiveFetch(symbol, "5D")).toBe(true);
  });
});

describe("dailyBarsAreCurrent", () => {
  it("is false with no cached bar, without asking for the session", async () => {
    expect(await dailyBarsAreCurrent(null)).toBe(false);
    expect(mocks.lastCompletedSessionDate).not.toHaveBeenCalled();
  });

  it("is true when the newest bar is on or after the last completed session", async () => {
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    expect(await dailyBarsAreCurrent(new Date("2026-10-05T00:00:00Z"))).toBe(true);
    expect(await dailyBarsAreCurrent(new Date("2026-10-06T00:00:00Z"))).toBe(true);
  });

  it("is false when the newest bar is before the last completed session", async () => {
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    expect(await dailyBarsAreCurrent(new Date("2026-10-02T00:00:00Z"))).toBe(false);
  });

  it("compares the bar's UTC date, so a late-evening instant on the previous UTC day is stale", async () => {
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    expect(await dailyBarsAreCurrent(new Date("2026-10-04T23:59:59Z"))).toBe(false);
  });
});

describe("needsLiveFetch", () => {
  it("always needs a live fetch for a symbol with no tickers row", async () => {
    expect(await needsLiveFetch(null, uniqueSymbol(), "1Y")).toBe(true);
    expect(await needsLiveFetch(null, uniqueSymbol(), "5D")).toBe(true);
    expect(mocks.queries).toEqual([]);
  });

  it("needs a live fetch for a daily range with no cached daily bar, even when marked fresh", async () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "1Y");
    canned.latestDaily = null;
    expect(await needsLiveFetch(tickerId, symbol, "1Y")).toBe(true);
  });

  it("skips the live fetch for a daily range when one just happened, even if the cache is behind", async () => {
    const symbol = uniqueSymbol();
    canned.latestDaily = "2026-09-01";
    markLiveFetched(symbol, "5Y");
    expect(await needsLiveFetch(tickerId, symbol, "5Y")).toBe(false);
    expect(mocks.lastCompletedSessionDate).not.toHaveBeenCalled();
  });

  it("skips the live fetch for a daily range whose newest bar is the last completed session", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    expect(await needsLiveFetch(tickerId, uniqueSymbol(), "All")).toBe(false);
  });

  it("needs a live fetch for a daily range whose newest bar is behind the last completed session", async () => {
    canned.latestDaily = "2026-10-02";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    expect(await needsLiveFetch(tickerId, uniqueSymbol(), "1Y")).toBe(true);
  });

  it("needs a live fetch for an intraday range with no cached bar", async () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "1D");
    canned.latestIntraday = null;
    expect(await needsLiveFetch(tickerId, symbol, "1D")).toBe(true);
  });

  it("needs a live fetch for an intraday range that is cached but not freshly fetched, and skips it once marked", async () => {
    const symbol = uniqueSymbol();
    canned.latestIntraday = "2026-10-06T14:55:00Z";
    expect(await needsLiveFetch(tickerId, symbol, "1M")).toBe(true);
    markLiveFetched(symbol, "1M");
    expect(await needsLiveFetch(tickerId, symbol, "1M")).toBe(false);
  });

  it("reads the intraday cache for the bar size of the range (3M is 1 hour bars)", async () => {
    canned.latestIntraday = "2026-10-06T14:00:00Z";
    await needsLiveFetch(tickerId, uniqueSymbol(), "3M");
    const [query] = queriesOn("intraday_price_bars");
    expect(operationArgs(query!, "where")).toEqual([[{ ticker_id: tickerId, bar_size: BarSizeSetting.HOURS_ONE }]]);
  });
});

describe("upsertDailyBars", () => {
  it("does nothing for no bars", async () => {
    await upsertDailyBars(tickerId, []);
    expect(mocks.queries).toEqual([]);
  });

  it("writes one row per bar keyed by the UTC trading date, merging IV by date and null where missing", async () => {
    const bars = [dailyBar("2026-10-02", 100, 1234.5), dailyBar("2026-10-05", 102, 2000)];
    await upsertDailyBars(tickerId, bars, new Map([["2026-10-02", 0.31]]));
    expect(insertedRows("daily_price_bars")).toEqual([
      { ticker_id: tickerId, trading_date: "2026-10-02", open_price: 99, high_price: 102, low_price: 98, close_price: 100, volume: 1235, implied_volatility: 0.31 },
      { ticker_id: tickerId, trading_date: "2026-10-05", open_price: 101, high_price: 104, low_price: 100, close_price: 102, volume: 2000, implied_volatility: null },
    ]);
  });

  it("stores a missing or fractional volume as null or a rounded whole number", async () => {
    const bars = [{ ...dailyBar("2026-10-02", 100), volume: Number.NaN }, { ...dailyBar("2026-10-05", 100), volume: 134.4 }];
    await upsertDailyBars(tickerId, bars);
    expect(insertedRows("daily_price_bars").map((row) => row.volume)).toEqual([null, 134]);
  });

  it("conflicts on ticker and date and keeps a cached IV when the new row has none", async () => {
    await upsertDailyBars(tickerId, [dailyBar("2026-10-02", 100)]);
    const [query] = queriesOn("daily_price_bars");
    expect(operationArgs(query!, "onConflict")).toEqual([[["ticker_id", "trading_date"]]]);
    const rawSql = mocks.rawMock.mock.calls.map((call) => call[0]);
    expect(rawSql).toContain("COALESCE(excluded.implied_volatility, daily_price_bars.implied_volatility)");
    expect(rawSql).toContain("excluded.close_price");
  });
});

describe("fetchDailyHistoryFromIbkr", () => {
  it("fetches TRADES bars and the IV series at reqId + 1000 and returns the IV keyed by date", async () => {
    mocks.fetchHistoricalBarsRaw.mockImplementation(async (_connection, _symbol, _barSize, _duration, _reqId, whatToShow) =>
      whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY ? [dailyBar("2026-10-02", 0.31)] : [dailyBar("2026-10-02", 100)],
    );
    const result = await fetchDailyHistoryFromIbkr(connection, "SPY", "1 Y", 5);
    expect(result.bars).toEqual([dailyBar("2026-10-02", 100)]);
    expect([...result.ivByDate.entries()]).toEqual([["2026-10-02", 0.31]]);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, "SPY", BarSizeSetting.DAYS_ONE, "1 Y", 5]);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[1]).toEqual([connection, "SPY", BarSizeSetting.DAYS_ONE, "1 Y", 1005, WhatToShow.OPTION_IMPLIED_VOLATILITY]);
  });

  it("keeps the price bars with an empty IV map when the IV request fails", async () => {
    mocks.fetchHistoricalBarsRaw.mockImplementation(async (_connection, _symbol, _barSize, _duration, _reqId, whatToShow) => {
      if (whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY) throw new Error("no IV data");
      return [dailyBar("2026-10-02", 100)];
    });
    const result = await fetchDailyHistoryFromIbkr(connection, "SPY", "1 Y");
    expect(result.bars).toHaveLength(1);
    expect(result.ivByDate.size).toBe(0);
  });

  it("lets a failing price request propagate", async () => {
    mocks.fetchHistoricalBarsRaw.mockRejectedValue(new Error("pacing violation"));
    await expect(fetchDailyHistoryFromIbkr(connection, "SPY", "1 Y")).rejects.toThrow("pacing violation");
  });
});

describe("hasSufficientTickerHistory", () => {
  it(`needs at least 99 daily bars and ${minDaysForIvPercentile} with an IV value`, async () => {
    canned.countRow = { totalBars: "99", ivBars: String(minDaysForIvPercentile) };
    expect(await hasSufficientTickerHistory(tickerId)).toBe(true);
    canned.countRow = { totalBars: "98", ivBars: String(minDaysForIvPercentile) };
    expect(await hasSufficientTickerHistory(tickerId)).toBe(false);
    canned.countRow = { totalBars: "250", ivBars: String(minDaysForIvPercentile - 1) };
    expect(await hasSufficientTickerHistory(tickerId)).toBe(false);
  });

  it("is false when the count query returns no row", async () => {
    canned.countRow = undefined as never;
    expect(await hasSufficientTickerHistory(tickerId)).toBe(false);
  });
});

describe("topUpDailyBars", () => {
  it("backfills 20 Y when the ticker has no daily bar yet", async () => {
    canned.latestDaily = null;
    await topUpDailyBars(connection, tickerId, "SPY", 3);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, "SPY", BarSizeSetting.DAYS_ONE, "20 Y", 3]);
  });

  it("sizes the window from the gap since the newest stored bar (Oct 1 to Oct 6 15:00 is 6 days: 6 + 2 = 8 D)", async () => {
    canned.latestDaily = "2026-10-01";
    await topUpDailyBars(connection, tickerId, "SPY");
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![3]).toBe("8 D");
  });

  it("reports the count and the first and last UTC trading date of what was fetched, however the bars are ordered", async () => {
    canned.latestDaily = "2026-10-01";
    mocks.fetchHistoricalBarsRaw.mockImplementation(async (_connection, _symbol, _barSize, _duration, _reqId, whatToShow) =>
      whatToShow ? [] : [dailyBar("2026-10-05", 102), dailyBar("2026-10-02", 100), dailyBar("2026-10-06", 103)],
    );
    expect(await topUpDailyBars(connection, tickerId, "SPY")).toEqual({ barCount: 3, firstTradingDate: "2026-10-02", lastTradingDate: "2026-10-06" });
    expect(insertedRows("daily_price_bars")).toHaveLength(3);
  });

  it("reports nulls and writes nothing when IBKR returns no bars", async () => {
    canned.latestDaily = "2026-10-01";
    expect(await topUpDailyBars(connection, tickerId, "SPY")).toEqual({ barCount: 0, firstTradingDate: null, lastTradingDate: null });
    expect(insertedRows("daily_price_bars")).toEqual([]);
  });
});

describe("getCachedChartBars with no tickers row", () => {
  const liveBars = [dailyBar("2026-10-02", 100)];

  beforeEach(() => {
    canned.tickerRow = undefined;
    mocks.fetchHistoricalBarsRaw.mockResolvedValue(liveBars);
  });

  it.each([
    ["1Y", "1 Y"],
    ["5Y", "5 Y"],
    ["All", "20 Y"],
  ] as const)("fetches %s live as daily bars over %s without touching the cache tables", async (range, duration) => {
    expect(await getCachedChartBars(connection, uniqueSymbol(), range, 9)).toEqual(liveBars);
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, expect.any(String), BarSizeSetting.DAYS_ONE, duration, 9]);
    expect(queriesOn("daily_price_bars")).toEqual([]);
  });

  it("fetches an intraday range live with its own bar size and full duration", async () => {
    expect(await getCachedChartBars(connection, uniqueSymbol(), "5D")).toEqual(liveBars);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, expect.any(String), BarSizeSetting.MINUTES_FIVE, "7 D", 1]);
    expect(queriesOn("intraday_price_bars")).toEqual([]);
  });
});

describe("getCachedChartBars for 1Y / 5Y / All", () => {
  const cachedRows = [
    { trading_date: new Date("2026-10-01T00:00:00Z"), open_price: "99.5", high_price: "102", low_price: "98.25", close_price: "101", volume: "1500" },
    { trading_date: "2026-10-02", open_price: 101, high_price: 103, low_price: 100, close_price: 102.5, volume: 1800 },
  ];

  it("cold-backfills 20 Y of prices and IV, stores them, then reads 1Y back from the cache", async () => {
    const symbol = uniqueSymbol();
    canned.latestDaily = null;
    canned.dailyRows = cachedRows;
    mocks.fetchHistoricalBarsRaw.mockImplementation(async (_connection, _symbol, _barSize, _duration, _reqId, whatToShow) =>
      whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY ? [dailyBar("2026-10-02", 0.3)] : [dailyBar("2026-10-02", 100), dailyBar("2026-10-05", 102)],
    );

    const bars = await getCachedChartBars(connection, symbol, "1Y", 4);

    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, symbol, BarSizeSetting.DAYS_ONE, "20 Y", 4]);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[1]).toEqual([connection, symbol, BarSizeSetting.DAYS_ONE, "20 Y", 1004, WhatToShow.OPTION_IMPLIED_VOLATILITY]);
    expect(insertedRows("daily_price_bars").map((row) => [row.trading_date, row.implied_volatility])).toEqual([
      ["2026-10-02", 0.3],
      ["2026-10-05", null],
    ]);
    expect(bars).toEqual([
      { time: epochSeconds("2026-10-01T00:00:00Z"), open: 99.5, high: 102, low: 98.25, close: 101, volume: 1500 },
      { time: epochSeconds("2026-10-02T00:00:00Z"), open: 101, high: 103, low: 100, close: 102.5, volume: 1800 },
    ]);
    const readQuery = queriesOn("daily_price_bars").find((query) => operationArgs(query, "orderBy").length > 0)!;
    expect(operationArgs(readQuery, "andWhere")).toEqual([["trading_date", ">=", "2025-10-06"]]);
    expect(operationArgs(readQuery, "orderBy")).toEqual([["trading_date", "asc"]]);
  });

  it("does not call IBKR when the newest cached bar is the last completed session", async () => {
    canned.latestDaily = "2026-10-05";
    canned.dailyRows = cachedRows;
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    const bars = await getCachedChartBars(connection, uniqueSymbol(), "1Y");
    expect(mocks.fetchHistoricalBarsRaw).not.toHaveBeenCalled();
    expect(bars).toHaveLength(2);
  });

  it("tops up a stale cache with a window sized from the gap (newest bar Oct 1, now Oct 6 15:00: 6 + 2 = 8 D)", async () => {
    canned.latestDaily = "2026-10-01";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    await getCachedChartBars(connection, uniqueSymbol(), "1Y");
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![3]).toBe("8 D");
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[1]![3]).toBe("8 D");
  });

  it("does not top up again within 30 seconds, then tops up again once the window has passed", async () => {
    const symbol = uniqueSymbol();
    canned.latestDaily = "2026-10-01";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");

    await getCachedChartBars(connection, symbol, "1Y");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(29_000);
    await getCachedChartBars(connection, symbol, "1Y");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_000);
    await getCachedChartBars(connection, symbol, "1Y");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(4);
  });

  it("freshness is per range: a warm 1Y does not stop the 5Y from topping up", async () => {
    const symbol = uniqueSymbol();
    canned.latestDaily = "2026-10-01";
    await getCachedChartBars(connection, symbol, "1Y");
    mocks.fetchHistoricalBarsRaw.mockClear();
    await getCachedChartBars(connection, symbol, "5Y");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(2);
  });

  it("still stores the price bars when the IV request fails, with a null IV", async () => {
    canned.latestDaily = null;
    mocks.fetchHistoricalBarsRaw.mockImplementation(async (_connection, _symbol, _barSize, _duration, _reqId, whatToShow) => {
      if (whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY) throw new Error("no IV data");
      return [dailyBar("2026-10-02", 100)];
    });
    await getCachedChartBars(connection, uniqueSymbol(), "1Y");
    expect(insertedRows("daily_price_bars").map((row) => row.implied_volatility)).toEqual([null]);
  });

  it("writes nothing when the top-up comes back empty, and returns an empty chart for an empty cache", async () => {
    canned.latestDaily = null;
    canned.dailyRows = [];
    expect(await getCachedChartBars(connection, uniqueSymbol(), "1Y")).toEqual([]);
    expect(insertedRows("daily_price_bars")).toEqual([]);
  });

  it("serves 5Y from the weekly resample over the last 5 years, with the date bound passed twice", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    canned.weeklyRows = [
      { week_start: new Date("2026-09-28T00:00:00Z"), open_price: "100.5", high_price: "110", low_price: "99", close_price: "105.25", volume: "12345" },
      { week_start: "2026-10-05", open_price: 105, high_price: 108, low_price: 104, close_price: 107, volume: 5000 },
    ];
    const bars = await getCachedChartBars(connection, uniqueSymbol(), "5Y");

    expect(mocks.rawMock).toHaveBeenCalledTimes(1);
    expect(mocks.rawMock.mock.calls[0]![1]).toEqual([tickerId, "2021-10-06", "2021-10-06"]);
    expect(bars).toEqual([
      { time: epochSeconds("2026-09-28T00:00:00Z"), open: 100.5, high: 110, low: 99, close: 105.25, volume: 12345 },
      { time: epochSeconds("2026-10-05T00:00:00Z"), open: 105, high: 108, low: 104, close: 107, volume: 5000 },
    ]);
  });

  it("serves All from the weekly resample with no lower date bound", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    canned.weeklyRows = [];
    expect(await getCachedChartBars(connection, uniqueSymbol(), "All")).toEqual([]);
    expect(mocks.rawMock.mock.calls[0]![1]).toEqual([tickerId, null, null]);
  });

  it("the weekly resample SQL takes the first open, the last close, the extreme high and low, and the summed volume of each ISO week", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    await getCachedChartBars(connection, uniqueSymbol(), "All");
    const sql = String(mocks.rawMock.mock.calls[0]![0]);
    expect(sql).toContain("date_trunc('week', trading_date)");
    expect(sql).toContain("max(CASE WHEN rn_asc = 1 THEN open_price END)");
    expect(sql).toContain("max(CASE WHEN rn_desc = 1 THEN close_price END)");
    expect(sql).toContain("max(high_price)");
    expect(sql).toContain("min(low_price)");
    expect(sql).toContain("sum(volume)");
  });
});

describe("getCachedChartBars for intraday ranges", () => {
  const intradayRows = [
    { bar_time: new Date("2026-10-06T14:55:00Z"), open_price: "500.1", high_price: "500.9", low_price: "499.8", close_price: "500.5", volume: "1200" },
    { bar_time: "2026-10-06T15:00:00.000Z", open_price: 500.5, high_price: 501, low_price: 500, close_price: 500.75, volume: 900 },
  ];

  function liveBar(isoInstant: string, close: number, volume: number): PriceBar {
    return { time: epochSeconds(isoInstant), open: close - 0.5, high: close + 0.5, low: close - 1, close, volume };
  }

  it("cold-fetches the full duration of the range at its bar size, stores the bars and reads back from now minus that duration", async () => {
    const symbol = uniqueSymbol();
    canned.latestIntraday = null;
    canned.intradayRows = intradayRows;
    mocks.fetchHistoricalBarsRaw.mockResolvedValue([liveBar("2026-10-06T14:55:00Z", 500.5, 1200.4)]);

    const bars = await getCachedChartBars(connection, symbol, "5D", 6);

    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]).toEqual([connection, symbol, BarSizeSetting.MINUTES_FIVE, "7 D", 6]);
    expect(insertedRows("intraday_price_bars")).toEqual([
      { ticker_id: tickerId, bar_size: BarSizeSetting.MINUTES_FIVE, bar_time: new Date("2026-10-06T14:55:00Z"), open_price: 500, high_price: 501, low_price: 499.5, close_price: 500.5, volume: 1200 },
    ]);
    const readQuery = queriesOn("intraday_price_bars").find((query) => operationArgs(query, "orderBy").length > 0)!;
    expect(operationArgs(readQuery, "andWhere")).toEqual([["bar_time", ">=", new Date("2026-09-29T15:00:00Z")]]);
    expect(bars).toEqual([
      { time: epochSeconds("2026-10-06T14:55:00Z"), open: 500.1, high: 500.9, low: 499.8, close: 500.5, volume: 1200 },
      { time: epochSeconds("2026-10-06T15:00:00Z"), open: 500.5, high: 501, low: 500, close: 500.75, volume: 900 },
    ]);
  });

  it("floors bar times to whole seconds when reading", async () => {
    canned.latestIntraday = "2026-10-06T14:00:00Z";
    markLiveFetched("FLOOR", "1D");
    canned.intradayRows = [{ bar_time: new Date("2026-10-06T14:55:00.900Z"), open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 }];
    const [bar] = await getCachedChartBars(connection, "FLOOR", "1D");
    expect(bar!.time).toBe(epochSeconds("2026-10-06T14:55:00Z"));
  });

  it("tops up only the gap when the cache is warm but not freshly fetched (newest bar 3 days old, 5D config 2 D: 3 + 1 = 4 D)", async () => {
    canned.latestIntraday = "2026-10-03T15:00:00Z";
    await getCachedChartBars(connection, uniqueSymbol(), "5D");
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![3]).toBe("4 D");
  });

  it("refetches the whole range when the newest cached bar is older than that range", async () => {
    canned.latestIntraday = "2026-09-01T15:00:00Z";
    await getCachedChartBars(connection, uniqueSymbol(), "1M");
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![2]).toBe(BarSizeSetting.MINUTES_THIRTY);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![3]).toBe("1 M");
  });

  it("does not call IBKR again within 30 seconds of the last live fetch, but does after", async () => {
    const symbol = uniqueSymbol();
    canned.latestIntraday = "2026-10-06T14:55:00Z";
    await getCachedChartBars(connection, symbol, "3M");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![2]).toBe(BarSizeSetting.HOURS_ONE);

    vi.advanceTimersByTime(10_000);
    await getCachedChartBars(connection, symbol, "3M");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000);
    await getCachedChartBars(connection, symbol, "3M");
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(2);
  });

  it("uses a different bar size for every intraday range", async () => {
    const barSizes: Record<string, BarSizeSetting> = {};
    for (const range of ["1D", "5D", "1M", "3M", "6M"] as const) {
      mocks.fetchHistoricalBarsRaw.mockClear();
      canned.latestIntraday = null;
      await getCachedChartBars(connection, uniqueSymbol(), range);
      barSizes[range] = mocks.fetchHistoricalBarsRaw.mock.calls[0]![2];
    }
    expect(barSizes).toEqual({
      "1D": BarSizeSetting.MINUTES_ONE,
      "5D": BarSizeSetting.MINUTES_FIVE,
      "1M": BarSizeSetting.MINUTES_THIRTY,
      "3M": BarSizeSetting.HOURS_ONE,
      "6M": BarSizeSetting.HOURS_TWO,
    });
  });

  it("writes nothing when IBKR returns no new bars", async () => {
    canned.latestIntraday = null;
    expect(await getCachedChartBars(connection, uniqueSymbol(), "1D")).toEqual([]);
    expect(insertedRows("intraday_price_bars")).toEqual([]);
  });
});

describe("fetchCachedPriceBars", () => {
  it("reads straight from the cache without borrowing or opening a connection when it is warm and current", async () => {
    canned.latestDaily = "2026-10-05";
    canned.dailyRows = [{ trading_date: "2026-10-02", open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5, volume: 10 }];
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");

    const bars = await fetchCachedPriceBars(uniqueSymbol(), "1Y");

    expect(bars).toEqual([{ time: epochSeconds("2026-10-02T00:00:00Z"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    expect(mocks.borrow).not.toHaveBeenCalled();
    expect(mocks.connectToIbkrGateway).not.toHaveBeenCalled();
  });

  it("reads from the cache without connecting when the symbol was just fetched, for an intraday range", async () => {
    const symbol = uniqueSymbol();
    markLiveFetched(symbol, "1D");
    canned.latestIntraday = "2026-10-06T14:59:00Z";
    await fetchCachedPriceBars(symbol, "1D");
    expect(mocks.borrow).not.toHaveBeenCalled();
    expect(mocks.fetchHistoricalBarsRaw).not.toHaveBeenCalled();
  });

  it("uses the shared read connection with an allocated request id and releases it afterwards", async () => {
    const release = vi.fn();
    const ib = {};
    mocks.borrow.mockResolvedValue({ ib, release });
    canned.latestDaily = null;
    const symbol = uniqueSymbol();

    await fetchCachedPriceBars(symbol, "1Y");

    expect(mocks.requestRealtimeMarketData).toHaveBeenCalledWith(ib);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![4]).toBe(77);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.connectToIbkrGateway).not.toHaveBeenCalled();
  });

  it("releases the shared connection when the fetch fails and passes the error on", async () => {
    const release = vi.fn();
    mocks.borrow.mockResolvedValue({ ib: {}, release });
    mocks.fetchHistoricalBarsRaw.mockRejectedValue(new Error("historical data farm disconnected"));
    canned.latestDaily = null;

    await expect(fetchCachedPriceBars(uniqueSymbol(), "1Y")).rejects.toThrow("historical data farm disconnected");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to a one-shot connection when the shared one is unavailable, and disconnects it afterwards", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const disconnect = vi.fn();
    const ib = {};
    mocks.borrow.mockRejectedValue(new Error("gateway down"));
    mocks.connectToIbkrGateway.mockResolvedValue({ ib, disconnect });
    canned.latestDaily = null;

    await fetchCachedPriceBars(uniqueSymbol(), "1Y");

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("shared read connection unavailable (gateway down)"));
    expect(mocks.requestRealtimeMarketData).toHaveBeenCalledWith(ib);
    expect(mocks.fetchHistoricalBarsRaw.mock.calls[0]![4]).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("goes to IBKR for a symbol with no tickers row", async () => {
    canned.tickerRow = undefined;
    const release = vi.fn();
    mocks.borrow.mockResolvedValue({ ib: {}, release });
    mocks.fetchHistoricalBarsRaw.mockResolvedValue([dailyBar("2026-10-02", 100)]);
    expect(await fetchCachedPriceBars(uniqueSymbol(), "1Y")).toEqual([dailyBar("2026-10-02", 100)]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCachedIvBars", () => {
  const ivRows = [
    { trading_date: new Date("2026-10-01T00:00:00Z"), implied_volatility: "0.3125" },
    { trading_date: "2026-10-02", implied_volatility: 0.4 },
  ];

  it("returns the cached IV points as epoch seconds and numbers without connecting when the cache is current", async () => {
    canned.latestDaily = "2026-10-05";
    canned.ivRows = ivRows;
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");

    const points = await fetchCachedIvBars(uniqueSymbol(), "1Y");

    expect(points).toEqual([
      { time: epochSeconds("2026-10-01T00:00:00Z"), value: 0.3125 },
      { time: epochSeconds("2026-10-02T00:00:00Z"), value: 0.4 },
    ]);
    expect(mocks.borrow).not.toHaveBeenCalled();
  });

  it("only reads days that have an IV, from one year back for 1Y and five years back for 5Y", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    await fetchCachedIvBars(uniqueSymbol(), "1Y");
    await fetchCachedIvBars(uniqueSymbol(), "5Y");
    const readQueries = queriesOn("daily_price_bars").filter((query) => operationArgs(query, "whereNotNull").length > 0);
    expect(readQueries.map((query) => operationArgs(query, "whereNotNull"))).toEqual([[["implied_volatility"]], [["implied_volatility"]]]);
    expect(readQueries.map((query) => operationArgs(query, "andWhere"))).toEqual([[["trading_date", ">=", "2025-10-06"]], [["trading_date", ">=", "2021-10-06"]]]);
  });

  it("reads the whole history for All, with no date bound", async () => {
    canned.latestDaily = "2026-10-05";
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");
    await fetchCachedIvBars(uniqueSymbol(), "All");
    const readQuery = queriesOn("daily_price_bars").find((query) => operationArgs(query, "whereNotNull").length > 0)!;
    expect(operationArgs(readQuery, "andWhere")).toEqual([]);
  });

  it("warms the cache through the shared connection first when it is stale, then reads", async () => {
    const release = vi.fn();
    mocks.borrow.mockResolvedValue({ ib: {}, release });
    canned.latestDaily = "2026-10-01";
    canned.ivRows = ivRows;
    mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-05");

    const points = await fetchCachedIvBars(uniqueSymbol(), "1Y");

    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(points).toHaveLength(2);
  });

  it("returns an empty series for a symbol with no tickers row, after the live fetch attempt", async () => {
    canned.tickerRow = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const disconnect = vi.fn();
    mocks.borrow.mockRejectedValue(new Error("gateway down"));
    mocks.connectToIbkrGateway.mockResolvedValue({ ib: {}, disconnect });

    expect(await fetchCachedIvBars(uniqueSymbol(), "1Y")).toEqual([]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(queriesOn("daily_price_bars")).toEqual([]);
  });
});

describe("subtractDuration at the end of a month", () => {
  it("clamps to the last day of the target month instead of spilling into the next one", () => {
    expect(subtractDuration(new Date("2026-03-31T15:00:00Z"), "1 M").toISOString()).toBe("2026-02-28T15:00:00.000Z");
    expect(subtractDuration(new Date("2026-05-31T15:00:00Z"), "1 M").toISOString()).toBe("2026-04-30T15:00:00.000Z");
    expect(subtractDuration(new Date("2026-08-31T15:00:00Z"), "6 M").toISOString()).toBe("2026-02-28T15:00:00.000Z");
  });

  it("uses 29 February when the target month is in a leap year", () => {
    expect(subtractDuration(new Date("2028-03-31T15:00:00Z"), "1 M").toISOString()).toBe("2028-02-29T15:00:00.000Z");
  });

  it("subtracting a year from 29 February lands on 28 February of a non-leap year", () => {
    expect(subtractDuration(new Date("2028-02-29T15:00:00Z"), "1 Y").toISOString()).toBe("2027-02-28T15:00:00.000Z");
  });

  it("crosses a year boundary and keeps the time of day", () => {
    expect(subtractDuration(new Date("2026-01-31T09:30:15Z"), "2 M").toISOString()).toBe("2025-11-30T09:30:15.000Z");
  });

  it("is unchanged for ordinary days", () => {
    expect(subtractDuration(new Date("2026-10-15T12:00:00Z"), "1 M").toISOString()).toBe("2026-09-15T12:00:00.000Z");
  });
});

describe("intradayTopUpDurationFor never asks for more than the full window", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("asks for the full window when the gap plus one day would exceed it (newest bar 6 d 23 h old, 7 D window)", () => {
    expect(intradayTopUpDurationFor(hoursAgo(6 * 24 + 23), now, "2 D", "7 D")).toBe("7 D");
  });

  it("asks for the full month when the gap plus one day would exceed it (newest bar 29.5 d old, 1 M window)", () => {
    expect(intradayTopUpDurationFor(hoursAgo(29.5 * 24), now, "3 D", "1 M")).toBe("1 M");
  });

  it("still asks for just the gap plus one day when that is shorter than the full window (5 days old, 7 D window)", () => {
    expect(intradayTopUpDurationFor(hoursAgo(5 * 24), now, "2 D", "7 D")).toBe("6 D");
  });
});
