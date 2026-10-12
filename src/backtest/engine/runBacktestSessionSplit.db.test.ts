import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { runBacktestSession, type BacktestRunHooks } from "./runBacktestSession.js";
import { readSplitScheduleCache } from "./splitFactors.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticSymbolFile, writeSyntheticMacroEventHistory } from "./testSupport/syntheticBacktestData.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the backtest engine tests.");
}

// A 2-for-1 split inside a session: the option file is as traded (≈ $100 before 9 March, ≈ $49 after), IBKR's bars are
// split-adjusted (≈ $50 throughout). The engine must infer F = 2 before the split and 1 after, put every bar price on the
// day's traded scale, keep the wheel cycle that began before the split on its own scale (its options become twice the
// contracts on half the shares each, its later sales are today's contracts put on that scale), and value buy and hold
// continuously. Rolls are off so the options sold before the split are held to their expiry.

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
  writeSyntheticMacroEventHistory(dataDirectory);

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
    .insert({ name: "engine split test", symbol, start_date: sessionDates[0], end_date: sessionDates.at(-1), starting_value: 1_000_000, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings({ maxTickerExposurePct: 30 })), overrides: JSON.stringify({ policy: { roll: "never" } }) })
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
    const legs = await db("backtest_position_legs").where({ session_id: sessionId }).orderBy("sequence");
    const fills = await db("backtest_fills").where({ session_id: sessionId }).orderBy("sequence");
    const legOf = (trade: { leg_id: string }) => legs.find((leg) => leg.leg_id === trade.leg_id)!;
    const heldAcross = trades.filter((trade) => trade.openedOn < firstDayAfterSplit && trade.expiryIso === "2026-03-13");
    expect(heldAcross.length).toBeGreaterThanOrEqual(2);
    const settlementClose = adjustedClose(sessionDates.indexOf("2026-03-13")) * 2;
    for (const trade of heldAcross) {
      // Strike on the old scale (≈ $100), settled at IBKR's adjusted close of 13 March × F(cycle) = 48 × 2.
      expect(Number(trade.strike)).toBeGreaterThan(80);
      expect(trade.settledOnIso).toBe("2026-03-13");
      expect(Number(trade.settlement_close)).toBeCloseTo(settlementClose, 4);
      const inTheMoneyBy = trade.option_right === "P" ? Number(trade.strike) - settlementClose : settlementClose - Number(trade.strike);
      expect(trade.ended_by).toBe(inTheMoneyBy >= 0.01 ? "assigned" : "expired_worthless");
      // The split made it twice the contracts, each on 50 of the cycle's shares; the strike and the premium stay as sold.
      const leg = legOf(trade);
      expect(Number(leg.quantity)).toBe(Number(trade.contracts) * 2);
      expect(Number(leg.multiplier)).toBe(50);
      expect(Number(leg.strike_price)).toBe(Number(trade.strike));
      expect(Number(leg.price_scale)).toBe(1);
      expect(Number(leg.entry_price) * Number(leg.quantity) * Number(leg.multiplier)).toBeCloseTo(Number(trade.fill_price) * 100 * Number(trade.contracts) - Number(trade.commission_dollars), 2);
    }
    const settlementDay = days.find((day) => day.tradingDate === "2026-03-16")!;
    expect(settlementDay.decision_summary).toContain("held across a split (×2)");
    // A put assigned after the split delivers its shares on the cycle's scale: 100 a contract at the strike as sold, which
    // the day's note gives as traded (twice the shares at half the strike).
    const assignedPut = heldAcross.find((trade) => trade.ended_by === "assigned" && trade.option_right === "P")!;
    const assignmentFill = fills.find((fill) => fill.instrument === "stock" && fill.action_id === null)!;
    expect(assignmentFill).toMatchObject({ side: "buy", is_closing: false });
    expect(Number(assignmentFill.quantity)).toBe(Number(assignedPut.contracts) * 100);
    expect(Number(assignmentFill.price)).toBe(Number(assignedPut.strike));
    expect(Number(assignmentFill.price_scale)).toBe(2);
    expect(settlementDay.decision_summary).toContain(`$${Number(assignedPut.strike) / 2} Put · 13 Mar assigned at the 48.00 close: ${Number(assignedPut.contracts) * 200} shares bought at the strike`);

    // A sale after the split, in the cycle that began before it: the trade is as traded that day (≈ $48 strikes, 100
    // shares a contract), its leg on the cycle's scale (twice the prices, 50 of the cycle's shares a contract).
    const afterSplit = trades.filter((entry) => entry.openedOn >= firstDayAfterSplit);
    expect(afterSplit.length).toBeGreaterThanOrEqual(1);
    for (const trade of afterSplit) {
      expect(Number(trade.strike)).toBeLessThan(60);
      const leg = legOf(trade);
      expect(Number(leg.strike_price)).toBeCloseTo(Number(trade.strike) * 2, 6);
      expect(Number(leg.quantity)).toBe(Number(trade.contracts));
      expect(Number(leg.multiplier)).toBe(50);
      expect(Number(leg.price_scale)).toBe(2);
      const fill = fills.find((entry) => entry.leg_id === trade.leg_id && !entry.is_closing)!;
      expect(Number(fill.price) / Number(fill.price_scale)).toBeCloseTo(Number(trade.fill_price), 6);
      expect(Number(fill.price) * Number(fill.quantity) * Number(fill.multiplier)).toBeCloseTo(Number(trade.fill_price) * 100 * Number(trade.contracts), 4);
    }

    // One cycle through the split, its shares counted on its own scale (half of what is held as traded today).
    const cycles = await db("backtest_cycles").where({ session_id: sessionId });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", data_flags: [] });
    const sharesHeld = legs.filter((leg) => leg.leg_type === "stock" && leg.exit_at === null).reduce((sum, leg) => sum + Number(leg.quantity), 0);
    expect(Number(cycles[0].shares_held)).toBe(sharesHeld);
    expect(sharesHeld).toBeGreaterThanOrEqual(Number(assignedPut.contracts) * 100);
    // With the account marked on today's prices: cash + the shares at the last 10:00 price − the open options at their mids.
    const lastDay = days.at(-1)!;
    expect(Number(lastDay.account_value) - Number(lastDay.cash)).toBeCloseTo(sharesHeld * 2 * tradedPrices.at(-1)!, -2);
  }, 60_000);
});
