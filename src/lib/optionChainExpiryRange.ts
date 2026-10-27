// The expiries the stored option chain keeps a strike grid for (0-90 DTE, approved 2026-09-21, confirmed 2026-09-23), and
// the calendar-day count every reader of a chain uses to place an expiry in it.

export const storedChainMinimumDaysToExpiry = 0;
export const storedChainMaximumDaysToExpiry = 90;

const millisecondsPerDay = 24 * 60 * 60 * 1000;

/**
 * Calendar days from an ISO trading date (YYYY-MM-DD, Eastern) to an IBKR
 * expiry (YYYYMMDD). Both are read as plain dates (UTC midnight), so DST and
 * the machine's timezone cannot shift the answer. Negative for a past expiry.
 */
export function calendarDaysUntilExpiry(todayIso: string, expiryYyyymmdd: string): number {
  const expiryIso = `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
  return Math.round((Date.parse(`${expiryIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / millisecondsPerDay);
}
