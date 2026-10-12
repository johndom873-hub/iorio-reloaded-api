// Types and lookups for the valuation model's tables (model review P4/P5, approved by Marcelo 2026-10-10). The data
// lives in volatilityModelTables.generated.ts, written by `npm run model:build-tables`
// (scripts/build-volatility-model-tables.ts → volatilityModelTablesBuilder.ts), and is committed with the code.

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

/** The bucket table for a variance-time τ (sessions): the horizon nearest τ, at least 1, at most the table's last. */
export function standardizedReturnBucketsFor(tables: VolatilityModelTables, group: ValuationGroup, varianceSessions: number): readonly number[] {
  const horizon = Math.min(tables.maxHorizon, Math.max(1, Math.round(varianceSessions)));
  return tables.standardizedReturnBuckets[group][horizon - 1]!;
}

function interpolateRow(points: CalibrationPoint[], predictedMargin: number): number {
  if (points.length === 0) return predictedMargin;
  if (predictedMargin <= points[0]!.predictedMargin) return points[0]!.realizedMargin;
  const last = points.at(-1)!;
  if (predictedMargin >= last.predictedMargin) return last.realizedMargin;
  for (let index = 1; index < points.length; index++) {
    const right = points[index]!;
    if (predictedMargin <= right.predictedMargin) {
      const left = points[index - 1]!;
      return left.realizedMargin + ((predictedMargin - left.predictedMargin) * (right.realizedMargin - left.realizedMargin)) / (right.predictedMargin - left.predictedMargin);
    }
  }
  return last.realizedMargin;
}

/**
 * The margin history delivered for a predicted margin at variance-time τ (P5 calibration, at-the-money proxy until
 * strike-level history exists): piecewise linear between bucket means within a horizon row, flat beyond the first and
 * last bucket, linear in τ between rows; τ below the first row uses it, above the last row uses the last.
 */
export function calibratedEdgeMargin(tables: VolatilityModelTables, predictedMargin: number, varianceSessions: number): number {
  const rows = [...tables.calibration].sort((a, b) => a.horizon - b.horizon);
  if (rows.length === 0) return predictedMargin;
  if (varianceSessions <= rows[0]!.horizon) return interpolateRow(rows[0]!.points, predictedMargin);
  const lastRow = rows.at(-1)!;
  if (varianceSessions >= lastRow.horizon) return interpolateRow(lastRow.points, predictedMargin);
  const upperIndex = rows.findIndex((row) => row.horizon >= varianceSessions);
  const lower = rows[upperIndex - 1]!, upper = rows[upperIndex]!;
  const weight = (varianceSessions - lower.horizon) / (upper.horizon - lower.horizon);
  return (1 - weight) * interpolateRow(lower.points, predictedMargin) + weight * interpolateRow(upper.points, predictedMargin);
}
