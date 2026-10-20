import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { loadAccountInShares, loadAnalysisLadder, tooLargeDaysOf, type AnalysisBacktestFigures } from "./analysisBacktest.js";
import { loadDailyBarsOf, type AnalysisFigures } from "./analysisFigures.js";
import { loadAnalysisOrders } from "./analysisPotSizing.js";
import { maxDrawdownByRange, toOhlcvBars } from "./analysisPriceFigures.js";

// A session's "Price and Max drawdown" chart (Marcelo 2026-10-20): the Analyse window's price chart over the session's
// period, with that session's ladder levels, rungs sold and orders over one strike.

export interface BacktestSessionPriceChart {
  symbol: string;
  /** IBKR daily bars from the session's first day to its last, split-adjusted: [date, open, high, low, close, implied volatility]. */
  bars: AnalysisFigures["bars"];
  /** Of those bars, each range counted back from the last. */
  maxDrawdown: AnalysisFigures["maxDrawdown"];
  ladderLevels: AnalysisBacktestFigures["ladderLevels"];
  ladderRungsSold: AnalysisBacktestFigures["ladderRungsSold"];
  tooLargeDays: AnalysisBacktestFigures["tooLargeDays"];
  /** Null in a session of more than one symbol: the account's shares are every symbol's. */
  accountInShares: AnalysisBacktestFigures["accountInShares"] | null;
}

export async function loadBacktestSessionPriceChart(sessionId: string, symbol: string, connection: Knex = db): Promise<BacktestSessionPriceChart> {
  const session: { start_date: string; end_date: string; symbol: string; symbols: string[] | null } | undefined = await connection("backtest_sessions")
    .where({ id: sessionId })
    .first(connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "symbol", "symbols");
  if (!session) throw new BacktestRequestError("No such session.", 404);
  const symbols = Array.isArray(session.symbols) && session.symbols.length > 0 ? session.symbols : [session.symbol];
  if (!symbols.includes(symbol)) throw new BacktestRequestError(`The session does not trade ${symbol}.`, 400);
  const [{ bars: dailyBars }, orders, ladder, accountInShares] = await Promise.all([
    loadDailyBarsOf(symbol, connection),
    loadAnalysisOrders(sessionId, symbol, connection),
    loadAnalysisLadder(sessionId, symbol, connection),
    symbols.length === 1 ? loadAccountInShares(sessionId, connection) : null,
  ]);
  const bars = toOhlcvBars(dailyBars).filter((bar) => bar.tradingDate >= session.start_date && bar.tradingDate <= session.end_date);
  return {
    symbol,
    bars: bars.map((bar) => [bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.impliedVolatility]),
    maxDrawdown: maxDrawdownByRange(bars),
    ...ladder,
    tooLargeDays: tooLargeDaysOf(orders),
    accountInShares,
  };
}
