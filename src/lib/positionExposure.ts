import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { fetchLivePrices, type PriceContract } from "../ibkr/fetchLivePrices.js";

// Position "exposure"/"value" = full market value across every open leg
// (stock + option together), option legs priced as a liability — the
// platform-wide valuation standard (decided 2026-08-28, see
// project_position_valuation_full_market_value memory). Single source of
// truth shared by riskLimits.ts (concentration/allocation limits) and
// dashboard.ts (Portfolio section, Allocation card). Falls back to
// entry_price per leg when a live quote isn't available (e.g. outside
// market hours) rather than dropping the position from every view.
interface OpenLegRow {
  positionId: string;
  strategyKey: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entryPrice: string;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  symbol: string;
}

export interface PositionExposureRow {
  positionId: string;
  strategyKey: string;
  symbol: string;
  sector: string;
  exposure: number;
}

// The cash reserved to cover assignment on open cash-secured puts — same
// figure embedded inside a CSP's exposure above, exposed separately since
// "cash locked" (a cash-availability question) and "position exposure" (a
// valuation question) are asked by different callers (Available Cash,
// Portfolio section, Order Review cash-sufficiency).
export async function computeCashLockedInCsps(): Promise<number> {
  const result = await db.raw(`
    SELECT COALESCE(SUM(
      (SELECT pl.strike_price * pl.multiplier * pl.quantity
       FROM position_legs pl
       WHERE pl.position_id = p.id AND pl.leg_type = 'option'
       ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
       LIMIT 1)
    ), 0) AS reserved
    FROM positions p
    WHERE p.status = 'open' AND p.strategy_key = 'cash_secured_put'
  `);
  return Number(result.rows[0]?.reserved ?? 0);
}

export async function computePositionExposures(): Promise<PositionExposureRow[]> {
  const positions = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .select("p.id as positionId", "p.strategy_key as strategyKey", "t.symbol", db.raw("COALESCE(NULLIF(t.sector, ''), 'Unknown') AS sector"));

  if (positions.length === 0) return [];

  const legs: OpenLegRow[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .whereNull("pl.exit_at")
    .select(
      "pl.position_id as positionId",
      "p.strategy_key as strategyKey",
      "pl.leg_type as legType",
      "pl.side",
      "pl.quantity",
      "pl.multiplier",
      "pl.entry_price as entryPrice",
      "pl.option_type as optionType",
      "pl.strike_price as strikePrice",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as \"expiryDate\""),
      "t.symbol",
    );

  const priceContracts: PriceContract[] = legs.map((leg, index) => ({
    key: String(index),
    legType: leg.legType,
    symbol: leg.symbol,
    expiry: leg.expiryDate ?? undefined,
    strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
    right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
  }));

  let pricesByKey: Record<string, number | null> = {};
  try {
    pricesByKey = await fetchLivePrices(priceContracts);
  } catch {
    // Leave pricesByKey empty — every leg falls back to entry_price below.
  }

  const exposureByPositionId = new Map<string, number>();
  legs.forEach((leg, index) => {
    const price = pricesByKey[String(index)] ?? Number(leg.entryPrice);
    const sign = leg.side === "short" ? -1 : 1;
    let legValue = price * leg.quantity * leg.multiplier * sign;

    // A CSP has no "cash" leg of its own — the collateral behind the short
    // put is only implicit in the strike, never a row in position_legs. Add
    // it explicitly so CSP exposure reflects the cash actually locked, not
    // just the option's own (much smaller) market value.
    if (leg.strategyKey === "cash_secured_put" && leg.legType === "option" && leg.strikePrice !== null) {
      legValue += Number(leg.strikePrice) * leg.multiplier * leg.quantity;
    }

    exposureByPositionId.set(leg.positionId, (exposureByPositionId.get(leg.positionId) ?? 0) + legValue);
  });

  return positions.map((p) => ({
    positionId: p.positionId,
    strategyKey: p.strategyKey,
    symbol: p.symbol,
    sector: p.sector,
    exposure: exposureByPositionId.get(p.positionId) ?? 0,
  }));
}
