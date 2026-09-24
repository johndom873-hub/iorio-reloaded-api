import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { fetchPricesPoolFirst, streamPooledPrices } from "../ibkr/pricePool.js";
import { dedupeInFlight } from "./dedupeInFlight.js";

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

// Deduplicated (see dedupeInFlight.ts) — /dashboard/portfolio and
// /risk-limits/exposure both call this with no arguments, and load together
// on the Dashboard.
export const computePositionExposures = dedupeInFlight(computePositionExposuresUncached);

interface OpenPositionRow {
  positionId: string;
  strategyKey: string;
  symbol: string;
  sector: string;
}

async function resolveOpenPositionsAndLegs(): Promise<{ positions: OpenPositionRow[]; legs: OpenLegRow[] }> {
  const positions: OpenPositionRow[] = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .select("p.id as positionId", "p.strategy_key as strategyKey", "t.symbol", db.raw("COALESCE(NULLIF(t.sector, ''), 'Unknown') AS sector"));

  if (positions.length === 0) return { positions, legs: [] };

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

  return { positions, legs };
}

function legsToPriceContracts(legs: OpenLegRow[]): PriceContract[] {
  return legs.map((leg, index) => ({
    key: String(index),
    legType: leg.legType,
    symbol: leg.symbol,
    expiry: leg.expiryDate ?? undefined,
    strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
    right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
  }));
}

// Pure function of whatever prices are currently known — a leg with no
// price yet falls back to its entry_price, so this always produces a full
// result. Used both by the one-shot computePositionExposures below and by
// streamPositionExposures, called again on every price update; since a
// missing price already defaults to entry_price rather than showing
// nothing, there's no "regress to null" risk the way greeks/pnl have to
// guard against — every update only ever gets more accurate as more real
// prices arrive.
function computeExposureRows(positions: OpenPositionRow[], legs: OpenLegRow[], pricesByKey: Record<string, number | null>): PositionExposureRow[] {
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

// Pool first (2026-09-24): legs already held by an open Positions/Pulse/
// Dashboard stream are priced from the pool with no IBKR request at all;
// only legs nobody has pooled fall back to a one-shot snapshot. The Signals
// order-limit check calls this on every debounced keystroke, on confirm and
// every 10s from the Order Review quote stream, so this is what keeps those
// from opening a snapshot per open leg each time.
async function computePositionExposuresUncached(): Promise<PositionExposureRow[]> {
  const { positions, legs } = await resolveOpenPositionsAndLegs();
  if (positions.length === 0) return [];

  let pricesByKey: Record<string, number | null> = {};
  try {
    pricesByKey = await fetchPricesPoolFirst(legsToPriceContracts(legs));
  } catch {
    // Leave pricesByKey empty — every leg falls back to entry_price below.
  }

  return computeExposureRows(positions, legs, pricesByKey);
}

/**
 * Live-upgrading variant for the SSE-backed Dashboard/Risk & Limits screens
 * (approved 2026-09-09): emits exposure rows computed from FROZEN prices
 * first, then keeps recomputing and re-emitting as streamLivePrices reports
 * genuinely new live prices, until `signal` aborts. See streamLivePrices.ts
 * for the FROZEN-then-REALTIME mechanics.
 */
export async function streamPositionExposures(onUpdate: (rows: PositionExposureRow[]) => void, signal: AbortSignal): Promise<void> {
  const { positions, legs } = await resolveOpenPositionsAndLegs();
  if (positions.length === 0) {
    onUpdate([]);
    return;
  }

  // Hold the first reading until every leg has a price or the frozen phase
  // has ended (approved 2026-09-19). Without this, legs not yet priced fall
  // back to entry_price and the first ~0.5s shows wrong totals that then
  // jump (Dashboard covered calls read 29,443 -> 29,725). After the first
  // reading every update goes out as before.
  let hasEmitted = false;
  await streamPooledPrices(
    legsToPriceContracts(legs),
    (pricesByKey, { frozenPhaseComplete }) => {
      const everyLegPriced = legs.every((_, index) => pricesByKey[String(index)] !== null && pricesByKey[String(index)] !== undefined);
      if (!hasEmitted && !everyLegPriced && !frozenPhaseComplete) return;
      hasEmitted = true;
      onUpdate(computeExposureRows(positions, legs, pricesByKey));
    },
    signal,
  );
}
