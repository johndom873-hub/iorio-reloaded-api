import { easternInstant } from "../../lib/easternIsoDate.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { longForecastWindowDays } from "../../lib/volatilityForecast.js";
import type { ValuationGroup } from "../../lib/volatilityModelTables.js";
import { backtestCaptureLookTimeEt } from "../backtestTypes.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";

// What a backtest day knows of a ticker at 10:00 ET (docs/backtesting/FORMULAS.md): its profile and earnings calendar as
// known that day, the day's 10:00 market from its data file, and the instants of the day's looks.

/** Rows loadVolatilityForecasts reads. */
export const forecastBarRowCount = longForecastWindowDays + 1 + 20;
const decisionTimeEt = { hour: 10, minute: 0 };

export interface BacktestTickerProfile {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  valuationGroup: ValuationGroup;
  /** False for an ETF: no earnings or ex-dividend checks (tickerCalendarProfile). */
  calendarChecksApply: boolean;
  earningsCalendarResolved: boolean;
  /** Ascending. event_time "-1" = before the open. */
  earnings: { dateIso: string; eventTime: string | null }[];
  /** Ascending. */
  exDividends: { dateIso: string; amount: number | null }[];
}

export interface BacktestDayMarket {
  todayIso: string;
  /** Every 10:00 quote of the day in the file. */
  quotes: readonly SymbolFileQuote[];
  /** The previous session's full volume, by contractKey; null when the file has no previous session. */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** The 10:00 stock price (IBKR's 09:30 bar's close, on the day's traded scale). */
  stockPrice: number;
  /** DTB3 known at 10:00 (the latest observation before today), percent. */
  riskFreeRatePercent: number | null;
}

/** The 10:00 look: the capture's own time. */
export const captureLookTimeEt = backtestCaptureLookTimeEt;

export function decisionInstantMs(todayIso: string): number {
  return easternInstant(todayIso, decisionTimeEt.hour, decisionTimeEt.minute).getTime();
}

/** The instant of a look ("HH:MM" Eastern) on a day. */
export function lookInstantMs(todayIso: string, lookTimeEt: string): number {
  const [hour, minute] = lookTimeEt.split(":").map(Number) as [number, number];
  return easternInstant(todayIso, hour, minute).getTime();
}

/**
 * How far ahead a backtest day knows an earnings date (Marcelo 2026-10-12). The stored calendar holds every report of
 * the period, but a company announces its date some weeks before: a date is known to a day (the baseline's skip of
 * expiries spanning it) only from this many calendar days before it.
 */
export const earningsDateKnownCalendarDaysAhead = 30;

/** The earnings dates known on a day: up to earningsDateKnownCalendarDaysAhead calendar days after it. */
export function earningsKnownOn(earnings: BacktestTickerProfile["earnings"], todayIso: string): BacktestTickerProfile["earnings"] {
  const lastKnownDateIso = addCalendarDays(todayIso, earningsDateKnownCalendarDaysAhead);
  return earnings.filter((event) => event.dateIso <= lastKnownDateIso);
}

/**
 * Earnings an expiry must not span on a day: the dates known that day (earningsKnownOn) from today on, except a report
 * today before the open (as live's loadNextEarningsDate).
 */
export function earningsNotYetReported(earnings: BacktestTickerProfile["earnings"], todayIso: string): string[] {
  return earningsKnownOn(earnings, todayIso)
    .filter((event) => event.dateIso >= todayIso && !(event.dateIso === todayIso && event.eventTime === "-1"))
    .map((event) => event.dateIso);
}
