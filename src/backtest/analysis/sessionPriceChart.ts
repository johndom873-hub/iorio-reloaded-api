import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { loadAnalysisLadder, tooLargeDaysOf, type AnalysisBacktestFigures } from "./analysisBacktest.js";
import { loadDailyBarsOf, type AnalysisFigures } from "./analysisFigures.js";
import { loadAnalysisOrders } from "./analysisPotSizing.js";
import { barIndicatorsOf, maxDrawdownByRange, sliceBarIndicators, toOhlcvBars, type AnalysisBarIndicators } from "./analysisPriceFigures.js";
import { loadCashAvailableByDay, type CashAvailableByDay } from "./sessionFreeCash.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { cachedSplitsBetween } from "../engine/splitFactors.js";
import type { BacktestDetectedSplit } from "../backtestTypes.js";

// A session's "Price and Max drawdown" chart (Marcelo 2026-10-20): the Analyse window's price chart over the session's
// period, with that session's ladder levels, rungs sold and orders over one strike, and its Cash available under the candles.
// Vol Farmer v2 sessions add both positions' break-evens (B-E, B-E2) and their LEAPS bought, sold and expired (2026-10-27).

/** A LEAPS Call bought, sold or expired (at its expiry, worthless or at its intrinsic value), as traded. */
export interface SessionLeapsEvent {
  date: string;
  kind: "bought" | "sold" | "expired";
  contracts: number;
  strike: number;
  expiry: string;
  /** Per share: the fill, or 0 for one that expired worthless. */
  price: number;
}

export interface BacktestSessionPriceChart {
  symbol: string;
  /** IBKR daily bars from the session's first day to its last, split-adjusted: [date, open, high, low, close, implied volatility]. */
  bars: AnalysisFigures["bars"];
  /** Of those bars, each range counted back from the last. */
  maxDrawdown: AnalysisFigures["maxDrawdown"];
  /** One per bar, worked out over the whole file: the first day has its look-back even when the file starts earlier. */
  barIndicators: AnalysisBarIndicators;
  ladderLevels: AnalysisBacktestFigures["ladderLevels"];
  /** Vol Farmer v2: [date, B-E, B-E2] after each 10:00 look, split-adjusted; null while that position holds no shares. Empty for other sessions. */
  breakEvenLevels: [string, number | null, number | null][];
  /** Vol Farmer v2: its LEAPS Calls' purchases and ends, by date. */
  leapsEvents: SessionLeapsEvent[];
  ladderRungsSold: AnalysisBacktestFigures["ladderRungsSold"];
  tooLargeDays: AnalysisBacktestFigures["tooLargeDays"];
  /** The whole account's free cash each day at its 10:00 marks (sessionFreeCash.ts), every symbol's in a session of several. */
  cashAvailable: CashAvailableByDay;
  /** The symbol's splits in the session's period (the bars before one are its traded prices ÷ the ratio); empty when none or not yet analysed. */
  splits: BacktestDetectedSplit[];
}

export async function loadBacktestSessionPriceChart(sessionId: string, symbol: string, connection: Knex = db): Promise<BacktestSessionPriceChart> {
  const session: { start_date: string; end_date: string; symbol: string; symbols: string[] | null } | undefined = await connection("backtest_sessions")
    .where({ id: sessionId })
    .first(connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "symbol", "symbols");
  if (!session) throw new BacktestRequestError("No such session.", 404);
  const symbols = Array.isArray(session.symbols) && session.symbols.length > 0 ? session.symbols : [session.symbol];
  if (!symbols.includes(symbol)) throw new BacktestRequestError(`The session does not trade ${symbol}.`, 400);
  const [{ bars: dailyBars }, orders, ladder, cashAvailable, breakEvenLevels, leapsEvents] = await Promise.all([
    loadDailyBarsOf(symbol, connection),
    loadAnalysisOrders(sessionId, symbol, connection),
    loadAnalysisLadder(sessionId, symbol, connection),
    loadCashAvailableByDay(sessionId, connection),
    loadBreakEvenLevels(sessionId, symbol, connection),
    loadLeapsEvents(sessionId, symbol, connection),
  ]);
  const allBars = toOhlcvBars(dailyBars);
  const from = Math.max(0, allBars.findIndex((bar) => bar.tradingDate >= session.start_date));
  const bars = allBars.slice(from).filter((bar) => bar.tradingDate >= session.start_date && bar.tradingDate <= session.end_date);
  return {
    symbol,
    bars: bars.map((bar) => [bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.impliedVolatility]),
    maxDrawdown: maxDrawdownByRange(bars),
    barIndicators: sliceBarIndicators(barIndicatorsOf(allBars), from, from + bars.length - 1),
    ...ladder,
    breakEvenLevels,
    leapsEvents,
    tooLargeDays: tooLargeDaysOf(orders),
    cashAvailable,
    splits: cachedSplitsBetween(readBacktestDataDirectory(), symbol, session.start_date, session.end_date) ?? [],
  };
}

/** Both positions' break-evens of a Vol Farmer v2 session, split-adjusted by each day's recorded factor. */
async function loadBreakEvenLevels(sessionId: string, symbol: string, connection: Knex): Promise<BacktestSessionPriceChart["breakEvenLevels"]> {
  const rows: { date: string; split_factor: string; first_break_even: string | null; second_break_even: string | null }[] = await connection("backtest_break_even_levels")
    .where({ session_id: sessionId, symbol })
    .orderBy("trading_date")
    .select(connection.raw("trading_date::text as date"), "split_factor", "first_break_even", "second_break_even");
  const adjusted = (value: string | null, splitFactor: string) => (value === null ? null : Math.round((Number(value) / Number(splitFactor)) * 100) / 100);
  return rows.map((row) => [row.date, adjusted(row.first_break_even, row.split_factor), adjusted(row.second_break_even, row.split_factor)]);
}

/** A Vol Farmer v2 session's LEAPS: each purchase, and each end (an exit on or after its expiry date is the expiry). */
async function loadLeapsEvents(sessionId: string, symbol: string, connection: Knex): Promise<SessionLeapsEvent[]> {
  const legs: { entry_date: string; exit_date: string | null; expiry: string; strike: string; quantity: string; entry_price: string; exit_price: string | null }[] = await connection("backtest_position_legs as l")
    .join("backtest_positions as p", (join) => join.on("p.session_id", "l.session_id").andOn("p.position_id", "l.position_id"))
    .where({ "p.session_id": sessionId, "p.symbol": symbol, "p.strategy_key": "leaps", "l.leg_type": "option" })
    .orderBy("l.entry_at")
    .select(
      connection.raw("((l.entry_at AT TIME ZONE 'America/New_York')::date)::text as entry_date"),
      connection.raw("((l.exit_at AT TIME ZONE 'America/New_York')::date)::text as exit_date"),
      connection.raw("l.expiry_date::text as expiry"),
      "l.strike_price as strike",
      "l.quantity",
      "l.entry_price",
      "l.exit_price",
    );
  const events: SessionLeapsEvent[] = [];
  for (const leg of legs) {
    const contract = { contracts: Number(leg.quantity), strike: Number(leg.strike), expiry: leg.expiry };
    events.push({ date: leg.entry_date, kind: "bought", ...contract, price: Number(leg.entry_price) });
    if (leg.exit_date === null) continue;
    const expired = leg.exit_date >= leg.expiry;
    events.push({ date: expired ? leg.expiry : leg.exit_date, kind: expired ? "expired" : "sold", ...contract, price: Number(leg.exit_price ?? 0) });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
