import { db } from "../db/connection.js";
import { activeShortlistTickerIdsQuery } from "./shortlistQueries.js";
import { excludeTickersBeingPrepared } from "./tickersBeingPrepared.js";

export interface OptionDataTicker {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  contractId: number | null;
}

/**
 * The tickers whose options the platform tracks (Marcelo 2026-10-27, replacing the Signals universe): every active
 * Shortlist entry plus every ticker with an open position other than a hedge (a hedge alone is managed at IBKR). The
 * 09:00 UTC chain structure refresh skips tickers still being set up (excludeBeingPrepared); the Volatility screen lists them.
 */
export async function loadOptionDataUniverse(options: { excludeBeingPrepared?: boolean } = {}): Promise<OptionDataTicker[]> {
  const rows: { tickerId: string; symbol: string; companyName: string | null; contractId: string | number | null }[] = await db("tickers as t")
    .where((builder) => {
      const shortlisted = builder.whereIn("t.id", activeShortlistTickerIdsQuery());
      if (options.excludeBeingPrepared) excludeTickersBeingPrepared(shortlisted, "t.id");
    })
    .orWhereIn("t.id", db("positions").where({ status: "open" }).whereNotIn("strategy_key", ["hedge", "leaps"]).select("ticker_id"))
    .select("t.id as tickerId", "t.symbol", "t.company_name as companyName", "t.ibkr_contract_id as contractId")
    .orderBy("t.symbol");
  return rows.map((row) => ({ tickerId: row.tickerId, symbol: row.symbol, companyName: row.companyName, contractId: row.contractId === null ? null : Number(row.contractId) }));
}
