import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { runBacktestSession, type BacktestRunHooks } from "./runBacktestSession.js";
import { readSplitScheduleCache } from "./splitFactors.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the backtest engine tests.");
}

// A 2-for-1 split inside a session: the option file is as traded (≈ $100 before 9 March, ≈ $49 after), IBKR's bars are
// split-adjusted (≈ $50 throughout). The engine must infer F = 2 before the split and 1 after, put every bar price on the
// day's traded scale, keep positions opened before the split on their own scale, and value buy and hold continuously.

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `BTS${Date.now() % 100000}`;
const sessionDates = weekdaysBetween("2026-03-02", "2026-03-16");
const firstDayAfterSplit = "2026-03-09";
/** The 10:00 (and closing) price as traded each session day. */
const tradedPrices = [100, 99.5, 99, 98.5, 98, 48.9, 48.7, 48.5, 48.3, 48, 48.2];
const splitFactorOf = (dateIso: string) => (dateIso < firstDayAfterSplit ? 2 : 1);
const adjustedClose = (index: number) => tradedPrices[index]! / splitFactorOf(sessionDates[index]!);
let dataDirectory: string;
let previousDataDirectory: string | undefined;
let tickerId: string;
let sessionId: string;

const hooks: BacktestRunHooks = { reportProgress: async () => {}, isCancelRequested: async () => false };

beforeAll(async () => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-split-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  writeSyntheticSymbolFile(
    path.join(dataDirectory, `${symbol}.sqlite`),
    symbol,
    sessionDates.map((tradingDate, index) => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, tradedPrices[index]!, ["2026-03-13", "2026-03-20"].filter((expiry) => expiry >= tradingDate), 0.6, 0.04, tradingDate < firstDayAfterSplit ? 1 : 0.5, 15), endOfDayVolume: 1_000, openInterest: 2_000 })),
  );
  writeFileSync(path.join(dataDirectory, "fred-DTB3.json"), JSON.stringify({ seriesId: "DTB3", fetchedAtIso: "2026-10-12T00:00:00.000Z", observations: weekdaysBetween("2025-12-01", "2026-04-30").map((dateIso) => ({ dateIso, ratePercent: 4 })) }));

  const [ticker] = await db("tickers").insert({ symbol, company_name: "Backtest Split Test Co", sector: "Technology", tradingview_ticker: `NASDAQ:${symbol}` }).returning("id");
  tickerId = ticker.id;
  const history = syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-02-27"), 50, 0.25, 13, 0.5);
  const sessionBars = sessionDates.map((tradingDate, index) => {
    const close = adjustedClose(index);
    const open = index === 0 ? 50 : adjustedClose(index - 1);
    return { tradingDate, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume: 1_000_000, impliedVolatility: 0.5 };
  });
  await db("daily_price_bars").insert([...history, ...sessionBars].map((bar) => ({ ticker_id: tickerId, trading_date: bar.tradingDate, open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: bar.volume, implied_volatility: bar.impliedVolatility })));
  const [session] = await db("backtest_sessions")
    .insert({ name: "engine split test", symbol, start_date: sessionDates[0], end_date: sessionDates.at(-1), starting_value: 1_000_000, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings()), overrides: JSON.stringify({}) })
    .returning("id");
  sessionId = session.id;
});

afterAll(async () => {
  await db("backtest_sessions").where({ symbol }).del();
  await db("daily_price_bars").where({ ticker_id: tickerId }).del();
  await db("tickers").where({ id: tickerId }).del();
  await db.destroy();
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("runBacktestSession across a split", () => {
  it("infers the split, keeps every price on the day's traded scale and settles held positions on their opening scale", async () => {
    await runBacktestSession(sessionId, hooks, db);

    const cache = readSplitScheduleCache(dataDirectory, symbol)!;
    expect(cache.schedule.splits).toEqual([{ lastDayBefore: "2026-03-06", firstDayAfter: firstDayAfterSplit, ratio: 2 }]);
    expect(cache.schedule.unresolved).toEqual([]);

    const days = await db("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(db.raw('trading_date::text as "tradingDate"'), "*");
    expect(days).toHaveLength(sessionDates.length);
    // No day is judged against the other scale: no "day change … beyond 3×" block, and both curves move smoothly through 9 March.
    for (const day of days) expect(day.decision_summary).not.toContain("beyond 3×");
    for (const day of days.slice(1)) {
      expect(Math.abs(Number(day.daily_return))).toBeLessThan(0.05);
      expect(Math.abs(Number(day.baseline_daily_return))).toBeLessThan(0.05);
    }
    // Buy and hold: shares bought at the first 10:00 price as traded (≈ $100), valued on that scale after the split.
    const firstBaseline = Number(days[0].baseline_value);
    const lastBaseline = Number(days.at(-1).baseline_value);
    expect(firstBaseline).toBeCloseTo(1_000_000, 0);
    expect(lastBaseline / firstBaseline).toBeCloseTo((48.2 * 2) / 100, 2);

    const trades = await db("backtest_trades").where({ session_id: sessionId }).orderBy("id").select(db.raw('opened_on::text as "openedOn"'), db.raw('expiry::text as "expiryIso"'), db.raw('settled_on::text as "settledOnIso"'), "*");
    const heldAcross = trades.filter((trade) => trade.openedOn < firstDayAfterSplit && trade.expiryIso === "2026-03-13");
    expect(heldAcross.length).toBeGreaterThanOrEqual(1);
    for (const trade of heldAcross) {
      // Strike on the old scale (≈ $100), settled at IBKR's adjusted close of 13 March × F(open) = 48 × 2.
      expect(Number(trade.strike)).toBeGreaterThan(80);
      expect(trade.settledOnIso).toBe("2026-03-13");
      expect(Number(trade.settlement_close)).toBeCloseTo(adjustedClose(sessionDates.indexOf("2026-03-13")) * 2, 4);
    }
    const settlementDay = days.find((day) => day.tradingDate === "2026-03-16")!;
    expect(settlementDay.decision_summary).toContain("held across a split (×2)");
    // Sales after the split are on the new scale.
    for (const trade of trades.filter((entry) => entry.openedOn >= firstDayAfterSplit)) expect(Number(trade.strike)).toBeLessThan(60);
  });
});
