import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { stockAcquisitionByPositionIdFromRecords, type StockAcquisition } from "./stockAcquisitionTracing.js";

export type { StockAcquisition };

// What shares really traded at when a position holds shares it did not buy itself (Marcelo 2026-10-16: a Covered Call
// written on shares already held shows the price those shares were bought at, a share-weighted average when they came
// from several positions; IBKR's confirmed execution prices, assigned shares at the strike). A stock leg with opening
// fills of its own covering its shares shows those (positionQueries.ts openingFillPrice); this follows the hand-overs
// (position_share_sources) back to the fills, or to the strike of the put that delivered the shares.

/** The acquisition behind each given position's shares, for those whose shares can be traced; others are absent. */
export async function fetchStockAcquisitionByPositionId(positionIds: string[], database: Knex = db): Promise<Map<string, StockAcquisition>> {
  if (positionIds.length === 0) return new Map();

  // The whole hand-over graph of the positions' tickers, read once.
  const tickerIds = database("positions").whereIn("id", positionIds).select("ticker_id");
  const [fillRows, sourceRows, putRows] = await Promise.all([
    database("trades as tr")
      .join("position_legs as pl", "pl.id", "tr.position_leg_id")
      .join("positions as p", "p.id", "pl.position_id")
      .whereIn("p.ticker_id", tickerIds)
      .where({ "pl.leg_type": "stock", "tr.is_closing_trade": false, "tr.side": "buy" })
      .select("pl.position_id as positionId", "tr.quantity", "tr.price", "tr.commission"),
    database("position_share_sources as pss")
      .join("positions as p", "p.id", "pss.position_id")
      .whereIn("p.ticker_id", tickerIds)
      .select("pss.position_id as positionId", "pss.source_position_id as sourcePositionId", "pss.shares_received as sharesReceived"),
    database("position_legs as pl")
      .join("positions as p", "p.id", "pl.position_id")
      .whereIn("p.ticker_id", tickerIds)
      .where({ "p.strategy_key": "cash_secured_put", "p.close_reason": "assigned", "pl.leg_type": "option", "pl.option_type": "put", "pl.side": "short" })
      .select("p.id as positionId", "pl.strike_price as strike", "pl.quantity", "pl.multiplier"),
  ]);
  return stockAcquisitionByPositionIdFromRecords(positionIds, {
    buyFills: (fillRows as { positionId: string; quantity: string; price: string; commission: string | null }[]).map((row) => ({
      positionId: row.positionId,
      quantity: Number(row.quantity),
      price: Number(row.price),
      commission: row.commission === null ? null : Number(row.commission),
    })),
    shareSources: (sourceRows as { positionId: string; sourcePositionId: string; sharesReceived: number | null }[]).map((row) => ({
      positionId: row.positionId,
      sourcePositionId: row.sourcePositionId,
      sharesReceived: row.sharesReceived === null ? null : Number(row.sharesReceived),
    })),
    assignedPuts: (putRows as { positionId: string; strike: string; quantity: number; multiplier: number }[]).map((row) => ({ positionId: row.positionId, strike: Number(row.strike), quantity: Number(row.quantity), multiplier: Number(row.multiplier) })),
  });
}

