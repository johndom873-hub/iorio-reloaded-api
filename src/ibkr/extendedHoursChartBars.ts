import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { fetchHistoricalBarsRaw, type ChartRange, type PriceBar } from "./fetchTickerOverview.js";
import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { loadTradingSessionsBetween, regularOpenMinutesEt, type TradingSession } from "../lib/marketSessionStatus.js";
import { createExpiringPromiseCache } from "../lib/expiringPromiseCache.js";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

/**
 * The chart's 1D and 5D ranges show pre-market and after-hours bars (04:00-20:00 ET) next to the regular session.
 * They are fetched live from IBKR on each view and never stored: the intraday cache holds regular-hours bars only, and
 * the 3M hourly bars it feeds (support/resistance) must stay that way.
 */
export type ExtendedHoursChartRange = "1D" | "5D";

const extendedHoursChartConfig: Record<ExtendedHoursChartRange, { barSize: BarSizeSetting; duration: string }> = {
  "1D": { barSize: BarSizeSetting.MINUTES_ONE, duration: "2 D" },
  "5D": { barSize: BarSizeSetting.MINUTES_FIVE, duration: "7 D" },
};

export function isExtendedHoursChartRange(range: ChartRange): range is ExtendedHoursChartRange {
  return range === "1D" || range === "5D";
}

export type BarSession = "regular" | "extended";
export type SessionTaggedPriceBar = PriceBar & { session: BarSession };

/**
 * Pure: tags each bar "regular" when it starts inside its day's regular session (09:30 ET up to that day's close,
 * 13:00 on a half day), else "extended". A bar on a day missing from `sessions` (a closed day) is extended.
 */
export function tagBarSessions(bars: PriceBar[], sessions: TradingSession[]): SessionTaggedPriceBar[] {
  const closeMinutesByDate = new Map(sessions.map((session) => [session.dateIso, session.closeMinutesEt]));
  return bars.map((bar) => {
    const startsAt = new Date(bar.time * 1000);
    const closeMinutesEt = closeMinutesByDate.get(easternIsoDate(startsAt));
    const minutesEt = easternMinutesOfDay(startsAt);
    const isRegular = closeMinutesEt !== undefined && minutesEt >= regularOpenMinutesEt && minutesEt < closeMinutesEt;
    return { ...bar, session: isRegular ? "regular" : "extended" };
  });
}

export async function fetchExtendedHoursChartBars(connection: IbkrConnection, symbol: string, range: ExtendedHoursChartRange, reqId: number): Promise<SessionTaggedPriceBar[]> {
  const { barSize, duration } = extendedHoursChartConfig[range];
  const bars = await fetchHistoricalBarsRaw(connection, symbol, barSize, duration, reqId, WhatToShow.TRADES, { includeExtendedHours: true });
  if (bars.length === 0) return [];
  const sessions = await loadTradingSessionsBetween(easternIsoDate(new Date(bars[0]!.time * 1000)), easternIsoDate(new Date(bars[bars.length - 1]!.time * 1000)));
  return tagBarSessions(bars, sessions);
}

// IBKR rejects an identical historical request made within 15 seconds, so a view repeated within 30 seconds (a quick
// 1D -> 5D -> 1D, two people opening the same ticker) reuses the last answer. At most 20 answers are held (about
// 2,000 bars each), each for 30 seconds after it arrives.
const extendedHoursChartBarsCache = createExpiringPromiseCache<SessionTaggedPriceBar[]>({ ttlMs: 30_000, maxEntries: 20 });

export function cachedExtendedHoursChartBars(symbol: string, range: ExtendedHoursChartRange, load: () => Promise<SessionTaggedPriceBar[]>): Promise<SessionTaggedPriceBar[]> {
  return extendedHoursChartBarsCache.get(`${symbol}:${range}`, load);
}

/** Tests only: empties the 30 second cache between cases. */
export function clearExtendedHoursChartBarsCache(): void {
  extendedHoursChartBarsCache.clear();
}
