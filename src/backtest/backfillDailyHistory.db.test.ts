import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { EventName, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { historyDurationReaching } from "../ibkr/historicalDataDuration.js";

// The backtest history backfill against the test database, with a stand-in IBKR connection that answers the two
// historical requests: missing days are inserted, stored prices and implied volatility are never changed.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run backfill database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { backfillDailyHistoryForBacktest, isIbkrNoSuchContractError, isIbkrPacingOrOutageError } = await import("./backfillDailyHistory.js");
const { UnknownSymbolError } = await import("../ibkr/findOrCreateTicker.js");
const testDb: Knex = db;

const symbol = `BF${String(Date.now() % 1_000_000).padStart(6, "0")}`;
let tickerId: string;

type FakeBar = [date: string, open: number, high: number, low: number, close: number, volume: number];

/** Answers reqHistoricalData with the given daily bars (TRADES) or implied-volatility bars, the way @stoqey/ib emits them. */
function fakeConnection(tradeBars: FakeBar[], impliedVolatilityBars: FakeBar[], requests: { duration: string; whatToShow: string }[]): IbkrConnection {
  const ib = new EventEmitter() as EventEmitter & { reqHistoricalData: (...args: unknown[]) => void };
  ib.reqHistoricalData = (reqId, _contract, _end, duration, _barSize, whatToShow) => {
    requests.push({ duration: duration as string, whatToShow: whatToShow as string });
    const bars = whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY ? impliedVolatilityBars : tradeBars;
    setImmediate(() => {
      for (const bar of bars) ib.emit(EventName.historicalData, reqId, ...bar);
      ib.emit(EventName.historicalData, reqId, "finished", -1, -1, -1, -1, -1);
    });
  };
  return { ib, disconnect: () => {} } as unknown as IbkrConnection;
}

beforeAll(async () => {
  const [ticker] = await testDb("tickers").insert({ symbol }).returning("id");
  tickerId = ticker.id;
  await testDb("daily_price_bars").insert([
    { ticker_id: tickerId, trading_date: "2016-01-05", open_price: 10, high_price: 11, low_price: 9, close_price: 10.5, volume: 1000, implied_volatility: null },
    { ticker_id: tickerId, trading_date: "2016-01-06", open_price: 10.5, high_price: 12, low_price: 10, close_price: 11, volume: 1200, implied_volatility: 0.3 },
  ]);
});

afterAll(async () => {
  await testDb("daily_price_bars").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
});

describe("backfillDailyHistoryForBacktest", () => {
  it("inserts the missing days in range and fills missing implied volatility without changing stored values", async () => {
    const requests: { duration: string; whatToShow: string }[] = [];
    const connection = fakeConnection(
      [
        ["20151231", 9, 9.5, 8.5, 9.2, 900],
        ["20160104", 9.5, 10, 9, 9.8, 1500.4],
        // A stored day with a slightly different (revised) close: kept as stored.
        ["20160105", 10, 11, 9, 10.6, 1000],
        ["20160106", 10.5, 12, 10, 11, 1200],
        ["20160107", 11, 12.5, 10.5, 12, 1300],
        // A day after the last finished session (a still-forming bar): not stored.
        ["20160108", 12, 13, 11.5, 12.5, 400],
      ],
      [
        ["20160104", 0.4, 0.4, 0.4, 0.4, 0],
        ["20160105", 0.5, 0.5, 0.5, 0.5, 0],
        ["20160106", 0.9, 0.9, 0.9, 0.9, 0],
      ],
      requests,
    );
    let requestId = 1;
    const result = await backfillDailyHistoryForBacktest(connection, { id: tickerId, symbol }, { lastDateToStore: "2016-01-07", nextRequestId: () => requestId++, now: new Date("2026-10-12T12:00:00Z") });

    expect(requests).toEqual([
      { duration: "11 Y", whatToShow: WhatToShow.TRADES },
      { duration: "11 Y", whatToShow: WhatToShow.OPTION_IMPLIED_VOLATILITY },
    ]);
    expect(result).toMatchObject({
      fetchedBars: 4,
      fetchedImpliedVolatilityDays: 3,
      insertedDays: 2,
      impliedVolatilityFilledDays: 1,
      historyReplacedAfterSplit: false,
      firstDateBefore: "2016-01-05",
      firstDateAfter: "2016-01-04",
      lastDateAfter: "2016-01-07",
      impliedVolatilityFirstDateAfter: "2016-01-04",
      impliedVolatilityError: null,
      invalidBarDates: [],
    });
    const rows = await testDb("daily_price_bars").where({ ticker_id: tickerId }).orderBy("trading_date").select(testDb.raw("trading_date::text as trading_date"), "close_price", "volume", "implied_volatility");
    expect(rows.map((row) => [row.trading_date, Number(row.close_price), Number(row.volume), row.implied_volatility === null ? null : Number(row.implied_volatility)])).toEqual([
      ["2016-01-04", 9.8, 1500, 0.4],
      ["2016-01-05", 10.5, 1000, 0.5],
      ["2016-01-06", 11, 1200, 0.3],
      ["2016-01-07", 12, 1300, null],
    ]);
  });

  it("changes nothing on a second run", async () => {
    const connection = fakeConnection([["20160104", 9.5, 10, 9, 9.8, 1500]], [["20160104", 0.7, 0.7, 0.7, 0.7, 0]], []);
    let requestId = 1;
    const result = await backfillDailyHistoryForBacktest(connection, { id: tickerId, symbol }, { lastDateToStore: "2016-01-07", nextRequestId: () => requestId++ });
    expect(result).toMatchObject({ insertedDays: 0, impliedVolatilityFilledDays: 0 });
  });
});

describe("backfill helpers", () => {
  it("asks IBKR for whole years reaching the start date", () => {
    expect(historyDurationReaching("2016-01-01", new Date("2026-10-12T00:00:00Z"))).toBe("11 Y");
    expect(historyDurationReaching("2016-01-01", new Date("2016-03-01T00:00:00Z"))).toBe("1 Y");
  });

  it("tells pacing and outages from a symbol without data", () => {
    expect(isIbkrPacingOrOutageError(new Error("Historical data timeout for INTC"))).toBe(true);
    expect(isIbkrPacingOrOutageError(new Error("Historical data error for INTC (code 162): Historical Market Data Service error message:API historical data query cancelled: pacing violation"))).toBe(true);
    expect(isIbkrPacingOrOutageError(new Error("Historical data error for XYZ (code 162): Historical Market Data Service error message:HMDS query returned no data"))).toBe(false);
    expect(isIbkrPacingOrOutageError(new Error("Historical data error for XYZ (code 200): No security definition has been found"))).toBe(false);
  });

  it("tells a stock IBKR has no contract for from one it could not reach", () => {
    expect(isIbkrNoSuchContractError(new UnknownSymbolError("WBA", { ibkrHasNoSuchContract: true }))).toBe(true);
    expect(isIbkrNoSuchContractError(new UnknownSymbolError("WBA"))).toBe(false);
    expect(isIbkrNoSuchContractError(new Error("Historical data error for WBA (code 200): No security definition has been found for the request"))).toBe(true);
    expect(isIbkrNoSuchContractError(new Error("Historical data error for INTC (code 162): pacing violation"))).toBe(false);
    expect(isIbkrNoSuchContractError(new Error("Historical data error for INTC (code 2000): something"))).toBe(false);
    expect(isIbkrNoSuchContractError(new Error("Historical data timeout for INTC"))).toBe(false);
  });
});
