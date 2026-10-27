// Pure (no DB import): calendarCaptureOutcome.ts uses it too. Callers read tradingview_ticker + sector from tickers.

import { calendarDaysBetween } from "./easternIsoDate.js";

/** tickers.sector holds IBKR's literal "ETF" for every ETF (resolveSector in fetchNewTickerData.ts falls back to its stockType). */
export function isEtfSector(sector: string | null | undefined): boolean {
  return sector === "ETF";
}

export interface TickerCalendarProfile {
  /** False for an ETF: it reports no earnings, and its ex-dividend dates are not checked either (Marcelo 2026-10-10). */
  calendarChecksApply: boolean;
  /**
   * Whether the ticker's earnings dates are known. Needs a TradingView symbol (the calendar capture's key); without one the
   * dates are unknown, not clear. Always true for an ETF, which has none to know.
   */
  earningsCalendarResolved: boolean;
}

export function tickerCalendarProfile(row: { tradingview_ticker: string | null; sector: string | null } | undefined): TickerCalendarProfile {
  const isEtf = isEtfSector(row?.sector);
  return { calendarChecksApply: !isEtf, earningsCalendarResolved: isEtf || !!row?.tradingview_ticker };
}

/** A next earnings date further than this after the last report is doubtful: reports come about every 91 days, October to February runs longest (approved 2026-10-27). */
export const earningsNextDateMaxGapDays = 150;
/** No next earnings date this long after the last report is doubtful; just after a report TradingView often has none yet (approved 2026-10-27). */
export const earningsNextDateMissingAfterDays = 60;

export type EarningsNextDateDoubt = "too_far" | "missing";

/**
 * Why a ticker's next earnings date can't be trusted, or null. `lastReportIso` is the latest stored date before today (or
 * today's before-open report), `nextReportIso` the earliest still to come. With no report on record there is nothing to judge.
 */
export function earningsNextDateDoubt(lastReportIso: string | null, nextReportIso: string | null, todayIso: string): EarningsNextDateDoubt | null {
  if (lastReportIso === null) return null;
  if (nextReportIso === null) return calendarDaysBetween(lastReportIso, todayIso) > earningsNextDateMissingAfterDays ? "missing" : null;
  return calendarDaysBetween(lastReportIso, nextReportIso) > earningsNextDateMaxGapDays ? "too_far" : null;
}
