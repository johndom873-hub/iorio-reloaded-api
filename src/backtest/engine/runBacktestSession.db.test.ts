import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { BacktestCancelledError, computeSessionMetrics, runBacktestSession, type BacktestRunHooks } from "./runBacktestSession.js";
import { retiredBacktestDecisionMakerMessage } from "../backtestTypes.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the backtest engine tests.");
}

// One session end to end against the test database: a synthetic symbol file (17 days, three weekly expiries), synthetic
// IBKR bars, a cached DTB3 series at 4% and the current model tables, the baseline wheel deciding: cash-secured puts held
// to their expiry, calls on any shares they bring. The stock falls from 100 to 94 into 13 March and recovers after.

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `BTE${Date.now() % 100000}`;
const sessionDates = weekdaysBetween("2026-03-02", "2026-03-24");
const closes = [100.5, 99.8, 99.0, 98.2, 97.5, 96.9, 96.0, 95.2, 94.6, 94.0, 95.0, 95.5, 96.2, 96.0, 96.4, 96.8, 97.0];
const closeOn = (dateIso: string) => closes[sessionDates.indexOf(dateIso)]!;
const expiries = ["2026-03-13", "2026-03-20", "2026-03-27"];
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
  writeSyntheticIbkrBarsFromQuotes(path.join(dataDirectory, `${symbol}.sqlite`), [...history, ...sessionBars], ratePercent);

  const [session] = await db("backtest_sessions")
    .insert({ name: "engine test", symbol, start_date: sessionDates[0], end_date: sessionDates.at(-1), starting_value: 1_000_000, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings()), overrides: JSON.stringify({ decisionMaker: "baseline" }) })
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
  it("replays every day on the ledger, settles the options at their expiry closes and stores the book and the metrics", async () => {
    await runBacktestSession(sessionId, hooks, db);

    const session = await db("backtest_sessions").where({ id: sessionId }).first();
    expect(session.status).toBe("succeeded");
    expect(session.finished_at).not.toBeNull();
    const dataLastDate = await db("backtest_sessions").where({ id: sessionId }).first(db.raw("data_last_date::text as d"));
    expect(dataLastDate.d).toBe(sessionDates.at(-1));

    const days = await db("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(db.raw('trading_date::text as "tradingDate"'), "*");
    const dayOn = (dateIso: string) => days.find((day) => day.tradingDate === dateIso)!;
    expect(days.map((day) => day.tradingDate)).toEqual(sessionDates);
    expect(Number(days[0].account_value)).toBeCloseTo(1_000_000, 2);
    expect(Number(days[0].baseline_value)).toBeCloseTo(1_000_000, 2);
    expect(days[0].daily_return).toBeNull();
    expect(Number(days[0].interest_dollars)).toBe(0);
    // Interest over the weekend into Monday 9 March: cash before interest × 4% × 3 ÷ 365.
    const monday = dayOn("2026-03-09");
    const mondayInterest = Number(monday.interest_dollars);
    expect(mondayInterest).toBeCloseTo(((Number(monday.cash) - mondayInterest) * 0.04 * 3) / 365, 1);

    const trades = await db("backtest_trades").where({ session_id: sessionId }).orderBy("id").select(db.raw('opened_on::text as "openedOn"'), db.raw('expiry::text as "expiryIso"'), db.raw('settled_on::text as "settledOnIso"'), "*");
    expect(trades.length).toBeGreaterThanOrEqual(1);
    for (const trade of trades) {
      const contracts = Number(trade.contracts);
      expect(contracts).toBeGreaterThanOrEqual(1);
      // Sold at the mid less half the half-spread (spread cost share 50%), $0.68 a contract.
      expect(Number(trade.fill_price)).toBeCloseTo((Number(trade.bid) + Number(trade.ask)) / 2 - (0.5 * (Number(trade.ask) - Number(trade.bid))) / 2, 4);
      expect(Number(trade.commission_dollars)).toBeCloseTo(0.68 * contracts, 2);
      expect(trade.leg_id).toMatch(/^leg-\d+$/);
      // The baseline has no Signals model: no grade or Edge figures.
      expect(trade).toMatchObject({ grade: null, edge_margin: null, expected_pnl_dollars: null, edge_yield: null });
      if (trade.expiryIso > "2026-03-23") {
        // Still open at the session's end.
        expect(trade).toMatchObject({ ended_by: null, settledOnIso: null, settlement_close: null, in_the_money_at_expiry: null });
        continue;
      }
      // Held to its expiry and settled on that day's close: in the money by a cent or more is assigned.
      const close = closeOn(trade.expiryIso);
      const intrinsic = trade.option_right === "P" ? Number(trade.strike) - close : close - Number(trade.strike);
      const assigned = intrinsic >= 0.01;
      expect(trade.settledOnIso).toBe(trade.expiryIso);
      expect(Number(trade.settlement_close)).toBe(close);
      expect(trade.in_the_money_at_expiry).toBe(assigned);
      expect(trade.ended_by).toBe(assigned ? "assigned" : "expired_worthless");
      expect(trade.position_id).toMatch(/^position-\d+$/);
    }

    // Every filled action names the positions it touched, and its fills name it.
    const actions = await db("backtest_actions").where({ session_id: sessionId }).orderBy("sequence");
    const fills = await db("backtest_fills").where({ session_id: sessionId }).orderBy("sequence");
    for (const action of actions.filter((entry) => entry.outcome === "filled")) {
      expect(action.position_ids.length).toBeGreaterThanOrEqual(1);
      expect(fills.some((fill) => fill.action_id === action.action_id)).toBe(true);
    }

    // The wheel cycles' totals are the positions' realized and unrealized P&L.
    const positions = await db("backtest_positions").where({ session_id: sessionId }).orderBy("sequence");
    const cycles = await db("backtest_cycles").where({ session_id: sessionId }).orderBy("cycle_number");
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    for (const cycle of cycles) expect(cycle.data_flags).toEqual([]);
    expect(cycles.reduce((sum, cycle) => sum + Number(cycle.total_dollars), 0)).toBeCloseTo(positions.reduce((sum, position) => sum + Number(position.realized_pnl_dollars) + Number(position.unrealized_pnl_dollars ?? 0), 0), 1);

    // The stored metrics are the analytics of the stored series.
    const recomputed = computeSessionMetrics(
      1_000_000,
      days.map((day) => ({ tradingDate: day.tradingDate, accountValue: Number(day.account_value), cash: Number(day.cash), exposureDollars: Number(day.exposure_dollars), sharesValueDollars: Number(day.shares_value_dollars), interestDollars: Number(day.interest_dollars), baselineValue: Number(day.baseline_value), baselineExposureDollars: 0, baselineInterestDollars: 0, spyBaselineValue: day.spy_baseline_value === null ? null : Number(day.spy_baseline_value), spyBaselineExposureDollars: null, spyBaselineInterestDollars: null, decisionSummary: day.decision_summary, looksRun: day.looks_run, actionsTaken: day.actions_taken })),
      trades.map((trade) => ({ symbol: trade.symbol, cycleNumber: trade.cycle_number, edgeMargin: null, expectedPnlDollars: null, calibratedExpectedPnlDollars: null, inTheMoneyAtExpiry: trade.in_the_money_at_expiry }) as never),
      cycles.map((cycle) => ({ symbol: cycle.symbol, cycleNumber: cycle.cycle_number, status: cycle.status, totalDollars: Number(cycle.total_dollars) }) as never),
    );
    expect(session.metrics.tradeCount).toBe(trades.length);
    expect(session.metrics.endValue).toBeCloseTo(Number(days.at(-1).account_value), 1);
    expect(session.metrics.totalReturn).toBeCloseTo(recomputed.metrics.totalReturn, 6);
    expect(session.pnl_basis).toBe("wheel_cycle");
    // The test tables hold no SPY prices: no SPY baseline, and the session says so.
    expect(session.spy_baseline_metrics).toBeNull();
    expect(days.every((day) => day.spy_baseline_value === null)).toBe(true);
    expect(session.notes).toContain("Buy and hold of SPY (comparison only) is not shown: the local DB has no SPY price for the session's days (npm run backtest:backfill-market-stress-bars).");
    expect(session.metrics.interestDollars).toBeCloseTo(days.reduce((sum, day) => sum + Number(day.interest_dollars), 0), 1);
    expect(session.baseline_metrics.tradeCount).toBe(0);
    expect(session.baseline_metrics.endValue).toBeCloseTo(Number(days.at(-1).baseline_value), 1);
    // Pluto's system checks ran with the retired rules only.
    expect(session.run_statistics).toMatchObject({ dailyLossBreakerTripDates: [], marketStressLooks: 0, daysWithoutMarketStressBars: 0 });
    expect(progressCalls.at(-1)!.done).toBe(sessionDates.length);
    expect(progressCalls.some((call) => call.label === `at ${sessionDates[0]}`)).toBe(true);
  }, 60_000);

  it("is re-runnable from scratch and stops on a cancel request", async () => {
    await expect(runBacktestSession(sessionId, { ...hooks, isCancelRequested: async () => true }, db)).rejects.toBeInstanceOf(BacktestCancelledError);
    // The previous run's rows were cleared before the cancelled run started.
    for (const table of ["backtest_session_days", "backtest_trades", "backtest_positions", "backtest_position_legs", "backtest_fills", "backtest_actions", "backtest_cycles"]) expect(Number((await db(table).where({ session_id: sessionId }).count("* as count"))[0]!.count)).toBe(0);
    await runBacktestSession(sessionId, hooks, db);
    expect(Number((await db("backtest_session_days").where({ session_id: sessionId }).count("* as count"))[0]!.count)).toBe(sessionDates.length);
  }, 60_000);

  it("never runs a past rules or AI model session again: it refuses, and the stored results stay as they are", async () => {
    const storedDays = Number((await db("backtest_session_days").where({ session_id: sessionId }).count("* as count"))[0]!.count);
    expect(storedDays).toBe(sessionDates.length);
    for (const overrides of [{ decisionMaker: "rules" }, { decisionMaker: "llm" }, {}]) {
      // An empty overrides on a snapshot without a decision maker is a session from before the choice: the rules'.
      await db("backtest_sessions").where({ id: sessionId }).update({ overrides: JSON.stringify(overrides) });
      await expect(runBacktestSession(sessionId, hooks, db)).rejects.toThrow(retiredBacktestDecisionMakerMessage);
      expect(Number((await db("backtest_session_days").where({ session_id: sessionId }).count("* as count"))[0]!.count)).toBe(storedDays);
      expect((await db("backtest_sessions").where({ id: sessionId }).first("status")).status).toBe("succeeded");
    }
  });
});
