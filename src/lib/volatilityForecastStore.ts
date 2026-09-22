import { db } from "../db/connection.js";
import { selectRealizedVolatilityForecast, primaryForecastWindowDays, type RealizedVolatilityForecast } from "./volatilityEdge.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";

/** Bars needed for the primary window: 63 returns plus the prior close. */
const barsNeeded = primaryForecastWindowDays + 1;

/**
 * The volatility forecast a ticker had on a given date: Yang-Zhang over daily bars
 * up to and INCLUDING `asOfDateIso`, never later, so a back-test or a stored
 * snapshot cannot see the future. Dates are cast to text (raw `date` columns
 * shift with the server timezone when parsed).
 */
export async function loadVolatilityForecast(tickerId: string, asOfDateIso: string): Promise<RealizedVolatilityForecast | null> {
  const rows: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text <= ?", [asOfDateIso])
    .orderBy("trading_date", "desc")
    .limit(barsNeeded + 20) // a few spare rows in case some have null prices
    .select(db.raw('trading_date::text as "tradingDate"'), db.raw("open_price as open"), db.raw("high_price as high"), db.raw("low_price as low"), db.raw("close_price as close"), "volume");
  const bars: DailyOhlcvBar[] = rows
    .filter((row) => row.open !== null && row.high !== null && row.low !== null && row.close !== null)
    .reverse()
    .map((row) => ({ tradingDate: row.tradingDate, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0) }));
  return selectRealizedVolatilityForecast(bars);
}
