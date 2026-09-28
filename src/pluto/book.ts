import { db } from "../db/connection.js";
import { positionSelect } from "../lib/positionQueries.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";

// Pluto's book: the open positions its own orders created (order_requests.pluto_action_id →
// trades.source_order_request_id → position_legs → positions), the capital they commit against
// the Pluto budget, and the per-symbol facts the post-model gates need (last action date for
// the cooldown, symbols with a working Pluto order).

export interface PlutoBookPosition {
  positionId: string;
  symbol: string;
  sector: string | null;
  strategyKey: string;
  capitalAtRisk: number;
}

export interface PlutoBook {
  openPositions: PlutoBookPosition[];
  committedDollars: number;
  openSymbols: Set<string>;
  /** Eastern date of the last Pluto action per symbol that reached IBKR (built or beyond). */
  lastActionDateBySymbol: Map<string, string>;
  /** Symbols with a Pluto order IBKR may still be working. */
  workingOrderSymbols: Set<string>;
}

export async function loadPlutoBook(): Promise<PlutoBook> {
  const [positionRows, lastActions, workingOrders] = await Promise.all([
    db.raw(
      `SELECT x.id, x.symbol, t.sector, x."strategyKey", x."capitalAtRisk"
       FROM (${positionSelect}) x
       JOIN tickers t ON t.symbol = x.symbol
       WHERE x.status = 'open' AND x.id IN (
         SELECT DISTINCT pl.position_id
         FROM order_requests orq
         JOIN trades tr ON tr.source_order_request_id = orq.id
         JOIN position_legs pl ON pl.id = tr.position_leg_id
         WHERE orq.pluto_action_id IS NOT NULL
       )`,
    ),
    db("pluto_actions")
      .whereIn("outcome", ["order_built", "confirmed", "filled", "partially_filled", "cancelled", "rejected", "error"])
      .groupBy("symbol")
      .select("symbol")
      .max("created_at as last_at"),
    db("order_requests as orq")
      .whereNotNull("orq.pluto_action_id")
      .whereIn("orq.status", ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"])
      .select(db.raw("orq.payload->>'symbol' as symbol")),
  ]);
  const openPositions: PlutoBookPosition[] = (positionRows.rows as { id: string; symbol: string; sector: string | null; strategyKey: string; capitalAtRisk: string | null }[]).map((row) => ({
    positionId: row.id,
    symbol: row.symbol,
    sector: row.sector,
    strategyKey: row.strategyKey,
    capitalAtRisk: Number(row.capitalAtRisk ?? 0),
  }));
  return {
    openPositions,
    committedDollars: openPositions.reduce((sum, position) => sum + position.capitalAtRisk, 0),
    openSymbols: new Set(openPositions.map((position) => position.symbol)),
    lastActionDateBySymbol: new Map((lastActions as { symbol: string; last_at: Date | string }[]).map((row) => [row.symbol, easternDateIso(new Date(row.last_at))])),
    workingOrderSymbols: new Set((workingOrders as { symbol: string | null }[]).map((row) => row.symbol).filter((symbol): symbol is string => Boolean(symbol))),
  };
}
