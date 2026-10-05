import { db } from "../db/connection.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { computeInFlightOrderNotional } from "../lib/orderLimits.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { positionSelect } from "../lib/positionQueries.js";

// Pluto's book: the open positions its own orders created (order_requests.pluto_action_id →
// trades.source_order_request_id → position_legs → positions) or that received shares from them
// (position_share_sources), the capital they commit against the Pluto budget, and the per-symbol
// facts the post-model gates need (last filled action for the cooldown, symbols with a working
// Pluto order).

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
  /** When the last Pluto action per symbol whose order filled (fully or partly) was taken — the ticker cooldown's clock. */
  lastFilledActionAtBySymbol: Map<string, Date>;
  /** Symbols with a Pluto order IBKR may still be working. */
  workingOrderSymbols: Set<string>;
}

/**
 * Pluto's positions: every position a Pluto order filled on, plus every position that received shares
 * from one of them (position_share_sources, followed transitively). A stock position that mixes Pluto's
 * and humans' shares counts as Pluto's whole — the budget errs towards less room (Marcelo, 2026-09-29).
 * For use after WITH RECURSIVE.
 */
export const plutoPositionIdsCte = `pluto_position_ids(id) AS (
  SELECT pl.position_id
  FROM order_requests orq
  JOIN trades tr ON tr.source_order_request_id = orq.id
  JOIN position_legs pl ON pl.id = tr.position_leg_id
  WHERE orq.pluto_action_id IS NOT NULL
  UNION
  SELECT pss.position_id
  FROM position_share_sources pss
  JOIN pluto_position_ids known ON known.id = pss.source_position_id
)`;

export async function loadPlutoBook(): Promise<PlutoBook> {
  const [positionRows, lastFilledActions, workingOrders] = await Promise.all([
    db.raw(
      `WITH RECURSIVE ${plutoPositionIdsCte}
       SELECT x.id, x.symbol, t.sector, x."strategyKey", x."capitalAtRisk"
       FROM (${positionSelect}) x
       JOIN tickers t ON t.symbol = x.symbol
       WHERE x.status = 'open' AND x.id IN (SELECT id FROM pluto_position_ids)`,
    ),
    // Read from the orders themselves, not the action's outcome, which is only written when the watcher next polls.
    db("pluto_actions as pa")
      .join("order_requests as orq", "orq.pluto_action_id", "pa.id")
      .whereExists(db("trades as tr").whereRaw("tr.source_order_request_id = orq.id"))
      .groupBy("pa.symbol")
      .select("pa.symbol")
      .max("pa.created_at as last_at"),
    db("order_requests as orq")
      .whereNotNull("orq.pluto_action_id")
      .whereIn("orq.status", activeOrderRequestStatuses)
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
    lastFilledActionAtBySymbol: new Map((lastFilledActions as { symbol: string; last_at: Date | string }[]).map((row) => [row.symbol, new Date(row.last_at)])),
    workingOrderSymbols: new Set((workingOrders as { symbol: string | null }[]).map((row) => row.symbol).filter((symbol): symbol is string => Boolean(symbol))),
  };
}

/** Statuses the order gate counts as in flight (orderLimits.ts): confirmed and not yet done. */
const inFlightOrderStatuses = ["confirmed", "submitted", "partially_filled", "cancel_requested"];

/** In-flight order notional, the order gate's way: every origin's, one symbol's, and Pluto's own. */
export async function loadInFlightNotionals(symbol: string): Promise<{ totalNotional: number; tickerNotional: number; plutoNotional: number }> {
  const rows: { request_type: string; payload: OrderRequestPayload; pluto_action_id: string | null }[] = await db("order_requests").whereIn("status", inFlightOrderStatuses).select("request_type", "payload", "pluto_action_id");
  const totals = { totalNotional: 0, tickerNotional: 0, plutoNotional: 0 };
  for (const row of rows) {
    const notional = computeInFlightOrderNotional(row.request_type, row.payload);
    totals.totalNotional += notional;
    if (row.payload.symbol === symbol) totals.tickerNotional += notional;
    if (row.pluto_action_id !== null) totals.plutoNotional += notional;
  }
  return totals;
}
