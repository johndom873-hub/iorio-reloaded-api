import { db } from "../db/connection.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { computeInFlightOrderNotional } from "../lib/orderLimits.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { positionSelect } from "../lib/positionQueries.js";
import type { OccupiedContract } from "./candidateFilters.js";

// Pluto's book (Marcelo, 2026-10-07): every open position on a ticker Pluto is enabled on, whoever opened it, except hedges
// (Pluto has no way to act on a long option). An enabled ticker is Pluto's to manage (2026-10-06), so all of it counts toward
// Pluto's capital budget and its position cap; switching a ticker off hands every position on it, Pluto's own included, back
// to people. Also the per-symbol facts the post-model gates need (last filled action for the cooldown, symbols with a working
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
  /** Which of openPositions a Pluto order opened; the rest were opened by a person. */
  plutoOpenedPositionIds: Set<string>;
  committedDollars: number;
  openSymbols: Set<string>;
  /** When the last Pluto action per symbol whose order filled (fully or partly) was taken — the ticker cooldown's clock. */
  lastFilledActionAtBySymbol: Map<string, Date>;
  /** Symbols with a Pluto order IBKR may still be working. */
  workingOrderSymbols: Set<string>;
}

/**
 * Positions a Pluto order opened: every position a Pluto order filled on, plus every position that received shares from one
 * of them (position_share_sources, followed transitively). Only labels a managed position "opened by Pluto" for the model and
 * the screen; the budget counts every managed position either way. For use after WITH RECURSIVE.
 */
export const plutoOpenedPositionIdsCte = `pluto_opened_position_ids(id) AS (
  SELECT pl.position_id
  FROM order_requests orq
  JOIN trades tr ON tr.source_order_request_id = orq.id
  JOIN position_legs pl ON pl.id = tr.position_leg_id
  WHERE orq.pluto_action_id IS NOT NULL AND NOT tr.is_closing_trade
  UNION
  SELECT pss.position_id
  FROM position_share_sources pss
  JOIN pluto_opened_position_ids known ON known.id = pss.source_position_id
)`;

/** Strategies that never count in Pluto's book. */
export const strategiesOutsidePlutoBook = ["hedge"];

