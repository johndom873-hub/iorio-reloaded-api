import { db } from "../db/connection.js";

export interface TickerRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
}

/** A ticker by symbol (case-insensitive), or null. */
export async function loadTickerBySymbol(symbol: string): Promise<TickerRow | null> {
  const row = await db("tickers")
    .where("symbol", symbol.toUpperCase())
    .select("id as tickerId", "symbol", "company_name as companyName", db.raw("NULLIF(sector, '') as sector"))
    .first();
  return row ?? null;
}
