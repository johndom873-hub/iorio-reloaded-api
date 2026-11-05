import { db } from "../db/connection.js";
import type { BookKey } from "./bookKeys.js";
import { loadBooksCutover, loadConfirmedLedgerCutOffAt, loadLedgerCashByBook, loadProvisionalCashMovements } from "./bookLedger.js";
import { bookOfLegAt, loadTickerBookPeriods } from "./tickerBookPeriods.js";

// Each book's value at the nightly P&L snapshot (Marcelo 2026-11-05): cash (confirmed + since the last statement) plus
// its open legs at that night's closing prices, the same prices the position snapshots use. Read by Pluto's daily-loss
// breaker and pots, the pro-rata splits and the Dashboard's per-book history.

export interface ClosingLegValue {
  positionId: string;
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  /** That night's closing price; null falls back to the entry price. */
  closingPrice: number | null;
  entryPrice: number;
}

export async function writeBookValueSnapshots(snapshotDate: string, legs: readonly ClosingLegValue[], now: Date = new Date()): Promise<Record<BookKey, number> | null> {
  const cutover = await loadBooksCutover();
  if (!cutover) return null;
  const periods = await loadTickerBookPeriods();
  const confirmedThrough = await loadConfirmedLedgerCutOffAt(cutover);
  const positionIds = [...new Set(legs.map((leg) => leg.positionId))];
  const [ledgerCash, provisional, positions] = await Promise.all([
    loadLedgerCashByBook(null),
    loadProvisionalCashMovements(confirmedThrough, periods),
    positionIds.length === 0 ? Promise.resolve([]) : (db("positions").whereIn("id", positionIds).select("id", "ticker_id", "strategy_key") as Promise<{ id: string; ticker_id: string; strategy_key: string }[]>),
  ]);
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const cash: Record<BookKey, number> = { pluto: ledgerCash.pluto, manual: ledgerCash.manual };
  for (const movement of provisional) cash[movement.book] += movement.amount;
  const positionsValue: Record<BookKey, number> = { pluto: 0, manual: 0 };
  for (const leg of legs) {
    const position = positionById.get(leg.positionId);
    if (!position) continue;
    const price = leg.closingPrice ?? leg.entryPrice;
    positionsValue[bookOfLegAt(periods, position.ticker_id, position.strategy_key, now)] += price * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1);
  }
  const rows = [
    { snapshot_date: snapshotDate, book_key: "pluto", cash: cash.pluto, positions_value: positionsValue.pluto, book_value: cash.pluto + positionsValue.pluto, captured_at: now },
    { snapshot_date: snapshotDate, book_key: "manual", cash: cash.manual, positions_value: positionsValue.manual, book_value: cash.manual + positionsValue.manual, captured_at: now },
    { snapshot_date: snapshotDate, book_key: "unallocated", cash: ledgerCash.unallocated, positions_value: 0, book_value: ledgerCash.unallocated, captured_at: now },
  ];
  await db("book_value_snapshots").insert(rows).onConflict(["snapshot_date", "book_key"]).merge();
  return { pluto: rows[0]!.book_value, manual: rows[1]!.book_value };
}