export async function loadPlutoBook(): Promise<PlutoBook> {
  const [positionRows, plutoOpenedRows, lastFilledActions, workingOrders] = await Promise.all([
    db.raw(
      `SELECT x.id, x.symbol, t.sector, x."strategyKey", x."capitalAtRisk"
       FROM (${positionSelect}) x
       JOIN tickers t ON t.symbol = x.symbol
       JOIN shortlist_entries se ON se.ticker_id = t.id AND se.removed_at IS NULL AND se.bot_enabled
       WHERE x.status = 'open' AND NOT (x."strategyKey" = ANY(?::text[]))`,
      [strategiesOutsidePlutoBook],
    ),
    db.raw(`WITH RECURSIVE ${plutoOpenedPositionIdsCte} SELECT id FROM pluto_opened_position_ids`),
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
    plutoOpenedPositionIds: new Set((plutoOpenedRows.rows as { id: string }[]).map((row) => row.id).filter((id) => openPositions.some((position) => position.positionId === id))),
    committedDollars: openPositions.reduce((sum, position) => sum + position.capitalAtRisk, 0),
    openSymbols: new Set(openPositions.map((position) => position.symbol)),
    lastFilledActionAtBySymbol: new Map((lastFilledActions as { symbol: string; last_at: Date | string }[]).map((row) => [row.symbol, new Date(row.last_at)])),
    workingOrderSymbols: new Set((workingOrders as { symbol: string | null }[]).map((row) => row.symbol).filter((symbol): symbol is string => Boolean(symbol))),
  };
}

/** Statuses the order gate counts as in flight (orderLimits.ts): confirmed and not yet done. */
const inFlightOrderStatuses = ["confirmed", "submitted", "partially_filled", "cancel_requested"];

/**
 * In-flight order notional, the order gate's way: every origin's, one symbol's, and the book's — Pluto's own orders plus anyone's
 * on an enabled ticker (Marcelo, 2026-10-07: an order there joins Pluto's book the moment it fills).
 */
export async function loadInFlightNotionals(symbol: string): Promise<{ totalNotional: number; tickerNotional: number; managedNotional: number }> {
  const [rows, enabledRows]: [{ request_type: string; payload: OrderRequestPayload; pluto_action_id: string | null }[], { symbol: string }[]] = await Promise.all([
    db("order_requests").whereIn("status", inFlightOrderStatuses).select("request_type", "payload", "pluto_action_id"),
    db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").where("se.bot_enabled", true).select("t.symbol"),
  ]);
  const enabledSymbols = new Set(enabledRows.map((row) => row.symbol));
  const totals = { totalNotional: 0, tickerNotional: 0, managedNotional: 0 };
  for (const row of rows) {
    const notional = computeInFlightOrderNotional(row.request_type, row.payload);
    totals.totalNotional += notional;
    if (row.payload.symbol === symbol) totals.tickerNotional += notional;
    if (row.pluto_action_id !== null || enabledSymbols.has(row.payload.symbol)) totals.managedNotional += notional;
  }
  return totals;
}

function describeContract(symbol: string, expiry: string, strike: number, right: string | null): string {
  const kind = right === "call" || right === "C" ? "call" : right === "put" || right === "P" ? "put" : "option";
  return `${symbol} ${expiry} $${strike} ${kind}`;
}

/**
 * Every contract on the symbol already taken: open option legs (anyone's, human or Pluto) and the option legs of
 * orders still active (any origin). Expiry as YYYY-MM-DD, the way candidates carry it.
 */
/** Whether any of these tickers has an open position (an automatic close may be due on it). */
export async function anyOpenPositionOn(symbols: string[]): Promise<boolean> {
  if (symbols.length === 0) return false;
  const row = await db("positions as p").join("tickers as t", "t.id", "p.ticker_id").where("p.status", "open").whereIn("t.symbol", symbols).first("p.id");
  return Boolean(row);
}

export async function loadOccupiedContracts(symbol: string): Promise<OccupiedContract[]> {
  const [legs, orders] = await Promise.all([
    db("position_legs as pl")
      .join("positions as p", "p.id", "pl.position_id")
      .join("tickers as t", "t.id", "p.ticker_id")
      .where("t.symbol", symbol)
      .where("pl.leg_type", "option")
      .whereNull("pl.exit_at")
      .select(db.raw("to_char(pl.expiry_date, 'YYYY-MM-DD') as expiry"), "pl.strike_price as strike", "pl.option_type as right"),
    db("order_requests").whereIn("status", activeOrderRequestStatuses).whereRaw("payload->>'symbol' = ?", [symbol]).select("payload"),
  ]);
  const occupied: OccupiedContract[] = (legs as { expiry: string | null; strike: string | null; right: string | null }[])
    .filter((leg) => leg.expiry !== null && leg.strike !== null)
    .map((leg) => ({ expiry: leg.expiry!, strike: Number(leg.strike), detail: `open position on ${describeContract(symbol, leg.expiry!, Number(leg.strike), leg.right)}` }));
  for (const { payload } of orders as { payload: OrderRequestPayload }[]) {
    for (const leg of payload.legs ?? []) {
      if (leg.role !== "option" || !leg.expiry || leg.strike === undefined || leg.strike === null) continue;
      const expiry = /^\d{8}$/.test(leg.expiry) ? `${leg.expiry.slice(0, 4)}-${leg.expiry.slice(4, 6)}-${leg.expiry.slice(6, 8)}` : leg.expiry;
      occupied.push({ expiry, strike: Number(leg.strike), detail: `working order on ${describeContract(symbol, expiry, Number(leg.strike), leg.right ?? null)}` });
    }
  }
  return occupied;
}
