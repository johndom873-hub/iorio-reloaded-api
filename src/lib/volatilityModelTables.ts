// Types of the valuation model's tables (model review P4/P5, approved by Marcelo 2026-10-10), which the retired Signals
// model and backtests valued contracts with; nothing values with them now. The data lives in
// volatilityModelTables.generated.ts, written by `npm run model:build-tables` (scripts/build-volatility-model-tables.ts →
// volatilityModelTablesBuilder.ts), and is committed with the code.

/** Which fat-tail table a ticker is valued with (approved 2026-10-10): ETFs (TLT included) or single stocks. */
export type ValuationGroup = "etf" | "stock";

export interface CalibrationPoint {
  /** Mean predicted edge margin (1 − fair ÷ premium) of the bucket. */
  predictedMargin: number;
  /**
   * The realized margin the model uses: the bucket's premium-weighted realized margin after a monotone fit across the
   * row's buckets (a higher predicted margin never maps to a lower result; buckets that break the order are pooled).
   */
  realizedMargin: number;
  /** The bucket's own premium-weighted realized margin, before the monotone fit. */
  rawRealizedMargin: number;
  /** 95% interval of rawRealizedMargin: bootstrap over calendar months (overlapping windows and same-day tickers move together). */
  realizedLow: number;
  realizedHigh: number;
  count: number;
}

export interface VolatilityModelTables {
  builtAtIso: string;
  source: string;
  sampleFromIso: string;
  sampleToIso: string;
  bucketCount: number;
  /** Horizons 1..maxHorizon sessions are tabulated; longer ones use the last. */
  maxHorizon: number;
  /** [group][h − 1] = equal-count bucket means of z = h-session log return ÷ (YZ21 σ_session √h), ascending. */
  standardizedReturnBuckets: Record<ValuationGroup, number[][]>;
  sampleCounts: Record<ValuationGroup, number[]>;
  /** At-the-money calibration rows (horizons 1, 2, 3, 5, 10, 21), points ascending by predicted margin. */
  calibration: { horizon: number; points: CalibrationPoint[] }[];
}
