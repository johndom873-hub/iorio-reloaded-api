import { buildTrendLabel } from "../ibkr/generateTradeAlertCandidates.js";
import { computeMacd, computeMovingAverages, type MacdSignal } from "./technicalIndicators.js";

export interface PriceTrend {
  macdTrend: MacdSignal | null;
  maTrend: "uptrend" | "downtrend" | "mixed" | null;
}

/**
 * The Price Performance page's MACD and moving-average trend labels, from
 * daily closes in ascending date order. Exactly the calculation the old
 * GET /price-performance/trends endpoint ran (computeMacd, computeMovingAverages,
 * buildTrendLabel — none of them changed); the only difference is where the
 * closes come from and what "spot" is: the caller now passes COMPLETED daily
 * closes only, so spot is the last completed close (approved 2026-09-20).
 * No closes at all yields nulls, as before.
 */
export function computePriceTrend(closes: number[]): PriceTrend {
  if (closes.length === 0) return { macdTrend: null, maTrend: null };
  const spotPrice = closes[closes.length - 1]!;
  return {
    macdTrend: computeMacd(closes),
    maTrend: buildTrendLabel(spotPrice, computeMovingAverages(closes)),
  };
}
