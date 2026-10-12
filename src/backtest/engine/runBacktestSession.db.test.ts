import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { BacktestCancelledError, computeSessionMetrics, runBacktestSession, type BacktestRunHooks } from "./runBacktestSession.js";
import { settlePosition } from "./backtestBook.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the backtest engine tests.");
}

// One session end to end against the test database: a synthetic symbol file (11 days, two weekly expiries), synthetic IBKR
// bars, a cached DTB3 series at 4% and the current model tables. The stock falls from 100 to 94 into the first expiry, so
// the puts sold on it settle against the 13 March close.

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `BTE${Date.now() % 100000}`;
const sessionDates = weekdaysBetween("2026-03-02", "2026-03-16");
const closes = [100.5, 99.8, 99.0, 98.2, 97.5, 96.9, 96.0, 95.2, 94.6, 94.0, 95.0];
const expiries = ["2026-03-13", "2026-03-20"];
const ratePercent = 4;
let dataDirectory: string;
let previousDataDirectory: string | undefined;
let tickerId: string;
let sessionId: string;

const progressCalls: { done: number; total: number; label: string }[] = [];
const hooks: BacktestRunHooks = {
  reportProgress: async (done, total, label) => {
    progressCalls.push({ done, total, label });
  },
  isCancelRequested: async () => false,
};

/** The 10:00 price of a session day: halfway between the previous close and the day's close. */
function tenOClockPrice(index: number): number {
  const previousClose = index === 0 ? 100 : closes[index - 1]!;
  return (previousClose + closes[index]!) / 2;
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-engine-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;

  writeSyntheticSymbolFile(
    path.join(dataDirectory, `${symbol}.sqlite`),
    symbol,
    sessionDates.map((tradingDate, index) => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, tenOClockPrice(index), expiries.filter((expiry) => expiry >= tradingDate), 0.6, ratePercent / 100, 1, 15), endOfDayVolume: 1_000, openInterest: 2_000 })),
  );
  writeFileSync(path.join(dataDirectory, "fred-DTB3.json"), JSON.stringify({ seriesId: "DTB3", fetchedAtIso: "2026-10-12T00:00:00.000Z", observations: weekdaysBetween("2025-12-01", "2026-04-30").map((dateIso) => ({ dateIso, ratePercent })) }));

  const [ticker] = await db("tickers").insert({ symbol, company_name: "Backtest Engine Test Co", sector: "Technology", tradingview_ticker: `NASDAQ:${symbol}` }).returning("id");
  tickerId = ticker.id;
  const history = syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-02-27"), 100, 0.25, 11, 0.5);
  const sessionBars = sessionDates.map((tradingDate, index) => {
    const open = index === 0 ? 100 : closes[index - 1]!;
    const close = closes[index]!;
    return { tradingDate, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume: 1_000_000, impliedVolatility: 0.5 };
  });
  await db("daily_price_bars").insert([...history, ...sessionBars].map((bar) => ({ ticker_id: tickerId, trading_date: bar.tradingDate, open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: bar.volume, implied_volatility: bar.impliedVolatility })));

  const [session] = await db("backtest_sessions")
    .insert({ name: "engine test", symbol, start_date: sessionDates[0], end_date: sessionDates.at(-1), starting_value: 1_000_000, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings()), overrides: JSON.stringify({}) })
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

