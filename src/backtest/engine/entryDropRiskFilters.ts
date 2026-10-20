import type { BacktestBaselineSettings } from "../backtestTypes.js";
import type { BacktestBarHistory } from "./backtestBarHistory.js";
import { ivRankFromHistory } from "./backtestLlmDecider.js";

// The drop-risk filters on new entries (approved by Marcelo 2026-10-19; research: Ladder Drop-Risk Filters). A 30% fall
// within three months came after run-ups far more often than after other days of the same stock, and fast falls after
// implied volatility near the top of its year; so with a filter on, no Cash-Secured Put entry and no Covered Call entry is
// made while its measure is at or above the limit (baselineSaleSteps.ts step 2). Calls on held shares and ladder Puts are
// never filtered: high implied volatility there marked the safest, best-paid ladder Puts.
//
//   extension z = (C ÷ A200 − 1) ÷ σ63
//                 C    the previous session's close
//                 A200 the average of the last 200 daily closes
//                 σ63  the standard deviation of the last 63 daily log returns (64 closes) × √252
//                 (IBKR's split-adjusted closes before the day; null with fewer than 200)
//   IV Rank     = (IV − IV_min) ÷ (IV_max − IV_min) × 100 over the last 252 days with an implied volatility, IV the latest
//                 (IBKR's daily IV before the day; Price Performance's IV Rank, ivMetrics.ts; null below 2 days or a flat range)
//
// Example: MRNA on 2021-09-20, C $430.05 and A200 $214.48 (100.5% above), σ63 81.2%: z = 1.005 ÷ 0.812 = 1.24.

export const extensionAverageCloses = 200;
export const extensionVolatilityReturns = 63;
export const ivRankWindowDays = 252;

/** Extension z from the daily closes before the day, oldest first; null with fewer than 200 or no volatility. */
export function extensionZ(closesOldestFirst: readonly { close: number }[]): number | null {
  if (closesOldestFirst.length < extensionAverageCloses) return null;
  const lastCloses = closesOldestFirst.slice(-extensionAverageCloses).map((bar) => bar.close);
  const average = lastCloses.reduce((sum, close) => sum + close, 0) / lastCloses.length;
  const volatilityCloses = lastCloses.slice(-(extensionVolatilityReturns + 1));
  const returns = volatilityCloses.slice(1).map((close, index) => Math.log(close / volatilityCloses[index]!));
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance * 252);
  if (!(volatility > 0) || !(average > 0)) return null;
  return (lastCloses.at(-1)! / average - 1) / volatility;
}

/** IV Rank from the last 252 daily bars with an implied volatility before `dateIso`. */
export function ivRankBefore(bars: BacktestBarHistory, dateIso: string): number | null {
  const newestFirst: number[] = [];
  for (let index = bars.countBefore(dateIso) - 1; index >= 0 && newestFirst.length < ivRankWindowDays; index--) {
    const impliedVolatility = bars.rows[index]!.impliedVolatility;
    if (impliedVolatility !== null && impliedVolatility !== undefined) newestFirst.push(impliedVolatility);
  }
  return ivRankFromHistory(newestFirst.reverse());
}

type EntryFilterSettings = Pick<BacktestBaselineSettings, "entryExtensionFilter" | "entryMaxExtensionZ" | "entryIvRankFilter" | "entryMaxIvRank">;
type EntryFilterMeasures = { extensionZ: number | null; ivRank: number | null };

/** The limit of each filter that blocks a new entry today, null for one that does not; a measure that cannot be worked out blocks nothing. */
export function entryDropRiskBlockingLimits(baseline: EntryFilterSettings, measures: EntryFilterMeasures): { extensionZ: number | null; ivRank: number | null } {
  const extensionZBlocks = baseline.entryExtensionFilter === "on" && measures.extensionZ !== null && measures.extensionZ >= baseline.entryMaxExtensionZ;
  const ivRankBlocks = baseline.entryIvRankFilter === "on" && measures.ivRank !== null && measures.ivRank >= baseline.entryMaxIvRank;
  return { extensionZ: extensionZBlocks ? baseline.entryMaxExtensionZ : null, ivRank: ivRankBlocks ? baseline.entryMaxIvRank : null };
}

/** Why a new entry is blocked today ("extension z 1.24 ≥ 1"), or null. */
export function entryDropRiskBlock(baseline: EntryFilterSettings, measures: EntryFilterMeasures): string | null {
  const limits = entryDropRiskBlockingLimits(baseline, measures);
  const reasons: string[] = [];
  if (limits.extensionZ !== null) reasons.push(`extension z ${measures.extensionZ!.toFixed(2)} ≥ ${limits.extensionZ}`);
  if (limits.ivRank !== null) reasons.push(`IV Rank ${measures.ivRank!.toFixed(0)} ≥ ${limits.ivRank}`);
  return reasons.length === 0 ? null : reasons.join(", ");
}
