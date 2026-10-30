import type { Knex } from "knex";
import { db } from "../db/connection.js";

// The CC + Put Ladder's live band quotes (option_quote_band_quotes): written by the Day Signals loop, read by the ladder's
// look and by the band's next selection (each contract's last-seen implied volatility). Each ticker's newest finished cycle
// (option_quote_band_cycles) says from when on the looks read them.

export interface OptionQuoteBandQuoteWrite {
  tickerId: string;
  tradingDateIso: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  stockPrice: number | null;
  errorCode: number | null;
  quotedAt: Date;
  cycleNumber: number;
}

export type OptionQuoteBandQuote = Omit<OptionQuoteBandQuoteWrite, "tickerId" | "tradingDateIso">;

export async function upsertOptionQuoteBandQuotes(writes: readonly OptionQuoteBandQuoteWrite[], connection: Knex = db): Promise<void> {
  if (writes.length === 0) return;
  await connection("option_quote_band_quotes")
    .insert(writes.map((write) => ({ ticker_id: write.tickerId, trading_date: write.tradingDateIso, expiry: write.expiry, strike: write.strike, option_right: write.right, bid: write.bid, ask: write.ask, stock_price: write.stockPrice, error_code: write.errorCode, quoted_at: write.quotedAt, cycle_number: write.cycleNumber })))
    .onConflict(["ticker_id", "trading_date", "expiry", "strike", "option_right"])
    .merge();
}

/** The ticker's latest quote of each contract today. */
export async function loadOptionQuoteBandQuotes(tickerId: string, tradingDateIso: string, connection: Knex = db): Promise<OptionQuoteBandQuote[]> {
  const rows: { expiry: string; strike: string; right: "C" | "P"; bid: string | null; ask: string | null; stockPrice: string | null; errorCode: number | null; quotedAt: Date; cycleNumber: number }[] = await connection("option_quote_band_quotes")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text = ?", [tradingDateIso])
    .select(connection.raw("expiry::text as expiry"), "strike", connection.raw('option_right as "right"'), "bid", "ask", "stock_price as stockPrice", "error_code as errorCode", "quoted_at as quotedAt", "cycle_number as cycleNumber");
  const toNumber = (value: string | null) => (value === null ? null : Number(value));
  return rows.map((row) => ({ expiry: row.expiry, strike: Number(row.strike), right: row.right, bid: toNumber(row.bid), ask: toNumber(row.ask), stockPrice: toNumber(row.stockPrice), errorCode: row.errorCode, quotedAt: new Date(row.quotedAt), cycleNumber: row.cycleNumber }));
}

/** A ticker's newest finished band cycle today. */
export interface OptionQuoteBandCycle {
  cycleNumber: number;
  /** When the cycle began quoting options: each of its quotes is stamped later. */
  startedAt: Date;
  finishedAt: Date;
}

export interface OptionQuoteBandCycleWrite extends OptionQuoteBandCycle {
  tickerId: string;
  tradingDateIso: string;
}

/** Each ticker's newest finished cycle, written once all of the cycle's quotes are stored; an older cycle never replaces a newer one. */
export async function recordFinishedOptionQuoteBandCycles(writes: readonly OptionQuoteBandCycleWrite[], connection: Knex = db): Promise<void> {
  if (writes.length === 0) return;
  await connection("option_quote_band_cycles")
    .insert(writes.map((write) => ({ ticker_id: write.tickerId, trading_date: write.tradingDateIso, cycle_number: write.cycleNumber, started_at: write.startedAt, finished_at: write.finishedAt })))
    .onConflict(["ticker_id", "trading_date"])
    .merge()
    .whereRaw("option_quote_band_cycles.started_at < excluded.started_at");
}

/** The ticker's newest finished band cycle today; null before its first one finishes. */
export async function loadFinishedOptionQuoteBandCycle(tickerId: string, tradingDateIso: string, connection: Knex = db): Promise<OptionQuoteBandCycle | null> {
  const row: { cycleNumber: number; startedAt: Date; finishedAt: Date } | undefined = await connection("option_quote_band_cycles")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text = ?", [tradingDateIso])
    .first("cycle_number as cycleNumber", "started_at as startedAt", "finished_at as finishedAt");
  return row ? { cycleNumber: row.cycleNumber, startedAt: new Date(row.startedAt), finishedAt: new Date(row.finishedAt) } : null;
}
