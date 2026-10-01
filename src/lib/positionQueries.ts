import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { legRealizedPnlSql } from "./legRealizedPnlSql.js";

// Single source of truth for the position shape (legs, realizedPnl,
// capitalAtRisk) shared between the positions API (routes/positions.ts) and
// the worker's post-close Telegram notification (ibkrGatewayWorker.ts) — see
// positions.ts's own header comment for the approved realizedPnl/
// capitalAtRisk formulas (2026-08-21).
// The option leg's strike collateral (a position with no open stock leg): the open leg if there is one, else the latest.
const optionCollateralSql = `
        SELECT pl.strike_price * pl.multiplier * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'option'
        ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
        LIMIT 1
      `;

// The same collateral summed over every leg of the contract that leg is (same strike, expiry and type): a short put bought back a few
// contracts at a time leaves closed slices of one contract, and the P&L they realized is earned on all of them. A rolled-away leg
// is a different contract and stays out. Approved 2026-10-01 (the option half of capitalDeployed).
const optionDeployedSql = `
        SELECT SUM(same_contract.strike_price * same_contract.multiplier * same_contract.quantity)
        FROM position_legs same_contract
        JOIN (
          SELECT pl.strike_price, pl.expiry_date, pl.option_type
          FROM position_legs pl
          WHERE pl.position_id = p.id AND pl.leg_type = 'option'
          ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
          LIMIT 1
        ) chosen
          ON same_contract.strike_price = chosen.strike_price
          AND same_contract.expiry_date IS NOT DISTINCT FROM chosen.expiry_date
          AND same_contract.option_type = chosen.option_type
        WHERE same_contract.position_id = p.id AND same_contract.leg_type = 'option'
      `;

export const positionSelect = `
  SELECT
    p.id,
    p.strategy_key AS "strategyKey",
    p.status,
    p.opened_at AS "openedAt",
    p.closed_at AS "closedAt",
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
        SELECT SUM(${legRealizedPnlSql("pl")})
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
        SELECT SUM(${legRealizedPnlSql("pl")})
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL AND pl.leg_type = 'option'
      ),
      0
    ) AS "realizedPremiumPnl",
    -- Stock-movement P/L: the stock leg only — meaningful for covered calls, always 0 for CSP
    -- (no stock leg exists to sum).
    COALESCE(
      (
        SELECT SUM(${legRealizedPnlSql("pl")})
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL AND pl.leg_type = 'stock'
      ),
      0
    ) AS "realizedStockPnl",
    -- Keyed on leg composition (is an open stock leg present), not strategy_key. Never put a
    -- question mark in this SQL: knex.raw reads each one as a binding placeholder.
    -- an unstructured (N/S) position can be bare leftover stock with no
    -- option leg at all (e.g. shares left after a covered call's short call
    -- expired/was assigned away), and that stock still has real capital at
    -- risk. Gating this on strategy_key = 'covered_call' missed that case
    -- and showed "–" for EXP $/% on those rows — same bug class already
    -- fixed for Stock P&L display 2026-08-30, see positionHasStockLeg's
    -- doc comment in positionPnl.ts. Fixed 2026-09-24.
    CASE
      WHEN EXISTS (
        SELECT 1 FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock' AND pl.exit_at IS NULL
      ) THEN (
        SELECT pl.entry_price * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock' AND pl.exit_at IS NULL
        LIMIT 1
      )
      ELSE (${optionCollateralSql})
    END AS "capitalAtRisk",
    -- The base for P&L %, approved 2026-10-01: the same as capitalAtRisk, except that it also counts what
    -- partial closes already carved off (closed stock slices while shares are still held; closed slices of
    -- the same option contract), because the P&L it divides includes their realized result. capitalAtRisk
    -- itself stays the capital exposed NOW (EXP $, EXP %, Pulse exposure).
    CASE
      WHEN EXISTS (
        SELECT 1 FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock' AND pl.exit_at IS NULL
      ) THEN (
        SELECT SUM(pl.entry_price * pl.quantity)
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock'
      )
      ELSE (${optionDeployedSql})
    END AS "capitalDeployed"
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
  /** Base for P&L %: capitalAtRisk plus what partial closes already carved off (sold stock slices, closed slices of the same option contract). */
  capitalDeployed: string | null;
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

// Number of open positions on a ticker. A shortlist entry can't be removed
// while this is above zero: the nightly chain capture and Day Signals (roll
// signals included) cover shortlisted tickers only, so dropping the ticker
// would orphan a live position.
export async function countOpenPositionsForTicker(tickerId: string, trx: Knex = db): Promise<number> {
  const result = await trx("positions").where({ ticker_id: tickerId, status: "open" }).count({ total: "*" }).first();
  return Number(result?.total ?? 0);
}

export function describeOpenPositionsBlockingRemoval(openPositionCount: number): string {
  return `${openPositionCount} open position${openPositionCount === 1 ? "" : "s"} on this ticker. Close ${openPositionCount === 1 ? "it" : "them"} before removing.`;
}
