import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { BacktestTickerSuitability } from "./backtestTypes.js";

// Each downloaded ticker's suitability for the CC + Put Ladder and its note (Marcelo 2026-10-19). No row: Pending; a
// "pending" row: Pending with a note. The window marks a ticker Suitable or Unsuitable only (there is no way back to
// Pending). Only who changed it last and when are kept.

/** What the route lets an admin mark a ticker. */
export const tickerSuitabilityMarks = ["suitable", "unsuitable"] as const;
export const tickerSuitabilityNoteMaxLength = 5000;

type Row = { symbol: string; status: BacktestTickerSuitability["status"]; note: string; updated_at: Date; updated_by_name: string | null };

const toSuitability = (row: Row): BacktestTickerSuitability => ({ status: row.status, note: row.note, updatedAt: new Date(row.updated_at).toISOString(), updatedByName: row.updated_by_name });

const selectRows = (connection: Knex) =>
  connection("backtest_ticker_suitability as s").leftJoin("users as u", "u.id", "s.updated_by_user_id").select("s.symbol", "s.status", "s.note", "s.updated_at", "u.display_name as updated_by_name");

export async function loadTickerSuitabilityBySymbol(connection: Knex = db): Promise<Record<string, BacktestTickerSuitability>> {
  const rows: Row[] = await selectRows(connection);
  return Object.fromEntries(rows.map((row) => [row.symbol, toSuitability(row)]));
}

export async function loadTickerSuitability(symbol: string, connection: Knex = db): Promise<BacktestTickerSuitability | null> {
  const row: Row | undefined = await selectRows(connection).where("s.symbol", symbol).first();
  return row ? toSuitability(row) : null;
}

/** Marks `symbol` (already normalized) with `status` and `note`, the note trimmed. */
export async function saveTickerSuitability(input: { symbol: string; status: BacktestTickerSuitability["status"]; note: string; userId: string | null }, connection: Knex = db): Promise<BacktestTickerSuitability> {
  await connection("backtest_ticker_suitability")
    .insert({ symbol: input.symbol, status: input.status, note: input.note.trim(), updated_at: connection.fn.now(), updated_by_user_id: input.userId })
    .onConflict("symbol")
    .merge();
  const row: Row = await selectRows(connection).where("s.symbol", input.symbol).first();
  return toSuitability(row);
}
