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
  capitalAtRisk: string | null;
}

export async function fetchPositionById(positionId: string): Promise<PositionRow | undefined> {
  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [positionId]);
  return result.rows[0];
}
