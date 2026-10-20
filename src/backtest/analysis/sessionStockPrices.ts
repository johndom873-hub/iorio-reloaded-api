import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileIntradayPrices } from "../backtestFileStockBars.js";
import { readSplitScheduleCache, splitFactorOn } from "../engine/splitFactors.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { loadDailyBarsOf } from "./analysisFigures.js";
import { toOhlcvBars } from "./analysisPriceFigures.js";

// A session symbol's stock prices day by day, read from its data file and IBKR daily bars when the screen asks (Marcelo
// 2026-10-20): the Wheel cycles' Price (the 10:00 price a look saw, or the close an assignment, hand-over or mark used)
// and B&H (close to close on split-adjusted closes, as the Idle rows' stock move).

export interface BacktestSessionStockPrices {
  symbol: string;
  /**
   * The trading day before the session's first, then every day to its last: [date, the 10:00 price as traded, the close
   * as traded, the split-adjusted close]; a price null when not known (no bar, or a day the split factor is unresolved).
   */
  days: [string, number | null, number | null, number | null][];
}

const roundedPrice = (value: number) => Math.round(value * 10_000) / 10_000;

export async function loadBacktestSessionStockPrices(sessionId: string, symbol: string, connection: Knex = db): Promise<BacktestSessionStockPrices> {
  const session: { start_date: string; end_date: string; symbol: string; symbols: string[] | null } | undefined = await connection("backtest_sessions")
    .where({ id: sessionId })
    .first(connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "symbol", "symbols");
  if (!session) throw new BacktestRequestError("No such session.", 404);
  const symbols = Array.isArray(session.symbols) && session.symbols.length > 0 ? session.symbols : [session.symbol];
  if (!symbols.includes(symbol)) throw new BacktestRequestError(`The session does not trade ${symbol}.`, 400);
  const bars = toOhlcvBars((await loadDailyBarsOf(symbol, connection)).bars);
  const firstIndex = bars.findIndex((bar) => bar.tradingDate >= session.start_date);
  const shown = firstIndex === -1 ? [] : bars.slice(Math.max(0, firstIndex - 1)).filter((bar) => bar.tradingDate <= session.end_date);
  if (shown.length === 0) return { symbol, days: [] };
  const dataDirectory = readBacktestDataDirectory();
  const schedule = dataDirectory ? (readSplitScheduleCache(dataDirectory, symbol)?.schedule ?? null) : null;
  const file = openBacktestDataFileReadOnly(symbol);
  let intraday: ReturnType<typeof readFileIntradayPrices> = null;
  try {
    if (file) intraday = readFileIntradayPrices(file, shown[0]!.tradingDate, shown.at(-1)!.tradingDate);
  } finally {
    file?.close();
  }
  return {
    symbol,
    days: shown.map((bar) => {
      const factor = schedule === null ? 1 : splitFactorOn(schedule, bar.tradingDate);
      const tenOclock = intraday?.priceAt(bar.tradingDate, "10:00") ?? null;
      return [bar.tradingDate, factor === null || tenOclock === null ? null : roundedPrice(tenOclock * factor), factor === null ? null : roundedPrice(bar.close * factor), bar.close];
    }),
  };
}
