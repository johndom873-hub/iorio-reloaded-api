import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const tradeBlotterRouter = Router();
tradeBlotterRouter.use(requireAuth);

// v1 strategy scope — matches positions.ts/screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];

// P&L is computed here at read time, not stored on trades.realized_pnl —
// that column is reserved for IBKR's own CommissionReport.realizedPNL
// (see the trades table migration), which doesn't exist for these
// manually-entered positions (no real broker fill behind them). Only
// closing trades get a figure; an opening trade hasn't realized anything
// yet. Formula approved 2026-08-20: (exit - entry) * qty * multiplier,
// sign-flipped for short legs since a short profits when price falls.
tradeBlotterRouter.get("/", async (request, response) => {
  const strategyKey = request.query.strategy as string | undefined;
  const symbol = (request.query.symbol as string | undefined)?.trim().toUpperCase();
  const from = request.query.from as string | undefined;
  const to = request.query.to as string | undefined;

  if (strategyKey && !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategy." });
    return;
  }

  const conditions: string[] = [];
  const params: string[] = [];
  if (strategyKey) {
    conditions.push("p.strategy_key = ?");
    params.push(strategyKey);
  }
  if (symbol) {
    conditions.push("t.symbol = ?");
    params.push(symbol);
  }
  if (from) {
    conditions.push("tr.executed_at >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("tr.executed_at <= ?");
    params.push(to);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db.raw(
    `
    SELECT
      tr.id,
      tr.ibkr_order_id AS "ibkrOrderId",
      tr.side,
      tr.quantity,
      tr.price,
      tr.commission,
      tr.executed_at AS "executedAt",
      tr.is_closing_trade AS "isClosingTrade",
      CASE WHEN tr.is_closing_trade
        THEN (tr.price - pl.entry_price) * tr.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END)
        ELSE NULL
      END AS "pnl",
      p.id AS "positionId",
      p.strategy_key AS "strategyKey",
      pl.id AS "legId",
      pl.leg_type AS "legType",
      pl.side AS "legSide",
      pl.option_type AS "optionType",
      pl.strike_price AS "strikePrice",
      to_char(pl.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
      t.symbol,
      ru.display_name AS "requestedByDisplayName"
    FROM trades tr
    JOIN position_legs pl ON pl.id = tr.position_leg_id
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    LEFT JOIN order_requests orq ON orq.id = tr.source_order_request_id
    LEFT JOIN users ru ON ru.id = orq.requested_by_user_id
    ${whereClause}
    ORDER BY tr.executed_at DESC
    `,
    params,
  );

  // Real fills (above) only ever exist for a `filled`/`partially_filled`
  // order_requests row — everything else (still pending confirmation,
  // confirmed and awaiting the worker, submitted and awaiting a fill,
  // cancelling, cancelled, rejected, errored) has no trades row at all, so
  // the Trade Blotter previously showed nothing for an order until it fully
  // filled. Built 2026-08-24 after real testing: 3 real orders sat
  // "submitted" for hours with zero visibility here. Every request_type
  // (open/roll/close) shares the same payload shape (see orderPayload.ts),
  // so this expands payload.legs the same way regardless of which built it.
  const orderConditions = [`orq.status != 'filled'`];
  const orderParams: string[] = [];
  if (strategyKey) {
    orderConditions.push("orq.payload->>'strategyKey' = ?");
    orderParams.push(strategyKey);
  }
  if (symbol) {
    orderConditions.push("orq.payload->>'symbol' = ?");
    orderParams.push(symbol);
  }
  if (from) {
    orderConditions.push("orq.created_at >= ?");
    orderParams.push(from);
  }
  if (to) {
    orderConditions.push("orq.created_at <= ?");
    orderParams.push(to);
  }

  const pendingOrdersResult = await db.raw(
    `
    SELECT
      -- orq.id alone isn't unique per expanded row (a multi-leg order, e.g.
      -- a covered call's stock+option legs or a roll's two option legs,
      -- produces one row per leg here) -- WITH ORDINALITY appends each
      -- leg's position in the array so every row gets a distinct id, since
      -- this is the frontend DataTable's rowKey and duplicates there cause
      -- a real React key collision (rows silently dropped/duplicated).
      orq.id || ':' || leg_ordinality AS id,
      orq.status,
      orq.ibkr_order_id AS "ibkrOrderId",
      orq.error_message AS "errorMessage",
      orq.request_type AS "requestType",
      orq.created_at AS "createdAt",
      orq.payload->>'symbol' AS symbol,
      orq.payload->>'strategyKey' AS "strategyKey",
      ru.display_name AS "requestedByDisplayName",
      cu.display_name AS "cancelledByDisplayName",
      leg->>'role' AS "legRole",
      leg->>'action' AS action,
      (leg->>'quantity')::numeric AS quantity,
      (leg->>'unitPrice')::numeric AS "unitPrice",
      NULLIF(leg->>'strike', '') AS strike,
      NULLIF(leg->>'expiry', '') AS expiry,
      NULLIF(leg->>'right', '') AS "optionType"
    FROM order_requests orq
    CROSS JOIN LATERAL jsonb_array_elements(orq.payload->'legs') WITH ORDINALITY AS t(leg, leg_ordinality)
    LEFT JOIN users ru ON ru.id = orq.requested_by_user_id
    LEFT JOIN users cu ON cu.id = orq.cancelled_by_user_id
    WHERE ${orderConditions.join(" AND ")}
    ORDER BY orq.created_at DESC
    `,
    orderParams,
  );
  const pendingOrders = pendingOrdersResult.rows.map((row: Record<string, unknown>) => ({
    ...row,
    // YYYYMMDD (IBKR's own convention, see OrderLegPayload) -> YYYY-MM-DD,
    // matching the trades query's to_char format so the frontend can share
    // one date formatter across both row kinds.
    expiry: typeof row.expiry === "string" && row.expiry.length === 8
      ? `${row.expiry.slice(0, 4)}-${row.expiry.slice(4, 6)}-${row.expiry.slice(6, 8)}`
      : row.expiry,
  }));

  response.json({ trades: result.rows, pendingOrders });
});
