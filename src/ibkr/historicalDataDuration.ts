// IBKR's duration strings for historical-data requests.

/** IBKR's duration for daily bars reaching back to `startDateIso` (whole years: longer durations must be in years). */
export function historyDurationReaching(startDateIso: string, now: Date): string {
  const years = (now.getTime() - Date.parse(`${startDateIso}T00:00:00Z`)) / (365.25 * 86_400_000);
  return `${Math.max(1, Math.ceil(years))} Y`;
}
