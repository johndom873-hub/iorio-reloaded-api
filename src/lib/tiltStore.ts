import { db } from "../db/connection.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew, type ElevatedVolatilityFlag, type SkewMeasure, type SkewSlice } from "./tiltMeasures.js";

export interface TiltMeasures {
  /** 12-1 month log return; null with under 253 closes. */
  momentum: number | null;
  skew: SkewMeasure | null;
  elevatedVolatility: ElevatedVolatilityFlag | null;
}

/** Bars up to and INCLUDING `asOfDateIso` (never later), oldest first, capped at the last ~6 years. Dates are cast to text. */
async function loadBarsUpTo(tickerId: string, asOfDateIso: string): Promise<DailyOhlcvBar[]> {
  const rows: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text <= ?", [asOfDateIso])
    .orderBy("trading_date", "desc")
    .limit(1500)
    .select(db.raw('trading_date::text as "tradingDate"'), db.raw("open_price as open"), db.raw("high_price as high"), db.raw("low_price as low"), db.raw("close_price as close"), "volume");
  return rows
    .filter((row) => row.open !== null && row.high !== null && row.low !== null && row.close !== null)
    .reverse()
    .map((row) => ({ tradingDate: row.tradingDate, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0) }));
}

async function loadSkewSlices(tickerId: string, tradingDateIso: string): Promise<SkewSlice[]> {
  const rows = await db("option_surface_fits as f")
    .join("option_chain_snapshots as h", "h.id", "f.snapshot_id")
    .where("h.ticker_id", tickerId)
    .whereRaw("h.trading_date::text = ?", [tradingDateIso])
    .select("f.status", "f.years_to_expiry", "f.k_min", "f.k_max", "f.param_a", "f.param_b", "f.param_rho", "f.param_m", "f.param_sigma");
  return rows.map((row) => ({
    status: row.status,
    yearsToExpiry: Number(row.years_to_expiry),
    kMin: row.k_min === null ? null : Number(row.k_min),
    kMax: row.k_max === null ? null : Number(row.k_max),
    parameters: row.param_a === null ? null : { a: Number(row.param_a), b: Number(row.param_b), rho: Number(row.param_rho), m: Number(row.param_m), sigma: Number(row.param_sigma) },
  }));
}

/** The three separate Tilt measures a ticker had on a date. Momentum and the flag need daily bars only; skew needs that date's stored surface fits. */
export async function loadTiltMeasures(tickerId: string, asOfDateIso: string): Promise<TiltMeasures> {
  const bars = await loadBarsUpTo(tickerId, asOfDateIso);
  return {
    momentum: computeMomentum(bars.map((bar) => bar.close)),
    skew: computeSkew(await loadSkewSlices(tickerId, asOfDateIso)),
    elevatedVolatility: computeElevatedVolatilityFlag(bars),
  };
}
