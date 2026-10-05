import { db } from "../db/connection.js";

// Which tickers the morning capture re-captures (approved 2026-09-30). A ticker is judged from what is
// stored after the fit, not from the UI's "Unscored" badge: a ticker that is unscored only because
// every fitted expiry spans earnings would never improve on a retry.

/** Each ticker is captured once, then re-captured at most twice: 3 attempts in all. */
export const captureAttemptsPerTicker = 3;
/** One pause before each retry round of the whole queue (not per ticker), so a still-violent market has time to settle. */
export const captureRetryDelayMs = 30_000;

export interface CaptureRetryCandidateRow {
  symbol: string;
  /** Null when the ticker has no snapshot for the date (the run stopped before reaching it). */
  snapshotStatus: string | null;
  okExpiryCount: number;
  /** Expiries the fit had points for: everything except "insufficient_points" (a thin chain a retry cannot fix). */
  fittableExpiryCount: number;
}

/** Retry when there is no usable snapshot, or when fewer than half of the fittable expiries fitted "ok". */
export function selectSymbolsToRetry(rows: CaptureRetryCandidateRow[]): string[] {
  return rows
    .filter((row) => {
      if (row.snapshotStatus === null || row.snapshotStatus === "failed") return true;
      return row.fittableExpiryCount > 0 && row.okExpiryCount * 2 < row.fittableExpiryCount;
    })
    .map((row) => row.symbol);
}

export async function loadCaptureRetryCandidateRows(tradingDate: string, tickers: { tickerId: string; symbol: string }[]): Promise<CaptureRetryCandidateRow[]> {
  if (tickers.length === 0) return [];
  const { rows } = await db.raw(
    `
    SELECT
      t.symbol,
      h.status AS "snapshotStatus",
      COUNT(f.id) FILTER (WHERE f.status = 'ok')::int AS "okExpiryCount",
      COUNT(f.id) FILTER (WHERE f.status <> 'insufficient_points')::int AS "fittableExpiryCount"
    FROM tickers t
    LEFT JOIN option_chain_snapshots h ON h.ticker_id = t.id AND h.trading_date::text = ?
    LEFT JOIN option_surface_fits f ON f.snapshot_id = h.id
    WHERE t.id = ANY(?)
    GROUP BY t.symbol, h.status
    ORDER BY t.symbol
    `,
    [tradingDate, tickers.map((ticker) => ticker.tickerId)],
  );
  return rows;
}
