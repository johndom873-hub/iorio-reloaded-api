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
      t.symbol
    FROM trades tr
    JOIN position_legs pl ON pl.id = tr.position_leg_id
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    ${whereClause}
    ORDER BY tr.executed_at DESC
    `,
    params,
  );
  response.json(result.rows);
});
