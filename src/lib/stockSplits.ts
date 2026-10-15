import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Stock splits detected in IBKR's daily history (stock_splits; dailyBarSplitCheck.ts records them), and the guard that
// catches one IBKR's history does not show yet (Marcelo 2026-10-15). A pending split (records not yet rewritten to the
// new basis) stops the CC + Put Ladder on the ticker.

export interface StockSplit {
  tickerId: string;
  /** New shares per old share (2 for a 2-for-1, 0.1 for a 1-for-10 reverse split). */
  ratio: number;
  effectiveDateIso: string;
  recordsRewrittenAt: Date | null;
}

/** Records a detected split; the same ticker and effective date again is the same split and is not recorded twice. */
export async function recordStockSplit(split: { tickerId: string; ratio: number; effectiveDateIso: string }, connection: Knex = db): Promise<void> {
  await connection("stock_splits").insert({ ticker_id: split.tickerId, ratio: split.ratio, effective_date: split.effectiveDateIso }).onConflict(["ticker_id", "effective_date"]).ignore();
}

/** The ticker's splits whose records are not rewritten yet, oldest first. */
export async function loadPendingStockSplits(tickerIds: readonly string[], connection: Knex = db): Promise<StockSplit[]> {
  if (tickerIds.length === 0) return [];
  const rows: { tickerId: string; ratio: string; effectiveDateIso: string; recordsRewrittenAt: Date | null }[] = await connection("stock_splits")
    .whereIn("ticker_id", tickerIds)
    .whereNull("records_rewritten_at")
    .orderBy("effective_date")
    .select("ticker_id as tickerId", "ratio", connection.raw('effective_date::text as "effectiveDateIso"'), "records_rewritten_at as recordsRewrittenAt");
  return rows.map((row) => ({ tickerId: row.tickerId, ratio: Number(row.ratio), effectiveDateIso: row.effectiveDateIso, recordsRewrittenAt: row.recordsRewrittenAt }));
}

/** The split ratios the guard knows, and their reverse. 4-for-3 and 5-for-4 are left out: a 20–25% day is too common a real move. */
const knownSplitRatios = [2, 3, 4, 5, 10, 1.5].flatMap((ratio) => [ratio, 1 / ratio]);
/** How close today's price ÷ the previous close must be to a split's (1 ÷ ratio) to look like one. */
export const splitLikeMoveTolerance = 0.05;

/**
 * The split the live price suggests when no split is recorded: the price moved from the previous close by about a known
 * split's factor (2-for-1: the price about halves). Null otherwise. A real move of that size (a 50% fall) matches too,
 * which is the point: either way the ladder stops trading the ticker until a person looks.
 *
 * Example: previous close $100, price now $50.40 → 0.504, within 5% of ½ → a 2-for-1 split (ratio 2).
 */
export function splitSuggestedByPrice(stockPrice: number, previousClose: number): number | null {
  if (!(stockPrice > 0) || !(previousClose > 0)) return null;
  const move = stockPrice / previousClose;
  return knownSplitRatios.find((ratio) => Math.abs(move * ratio - 1) <= splitLikeMoveTolerance) ?? null;
}
