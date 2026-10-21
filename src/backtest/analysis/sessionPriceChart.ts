import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { loadAnalysisLadder, tooLargeDaysOf, type AnalysisBacktestFigures } from "./analysisBacktest.js";
import { loadDailyBarsOf, type AnalysisFigures } from "./analysisFigures.js";
import { loadAnalysisOrders } from "./analysisPotSizing.js";
import { maxDrawdownByRange, toOhlcvBars } from "./analysisPriceFigures.js";
import { loadCashAvailableByDay, type CashAvailableByDay } from "./sessionFreeCash.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { cachedSplitsBetween } from "../engine/splitFactors.js";
import type { BacktestDetectedSplit } from "../backtestTypes.js";

// A session's "Price and Max drawdown" chart (Marcelo 2026-10-20): the Analyse window's price chart over the session's
// period, with that session's ladder levels, rungs sold and orders over one strike, and its Cash available under the candles.

export interface BacktestSessionPriceChart {
  symbol: string;
  /** IBKR daily bars from the session's first day to its last, split-adjusted: [date, open, high, low, close, implied volatility]. */
  bars: AnalysisFigures["bars"];
  /** Of those bars, each range counted back from the last. */
  maxDrawdown: AnalysisFigures["maxDrawdown"];
  ladderLevels: AnalysisBacktestFigures["ladderLevels"];
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
  const [{ bars: dailyBars }, orders, ladder, cashAvailable] = await Promise.all([
    loadDailyBarsOf(symbol, connection),
    loadAnalysisOrders(sessionId, symbol, connection),
    loadAnalysisLadder(sessionId, symbol, connection),
    loadCashAvailableByDay(sessionId, connection),
  ]);
  const bars = toOhlcvBars(dailyBars).filter((bar) => bar.tradingDate >= session.start_date && bar.tradingDate <= session.end_date);
  return {
    symbol,
    bars: bars.map((bar) => [bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.impliedVolatility]),
    maxDrawdown: maxDrawdownByRange(bars),
    ...ladder,
    tooLargeDays: tooLargeDaysOf(orders),
    cashAvailable,
    splits: cachedSplitsBetween(readBacktestDataDirectory(), symbol, session.start_date, session.end_date) ?? [],
  };
}
