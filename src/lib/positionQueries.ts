import { db } from "../db/connection.js";

// Single source of truth for the position shape (legs, realizedPnl,
// capitalAtRisk) shared between the positions API (routes/positions.ts) and
// the worker's post-close Telegram notification (ibkrGatewayWorker.ts) — see
// positions.ts's own header comment for the approved realizedPnl/
// capitalAtRisk formulas (2026-08-21).
export const positionSelect = `
  SELECT
    p.id,
    p.strategy_key AS "strategyKey",
    p.status,
    p.opened_at AS "openedAt",
    p.closed_at AS "closedAt",
    p.notes,
    p.price_target AS "priceTarget",
    p.close_trigger_notes AS "closeTriggerNotes",
    p.close_reason AS "closeReason",
    p.unstructured_reason AS "unstructuredReason",
    t.id AS "tickerId",
    t.symbol,
    t.company_name AS "companyName",
    NULLIF(t.sector, '') AS sector,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', pl.id,
            'legType', pl.leg_type,
            'side', pl.side,
            'quantity', pl.quantity,
            'optionType', pl.option_type,
            'strikePrice', pl.strike_price,
            'expiryDate', pl.expiry_date,
            'multiplier', pl.multiplier,
            'ibkrContractId', pl.ibkr_contract_id,
            'entryPrice', pl.entry_price,
            'entryAt', pl.entry_at,
            'exitPrice', pl.exit_price,
            'exitAt', pl.exit_at
          ) ORDER BY pl.leg_type, pl.strike_price
        )
        FROM position_legs pl
        WHERE pl.position_id = p.id
      ),
      '[]'
    ) AS legs,
    COALESCE(
      (
        SELECT SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL
      ),
      0
    ) AS "realizedPnl",
    -- Premium P/L: the option leg(s) only — what a short option decayed/appreciated by.
    -- Split out 2026-08-30 per Juan's request so premium P/L and stock-movement P/L can be
    -- read separately instead of only as one blended figure. See "P/L Split & Roll
    -- Intelligence" proposal.
    COALESCE(
      (
        SELECT SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL AND pl.leg_type = 'option'
      ),
      0
    ) AS "realizedPremiumPnl",
    -- Stock-movement P/L: the stock leg only — meaningful for covered calls, always 0 for CSP
    -- (no stock leg exists to sum).
    COALESCE(
      (
        SELECT SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL AND pl.leg_type = 'stock'
      ),
      0
    ) AS "realizedStockPnl",
    CASE
      WHEN p.strategy_key = 'covered_call' THEN (
        SELECT pl.entry_price * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock'
        LIMIT 1
      )
      ELSE (
        SELECT pl.strike_price * pl.multiplier * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'option'
        ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
        LIMIT 1
      )
    END AS "capitalAtRisk"
  FROM positions p
  JOIN tickers t ON t.id = p.ticker_id
`;

export interface PositionLegRow {
  id: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  multiplier: number;
  ibkrContractId: string | null;
  entryPrice: string;
  entryAt: string;
  exitPrice: string | null;
  exitAt: string | null;
}

export interface PositionRow {
  id: string;
  strategyKey: string;
  status: "open" | "closed";
  symbol: string;
  legs: PositionLegRow[];
  realizedPnl: string;
  realizedPremiumPnl: string;
  realizedStockPnl: string;
  capitalAtRisk: string | null;
  closeReason: string | null;
  unstructuredReason: string | null;
}

export async function fetchPositionById(positionId: string): Promise<PositionRow | undefined> {
  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [positionId]);
  return result.rows[0];
}

// Shares of a symbol already held that aren't spoken for by an existing
// paired covered_call (that stock is already covering its own short call) —
// i.e. long-stock legs sitting on that symbol's open `unstructured`
// positions, most commonly leftover shares from a covered call whose short
// call expired worthless or a cash-secured put that got assigned. Used by
// POST /orders' covered-call auto-fill so opening a new call against a
// symbol that already has bare stock doesn't double-buy a fresh lot.
export async function fetchAvailableUncoveredShares(tickerId: string): Promise<number> {
  const result = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": tickerId, "p.status": "open", "p.strategy_key": "unstructured", "pl.leg_type": "stock", "pl.side": "long" })
    .whereNull("pl.exit_at")
    .sum({ total: "pl.quantity" })
    .first();
  return Number(result?.total ?? 0);
}