describe("runBacktestSession", () => {
  it("replays every day, records trades and settles them, and stores the metrics", async () => {
    await runBacktestSession(sessionId, hooks, db);

    const session = await db("backtest_sessions").where({ id: sessionId }).first();
    expect(session.status).toBe("succeeded");
    expect(session.finished_at).not.toBeNull();
    const dataLastDate = await db("backtest_sessions").where({ id: sessionId }).first(db.raw("data_last_date::text as d"));
    expect(dataLastDate.d).toBe("2026-03-16");

    const days = await db("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(db.raw('trading_date::text as "tradingDate"'), "*");
    expect(days.map((day) => day.tradingDate)).toEqual(sessionDates);
    expect(Number(days[0].account_value)).toBeCloseTo(1_000_000, 2);
    expect(Number(days[0].baseline_value)).toBeCloseTo(1_000_000, 2);
    expect(days[0].daily_return).toBeNull();
    expect(Number(days[0].interest_dollars)).toBe(0);
    for (const day of days) expect(day.decision_summary).toMatch(/^(Opened|No open)/);
    // Continuous: no day moves the account more than 5% (the trades are sized at ~5% of the account each).
    for (const day of days.slice(1)) expect(Math.abs(Number(day.daily_return))).toBeLessThan(0.05);
    // Interest over the weekend into Monday 9 March: cash before interest × 4% × 3 ÷ 365 (no settlement that day).
    const monday = days.find((day) => day.tradingDate === "2026-03-09")!;
    const mondayInterest = Number(monday.interest_dollars);
    expect(mondayInterest).toBeCloseTo(((Number(monday.cash) - mondayInterest) * 0.04 * 3) / 365, 1);
    // The last day prices the stock with no expiry a day out left? It has the 20 March expiry, so it is priced from quotes.
    expect(days.at(-1).decision_summary).not.toContain("previous close");

    const trades = await db("backtest_trades").where({ session_id: sessionId }).orderBy("id").select(db.raw('opened_on::text as "openedOn"'), db.raw('expiry::text as "expiryIso"'), db.raw('settled_on::text as "settledOnIso"'), "*");
    expect(trades.length).toBeGreaterThanOrEqual(3);
    for (const trade of trades) {
      expect(trade.contracts).toBeGreaterThanOrEqual(1);
      expect(Number(trade.fill_price)).toBeCloseTo((Number(trade.bid) + Number(trade.ask)) / 2 - (0.5 * (Number(trade.ask) - Number(trade.bid))) / 2, 4);
      expect(Number(trade.commission_dollars)).toBeCloseTo(0.68 * trade.contracts, 2);
      if (trade.expiryIso === "2026-03-13") {
        expect(trade.settledOnIso).toBe("2026-03-13");
        expect(Number(trade.settlement_close)).toBe(94);
        const expected = settlePosition({ strategyKey: trade.strategy_key, strike: Number(trade.strike), contracts: trade.contracts, premium: Number(trade.fill_price), commissionDollars: Number(trade.commission_dollars), sharePriceAtOpen: trade.share_price_at_open === null ? null : Number(trade.share_price_at_open) }, 94);
        expect(Number(trade.pnl_dollars)).toBeCloseTo(expected.pnlDollars, 0);
        expect(trade.in_the_money_at_expiry).toBe(expected.inTheMoneyAtExpiry);
      } else {
        expect(trade.settledOnIso).toBeNull();
        expect(trade.pnl_dollars).toBeNull();
      }
    }
    expect(trades.some((trade) => trade.expiryIso === "2026-03-13")).toBe(true);

    // The stored metrics are the analytics of the stored series.
    const recomputed = computeSessionMetrics(
      1_000_000,
      days.map((day) => ({ tradingDate: day.tradingDate, accountValue: Number(day.account_value), cash: Number(day.cash), exposureDollars: Number(day.exposure_dollars), interestDollars: Number(day.interest_dollars), baselineValue: Number(day.baseline_value), baselineExposureDollars: 0, baselineInterestDollars: 0, decisionSummary: day.decision_summary })),
      trades.map((trade) => ({ openedOn: trade.openedOn, settledOn: trade.settledOnIso, exposureDollars: Number(trade.exposure_dollars), pnlDollars: trade.pnl_dollars === null ? null : Number(trade.pnl_dollars), expectedPnlDollars: Number(trade.expected_pnl_dollars), calibratedExpectedPnlDollars: Number(trade.calibrated_expected_pnl_dollars), edgeMargin: Number(trade.edge_margin), inTheMoneyAtExpiry: trade.in_the_money_at_expiry }) as never),
    );
    expect(session.metrics.tradeCount).toBe(trades.length);
    expect(session.metrics.endValue).toBeCloseTo(Number(days.at(-1).account_value), 1);
    expect(session.metrics.totalReturn).toBeCloseTo(recomputed.metrics.totalReturn, 6);
    expect(session.metrics.winRate).toBeCloseTo(recomputed.metrics.winRate!, 6);
    expect(session.metrics.interestDollars).toBeCloseTo(days.reduce((sum, day) => sum + Number(day.interest_dollars), 0), 1);
    expect(session.baseline_metrics.tradeCount).toBe(0);
    // Buy and hold: ~10,000 shares bought at the first 10:00 price, marked at the last one.
    expect(session.baseline_metrics.endValue).toBeCloseTo(Number(days.at(-1).baseline_value), 1);
    expect(progressCalls.at(-1)!.done).toBe(sessionDates.length);
    expect(progressCalls.some((call) => call.label === `at ${sessionDates[0]}`)).toBe(true);
  });

  it("is re-runnable from scratch and stops on a cancel request", async () => {
    await expect(runBacktestSession(sessionId, { ...hooks, isCancelRequested: async () => true }, db)).rejects.toBeInstanceOf(BacktestCancelledError);
    // The previous run's rows were cleared before the cancelled run started.
    expect(Number((await db("backtest_session_days").where({ session_id: sessionId }).count("* as count"))[0]!.count)).toBe(0);
    await runBacktestSession(sessionId, hooks, db);
    expect(Number((await db("backtest_session_days").where({ session_id: sessionId }).count("* as count"))[0]!.count)).toBe(sessionDates.length);
  });
});
