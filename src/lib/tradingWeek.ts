/**
 * Whether `todayIso` is the last session before a weekend (Marcelo 2026-11-02: Vol Farmer v4's buyback before weekends
 * only, in the lab and in Pluto): the next session falls in the following week, a Friday or the Thursday before a Friday
 * holiday; with no next session known, whether today is a Friday.
 */
export function isLastSessionBeforeWeekend(todayIso: string, nextSessionIso: string | undefined | null): boolean {
  const weekday = (dateIso: string) => new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  if (nextSessionIso === undefined || nextSessionIso === null) return weekday(todayIso) === 5;
  return weekday(nextSessionIso) <= weekday(todayIso);
}
