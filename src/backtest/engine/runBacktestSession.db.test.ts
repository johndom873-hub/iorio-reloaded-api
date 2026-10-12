import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { BacktestCancelledError, computeSessionMetrics, runBacktestSession, type BacktestRunHooks } from "./runBacktestSession.js";
import { computeParityStockPrice } from "./backtestBook.js";
import { backtestClaudeCliPathMissingMessage } from "../backtestClaudeCli.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticSymbolFile, writeSyntheticMacroEventHistory } from "./testSupport/syntheticBacktestData.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the backtest engine tests.");
}

// One session end to end against the test database: a synthetic symbol file (17 days, three weekly expiries), synthetic
// IBKR bars, a cached DTB3 series at 4% and the current model tables, with rolls switched off so the puts are held to
// their expiry. The stock falls from 100 to 94 into 13 March, so the puts sold on that expiry are assigned and their
// shares are worked with calls as it recovers; the wheel end to end, with a roll and the closes, is in
// runBacktestSessionWheel.db.test.ts.

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
  writeSyntheticMacroEventHistory(dataDirectory);

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
    .insert({ name: "engine test", symbol, start_date: sessionDates[0], end_date: sessionDates.at(-1), starting_value: 1_000_000, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings()), overrides: JSON.stringify({ policy: { roll: "never" } }) })
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
    for (const day of days) expect(day.decision_summary).toMatch(/^(Opened|Rolled|Closed|Blocked|No action)/);
    // Continuous: no day moves the account more than 5% (the trades are sized at ~5% of the account each).
    for (const day of days.slice(1)) expect(Math.abs(Number(day.daily_return))).toBeLessThan(0.05);
    // Interest over the weekend into Monday 9 March: cash before interest × 4% × 3 ÷ 365 (no settlement that day).
    const monday = dayOn("2026-03-09");
    const mondayInterest = Number(monday.interest_dollars);
    expect(mondayInterest).toBeCloseTo(((Number(monday.cash) - mondayInterest) * 0.04 * 3) / 365, 1);

    const trades = await db("backtest_trades").where({ session_id: sessionId }).orderBy("id").select(db.raw('opened_on::text as "openedOn"'), db.raw('expiry::text as "expiryIso"'), db.raw('settled_on::text as "settledOnIso"'), "*");
    expect(trades.length).toBeGreaterThanOrEqual(3);
    for (const trade of trades) {
      const contracts = Number(trade.contracts);
      const premiumDollars = Number(trade.fill_price) * 100 * contracts - Number(trade.commission_dollars);
      expect(contracts).toBeGreaterThanOrEqual(1);
      expect(Number(trade.fill_price)).toBeCloseTo((Number(trade.bid) + Number(trade.ask)) / 2 - (0.5 * (Number(trade.ask) - Number(trade.bid))) / 2, 4);
      expect(Number(trade.commission_dollars)).toBeCloseTo(0.68 * contracts, 2);
      expect(trade.leg_id).toMatch(/^leg-\d+$/);
      if (trade.expiryIso > "2026-03-20") {
        // Still open at the session's end.
        expect(trade).toMatchObject({ ended_by: null, settledOnIso: null, settlement_close: null, in_the_money_at_expiry: null, pnl_dollars: null });
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
      // It has no P&L of its own: it names its position, whose P&L for a put is the premium after the commission (the
      // shares an assignment delivered are another position of the same cycle), and its wheel cycle.
      expect(trade.pnl_dollars).toBeNull();
      expect(trade).toMatchObject({ position_status: "closed", cycle_number: 1 });
      expect(trade.position_id).toMatch(/^position-\d+$/);
      if (trade.option_right === "P") expect(Number(trade.position_pnl_dollars)).toBeCloseTo(premiumDollars, 2);
    }

    // The puts sold on 13 March finished in the money at 94: assigned, their shares bought at the strikes.
    const assignedPuts = trades.filter((trade) => trade.ended_by === "assigned" && trade.option_right === "P");
    expect(assignedPuts.length).toBeGreaterThanOrEqual(1);
    expect(assignedPuts.every((trade) => trade.expiryIso === "2026-03-13")).toBe(true);
    const sharesAssigned = assignedPuts.reduce((sum, trade) => sum + Number(trade.contracts) * 100, 0);
    const assignmentCost = assignedPuts.reduce((sum, trade) => sum + Number(trade.contracts) * 100 * Number(trade.strike), 0);
    const settlementDay = dayOn("2026-03-16");
    for (const put of assignedPuts) expect(settlementDay.decision_summary).toContain(`$${Number(put.strike)} Put · 13 Mar assigned at the 94.00 close: ${Number(put.contracts) * 100} shares bought at the strike`);
    // No fill in the look of the 13th, so Monday's cash is Friday's, plus the interest, less the shares at their strikes.
    expect(Number(settlementDay.cash)).toBeCloseTo(Number(dayOn("2026-03-13").cash) + Number(settlementDay.interest_dollars) - assignmentCost, 2);
    // With only the shares in the book, the account is the cash plus the shares at Monday's 10:00 price.
    const mondayStockPrice = computeParityStockPrice(syntheticOptionQuotes("2026-03-16", tenOClockPrice(sessionDates.indexOf("2026-03-16")), ["2026-03-20", "2026-03-27"], 0.6, ratePercent / 100, 1, 15), "2026-03-16", ratePercent / 100, null)!.price;
    expect(Number(settlementDay.account_value)).toBeCloseTo(Number(settlementDay.cash) + sharesAssigned * mondayStockPrice, 2);
    expect(Number(settlementDay.exposure_dollars)).toBeCloseTo(assignmentCost, 2);

    // The book as stored: the put positions closed assigned at 16:00 Eastern of the expiry, the shares in one
    // unstructured position that names them as its source.
    const positions = await db("backtest_positions").where({ session_id: sessionId }).orderBy("sequence");
    const legs = await db("backtest_position_legs").where({ session_id: sessionId }).orderBy("sequence").select("*", db.raw('expiry_date::text as "expiryIso"'));
    const assignedPositions = positions.filter((position) => position.strategy_key === "cash_secured_put" && position.close_reason === "assigned");
    expect(assignedPositions).toHaveLength(assignedPuts.length);
    for (const position of assignedPositions) expect(new Date(position.closed_at).toISOString()).toBe("2026-03-13T20:00:00.000Z");
    for (const put of assignedPuts) {
      const leg = legs.find((entry) => entry.leg_id === put.leg_id)!;
      expect(leg).toMatchObject({ leg_type: "option", side: "short", option_type: "put", settled_as: "assigned", expiryIso: "2026-03-13", dte_at_entry: put.dte });
      expect(Number(leg.expiry_close)).toBe(94);
      expect(Number(leg.exit_price)).toBe(0);
      expect(Number(leg.entry_price)).toBeCloseTo(Number(put.fill_price) - 0.0068, 6);
      expect(Number(leg.price_scale)).toBe(1);
      // The position's realized P&L is the premium: the shares carry what the stock did from the strike.
      expect(Number(positions.find((position) => position.position_id === leg.position_id)!.realized_pnl_dollars)).toBeCloseTo(Number(put.fill_price) * 100 * Number(put.contracts) - Number(put.commission_dollars), 2);
    }
    const assignedShares = positions.find((position) => position.unstructured_reason === "csp_assigned_stock")!;
    expect(assignedShares).toMatchObject({ strategy_key: "unstructured", share_source_position_ids: assignedPositions.map((position) => position.position_id) });
    expect(new Date(assignedShares.opened_at).toISOString()).toBe("2026-03-13T20:00:00.000Z");
    const fills = await db("backtest_fills").where({ session_id: sessionId }).orderBy("sequence");
    const assignmentFills = fills.filter((fill) => fill.instrument === "stock" && fill.action_id === null);
    expect(assignmentFills.map((fill) => ({ side: fill.side, quantity: Number(fill.quantity), price: Number(fill.price), commission: Number(fill.commission_dollars), isClosing: fill.is_closing }))).toEqual(assignedPuts.map((put) => ({ side: "buy", quantity: Number(put.contracts) * 100, price: Number(put.strike), commission: 0, isClosing: false })));

    // Every action is stored with its gates; a filled one names the positions it touched and its fills name it.
    const actions = await db("backtest_actions").where({ session_id: sessionId }).orderBy("sequence");
    const filledActions = actions.filter((action) => action.outcome === "filled");
    expect(filledActions).toHaveLength(trades.length);
    for (const action of filledActions) {
      expect(action.gate_results.length).toBeGreaterThan(0);
      expect(action.gate_results.every((gate: { ok: boolean }) => gate.ok)).toBe(true);
      expect(action.position_ids.length).toBeGreaterThanOrEqual(1);
      expect(fills.some((fill) => fill.action_id === action.action_id)).toBe(true);
    }
    const blockedActions = actions.filter((action) => action.outcome === "blocked");
    expect(blockedActions.length).toBeGreaterThanOrEqual(1);
    for (const action of blockedActions) {
      expect(action.block_reason).toMatch(/^sizing: /);
      expect(action.fill_price).toBeNull();
      expect(dayOn(new Date(action.at).toISOString().slice(0, 10)).decision_summary).toContain(`Blocked ${action.description}: sizing: `);
    }
    // The calls sold after the assignment are code's, on the held shares: no share is bought.
    const callsOnHeldShares = actions.filter((action) => action.kind === "open_covered_call" && action.outcome === "filled" && action.automatic);
    expect(callsOnHeldShares.length).toBeGreaterThanOrEqual(1);
    for (const action of callsOnHeldShares) {
      expect(action.description).toContain(`on ${sharesAssigned} held shares`);
      expect(action.chosen_because).toMatch(/^code sells calls on held shares: the highest premium yield, \d+% a year; if called away the cycle ends \$\d+$/);
      expect(fills.filter((fill) => fill.action_id === action.action_id).map((fill) => fill.instrument)).toEqual(["option"]);
    }

    // The wheel cycle assigned on the 13th ends when code's call on its shares is assigned; the next one opens on the
    // 23rd. Together their totals are the positions' realized and unrealized P&L.
    const cycles = await db("backtest_cycles").where({ session_id: sessionId }).orderBy("cycle_number").select("*", db.raw('opened_on::text as "openedOn"'), db.raw('assigned_on::text as "assignedOn"'));
    expect(cycles.map((cycle) => [cycle.cycle_number, cycle.status, cycle.openedOn, cycle.assignedOn])).toEqual([
      [1, "closed", trades[0].openedOn, "2026-03-13"],
      [2, "open", "2026-03-23", null],
    ]);
    expect(cycles[0]).toMatchObject({ data_flags: [] });
    expect(Number(cycles[0].shares_held)).toBe(0);
    expect(cycles.reduce((sum, cycle) => sum + Number(cycle.total_dollars), 0)).toBeCloseTo(positions.reduce((sum, position) => sum + Number(position.realized_pnl_dollars) + Number(position.unrealized_pnl_dollars ?? 0), 0), 1);

    // The stored metrics are the analytics of the stored series.
    const recomputed = computeSessionMetrics(
      1_000_000,
      days.map((day) => ({ tradingDate: day.tradingDate, accountValue: Number(day.account_value), cash: Number(day.cash), exposureDollars: Number(day.exposure_dollars), interestDollars: Number(day.interest_dollars), baselineValue: Number(day.baseline_value), baselineExposureDollars: 0, baselineInterestDollars: 0, spyBaselineValue: day.spy_baseline_value === null ? null : Number(day.spy_baseline_value), spyBaselineExposureDollars: null, spyBaselineInterestDollars: null, decisionSummary: day.decision_summary, looksRun: day.looks_run, actionsTaken: day.actions_taken })),
      trades.map((trade) => ({ symbol: trade.symbol, cycleNumber: trade.cycle_number, edgeMargin: Number(trade.edge_margin), expectedPnlDollars: Number(trade.expected_pnl_dollars), calibratedExpectedPnlDollars: Number(trade.calibrated_expected_pnl_dollars), inTheMoneyAtExpiry: trade.in_the_money_at_expiry }) as never),
      cycles.map((cycle) => ({ symbol: cycle.symbol, cycleNumber: cycle.cycle_number, status: cycle.status, totalDollars: Number(cycle.total_dollars) }) as never),
    );
    expect(session.metrics.tradeCount).toBe(trades.length);
    expect(session.metrics.endValue).toBeCloseTo(Number(days.at(-1).account_value), 1);
    expect(session.metrics.totalReturn).toBeCloseTo(recomputed.metrics.totalReturn, 6);
    // Two wheel cycles, the first closed at a profit: a win rate of 1 out of 1.
    expect(session.metrics).toMatchObject({ cycleCount: 2, closedCycleCount: 1, winRate: 1 });
    expect(recomputed.metrics).toMatchObject({ cycleCount: 2, closedCycleCount: 1, winRate: 1 });
    expect(session.pnl_basis).toBe("wheel_cycle");
    // The test tables hold no SPY prices: no SPY baseline, and the session says so.
    expect(session.spy_baseline_metrics).toBeNull();
    expect(recomputed.spyBaselineMetrics).toBeNull();
    expect(days.every((day) => day.spy_baseline_value === null)).toBe(true);
    expect(session.notes).toContain("Buy and hold of SPY (comparison only) is not shown: the local DB has no SPY price for the session's days (npm run backtest:backfill-market-stress-bars).");
    expect(session.metrics.interestDollars).toBeCloseTo(days.reduce((sum, day) => sum + Number(day.interest_dollars), 0), 1);
    expect(session.baseline_metrics.tradeCount).toBe(0);
    // Buy and hold: ~10,000 shares bought at the first 10:00 price, marked at the last one.
    expect(session.baseline_metrics.endValue).toBeCloseTo(Number(days.at(-1).baseline_value), 1);
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

  it("refuses the AI model as decision maker while BACKTEST_CLAUDE_CLI_PATH is unset", async () => {
    const claudeCliPathBefore = process.env.BACKTEST_CLAUDE_CLI_PATH;
    delete process.env.BACKTEST_CLAUDE_CLI_PATH;
    try {
      await db("backtest_sessions").where({ id: sessionId }).update({ overrides: JSON.stringify({ decisionMaker: "llm" }) });
      await expect(runBacktestSession(sessionId, hooks, db)).rejects.toThrow(backtestClaudeCliPathMissingMessage);
    } finally {
      if (claudeCliPathBefore !== undefined) process.env.BACKTEST_CLAUDE_CLI_PATH = claudeCliPathBefore;
    }
  });
});
