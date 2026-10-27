import { db } from "../db/connection.js";
import { longForecastWindowDays, selectModelVolatilityForecast, type ModelVolatilityForecast } from "./volatilityForecast.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";

/** Bars needed for the longest window: 63 returns plus the prior close. */
const barsNeeded = longForecastWindowDays + 1;

export interface VolatilityForecasts {
  /** The valuation model's forecast (YZ21 per session), what Pluto acts on. */
  model: ModelVolatilityForecast | null;
  /** YZ63, no fallback: the Signals screen's FV 63d (display only). */
  yangZhang63: ModelVolatilityForecast | null;
}

/**
 * The volatility forecasts a ticker had on a given date: Yang-Zhang over daily bars up to and INCLUDING `asOfDateIso`,
 * never later, so a back-test or a stored snapshot cannot see the future; and never on or after `todayEasternIso`,
 * because a bar for a session still in progress (any intraday daily-bar fetch writes one) is a partial day. Dates are
 * cast to text (raw `date` columns shift with the server timezone when parsed).
 */
export async function loadVolatilityForecasts(tickerId: string, asOfDateIso: string, todayEasternIso: string): Promise<VolatilityForecasts> {
  const rows: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text <= ?", [asOfDateIso])
    .whereRaw("trading_date::text < ?", [todayEasternIso])
    .orderBy("trading_date", "desc")
    .limit(barsNeeded + 20) // a few spare rows in case some have null prices
    .select(db.raw('trading_date::text as "tradingDate"'), db.raw("open_price as open"), db.raw("high_price as high"), db.raw("low_price as low"), db.raw("close_price as close"), "volume");
  const bars: DailyOhlcvBar[] = rows
    .filter((row) => row.open !== null && row.high !== null && row.low !== null && row.close !== null)
    .reverse()
    .map((row) => ({ tradingDate: row.tradingDate, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0) }));
  return { model: selectModelVolatilityForecast(bars), yangZhang63: selectModelVolatilityForecast(bars, longForecastWindowDays) };
}
