/**
 * IBKR historical bars can carry a fractional volume (seen 2026-09-22 on BMNR and DELL: "134.5"),
 * but daily_price_bars.volume and intraday_price_bars.volume are bigint, so the whole insert
 * failed and the ticker's 5-year backfill ended 'partial'. Round to a whole number; a missing or
 * non-finite volume becomes null.
 */
export function normalizeBarVolume(volume: number | null | undefined): number | null {
  if (volume === null || volume === undefined || !Number.isFinite(volume)) return null;
  return Math.max(0, Math.round(volume));
}
