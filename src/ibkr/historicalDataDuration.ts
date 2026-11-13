// IBKR's duration strings for historical-data requests.

/**
 * The first day of a ticker's full daily history, the Price Performance Drawdown's peak window (Marcelo 2026-11-13):
 * IBKR's daily bars leave splits before about 2006 unadjusted (INTC's 2:1 of 2000-07-31 reads as a 48% fall, NOK's 4:1
 * of 2000-04-11 as 75%), and its implied volatility starts in 2006. IBKR returns less for a listing it holds from later.
 */
export const fullDailyHistoryStartDate = "2006-01-01";

/** A request reaching back years can take most of a minute (SPY from 1999: 46 s); a short one keeps the default. */
export const fullDailyHistoryRequestTimeoutMs = 120_000;

/** IBKR's duration for daily bars reaching back to `startDateIso` (whole years: longer durations must be in years). */
export function historyDurationReaching(startDateIso: string, now: Date): string {
  const years = (now.getTime() - Date.parse(`${startDateIso}T00:00:00Z`)) / (365.25 * 86_400_000);
  return `${Math.max(1, Math.ceil(years))} Y`;
}

/** The duration of a full daily history request: back to fullDailyHistoryStartDate. */
export function fullDailyHistoryDuration(now: Date): string {
  return historyDurationReaching(fullDailyHistoryStartDate, now);
}
