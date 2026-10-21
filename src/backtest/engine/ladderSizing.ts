import type { BacktestBaselineSettings } from "../backtestTypes.js";
import type { BaselineSizing } from "./baselineSaleSteps.js";
import { extensionZ } from "./entryDropRiskFilters.js";

// The ladder's falling-knife guard and Kelly sizing (approved by Marcelo 2026-10-21): two multipliers on new buying at a
// look (the entries' room in the shares' budget and each ladder Put's collateral), worked out from the daily bars
// before the day. Calls on held shares are never scaled. With both off the sale steps get no sizing at all.
//
//   Falling-knife guard, only while the stock's previous close is at least 25% below its 252-session closing high:
//     q = min(1, max(0, β × SPY's fall from its own 252-session closing high ÷ the stock's fall))   the market's share
//     β = the slope of the stock's daily log returns on SPY's over the last 252 sessions (common days)
//     K = minimum + (1 − minimum) × min(1, q ÷ 0.5)          minimum: knifeGuardMinScale
//     with "market_share_and_iv", K × 0.5 unless the latest implied volatility is at least 10% below its highest of
//     the last 21 sessions (IBKR's daily IV before the day)
//   Kelly multiplier, with kellySizing "dynamic":
//     extension z (entryDropRiskFilters.ts); z₀ = kellyTopFromZ, z₁ = kellyTopToZ, mMax = kellyMaxMultiplier
//       z ≥ z₁: 0;  z₀ ≤ z < z₁: 1 − (z − z₀) ÷ (z₁ − z₀);  0 ≤ z < z₀: 1;  z < 0: 1 + (mMax − 1) × min(1, −z)
//     with kellySpyMove "on", × (1 − 0.5 × clamp((SPY's 21-session move − 2%) ÷ 4%, 0, 1))
//     with the constant rule, m = kellyConstantMultiplier
//   The look's scale on new buying = m × K, within 0 and mMax (the constant rule: its own value).
//   With kellyAtTops "deeper_puts", at z ≥ z₀ the entry room m holds back secures Puts at a strike ≤ price × (1 − 0.30 × (1 − m)).
//
// Examples (the drop-filter research's days): PTON 2021-11-08, 67% below its high with SPY at its high: q 0.00, K 0
// at minimum 0 (it fell another 53% within 63 sessions). SPY 2020-03-23: q 1.00, K 1; z −0.49 gives m 1.49 with
// mMax 2. MRNA 2021-09-20, z 1.24: m 0.26 with z₀ 0.5 and z₁ 1.5.

export const knifeGuardFallFromHighAtLeast = 0.25;
export const knifeGuardFullMarketShare = 0.5;
export const sizingHighWindowSessions = 252;
export const sizingBetaReturns = 252;
export const impliedVolatilityPeakSessions = 21;
export const impliedVolatilityEasedBelowPeak = 0.1;
export const impliedVolatilityAtPeakScale = 0.5;
export const kellyFullBoostBelowZ = 1;
export const spyMoveSessions = 21;
export const spyMoveFullScaleUpTo = 0.02;
export const spyMoveScaleRange = 0.04;
export const spyMoveLowestScale = 0.5;
export const kellyDeeperPutsDepthPerCut = 0.3;

export interface DailyClose {
  date: string;
  close: number;
}

/** What the guard and the Kelly multiplier read at a look, from the daily bars before the day; null where too few. */
export interface LadderSizingMeasures {
  extensionZ: number | null;
  /** 0.32 = the previous close is 32% below the 252-session closing high. */
  fallFromHigh: number | null;
  beta: number | null;
  spyFallFromHigh: number | null;
  /** q, 0–1; null without SPY's closes, a beta, or a fall. */
  marketShareOfFall: number | null;
  /** The latest IV at least 10% below its 21-session high; null without IV. */
  impliedVolatilityEased: boolean | null;
  /** SPY's previous close ÷ its close 21 sessions before − 1. */
  spyMove21: number | null;
}

const fallFromHighOf = (closes: readonly DailyClose[]): number | null => {
  if (closes.length < sizingHighWindowSessions) return null;
  const window = closes.slice(-sizingHighWindowSessions);
  const high = window.reduce((highest, bar) => Math.max(highest, bar.close), 0);
  return high > 0 ? 1 - window.at(-1)!.close / high : null;
};

/** β of the stock's daily log returns on SPY's over the last 252 sessions, on the days both have; null with fewer than 200 such returns. */
export function betaOnSpy(closes: readonly DailyClose[], spyCloseByDate: ReadonlyMap<string, number>): number | null {
  const recent = closes.slice(-(sizingBetaReturns + 1));
  const stockReturns: number[] = [];
  const spyReturns: number[] = [];
  for (let index = 1; index < recent.length; index++) {
    const before = spyCloseByDate.get(recent[index - 1]!.date);
    const after = spyCloseByDate.get(recent[index]!.date);
    if (before === undefined || after === undefined || !(before > 0) || !(after > 0) || !(recent[index - 1]!.close > 0) || !(recent[index]!.close > 0)) continue;
    stockReturns.push(Math.log(recent[index]!.close / recent[index - 1]!.close));
    spyReturns.push(Math.log(after / before));
  }
  if (spyReturns.length < 200) return null;
  const meanSpy = spyReturns.reduce((sum, value) => sum + value, 0) / spyReturns.length;
  const meanStock = stockReturns.reduce((sum, value) => sum + value, 0) / stockReturns.length;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < spyReturns.length; index++) {
    covariance += (spyReturns[index]! - meanSpy) * (stockReturns[index]! - meanStock);
    variance += (spyReturns[index]! - meanSpy) ** 2;
  }
  return variance > 0 ? covariance / variance : null;
}

/** The look's measures: the stock's closes and implied volatilities before the day (oldest first), SPY's closes before the day. */
export function ladderSizingMeasures(input: { closesBeforeToday: readonly DailyClose[]; impliedVolatilitiesBeforeToday: readonly (number | null)[]; spyClosesBeforeToday: readonly DailyClose[] | null; spyCloseByDate: ReadonlyMap<string, number> | null }): LadderSizingMeasures {
  const { closesBeforeToday, spyClosesBeforeToday, spyCloseByDate } = input;
  const fallFromHigh = fallFromHighOf(closesBeforeToday);
  const beta = spyCloseByDate ? betaOnSpy(closesBeforeToday, spyCloseByDate) : null;
  const spyFallFromHigh = spyClosesBeforeToday ? fallFromHighOf(spyClosesBeforeToday) : null;
  const marketShareOfFall = fallFromHigh !== null && fallFromHigh > 0 && beta !== null && spyFallFromHigh !== null ? Math.min(1, Math.max(0, (beta * spyFallFromHigh) / fallFromHigh)) : null;
  const recentIv = input.impliedVolatilitiesBeforeToday.slice(-impliedVolatilityPeakSessions).filter((value): value is number => value !== null && value > 0);
  const latestIv = input.impliedVolatilitiesBeforeToday.at(-1);
  const impliedVolatilityEased = latestIv !== null && latestIv !== undefined && latestIv > 0 && recentIv.length > 0 ? latestIv <= (1 - impliedVolatilityEasedBelowPeak) * Math.max(...recentIv) : null;
  const spyMove21 = spyClosesBeforeToday && spyClosesBeforeToday.length > spyMoveSessions ? spyClosesBeforeToday.at(-1)!.close / spyClosesBeforeToday.at(-1 - spyMoveSessions)!.close - 1 : null;
  return { extensionZ: extensionZ(closesBeforeToday), fallFromHigh, beta, spyFallFromHigh, marketShareOfFall, impliedVolatilityEased, spyMove21 };
}

type GuardSettings = Pick<BacktestBaselineSettings, "knifeGuard" | "knifeGuardMinScale">;
type KellySettings = Pick<BacktestBaselineSettings, "kellySizing" | "kellyMultiplierRule" | "kellyTopFromZ" | "kellyTopToZ" | "kellyMaxMultiplier" | "kellySpyMove" | "kellyAtTops" | "kellyConstantMultiplier">;

/** K: 1 when the guard is off, the stock is less than 25% below its high, or q is unknown. */
export function knifeGuardScale(settings: GuardSettings, measures: LadderSizingMeasures): { scale: number; detail: string } {
  if (settings.knifeGuard === "off") return { scale: 1, detail: "guard off" };
  const { fallFromHigh, marketShareOfFall: q } = measures;
  if (fallFromHigh === null || fallFromHigh < knifeGuardFallFromHighAtLeast) return { scale: 1, detail: fallFromHigh === null ? "guard: no 252-session high yet" : `guard: ${(fallFromHigh * 100).toFixed(0)}% below the high` };
  if (q === null) return { scale: 1, detail: "guard: no market share of the fall (no SPY closes or beta)" };
  const minimum = settings.knifeGuardMinScale;
  let scale = minimum + (1 - minimum) * Math.min(1, q / knifeGuardFullMarketShare);
  let ivNote = "";
  if (settings.knifeGuard === "market_share_and_iv" && measures.impliedVolatilityEased === false) {
    scale *= impliedVolatilityAtPeakScale;
    ivNote = ", IV at its 21-session peak";
  }
  return { scale, detail: `guard ×${scale.toFixed(2)} (${(fallFromHigh * 100).toFixed(0)}% below the high, market's share ${q.toFixed(2)}${ivNote})` };
}

/** m from extension z (and SPY's month with kellySpyMove on), or the constant; 1 when disabled or z is unknown. */
export function kellyMultiplier(settings: KellySettings, measures: LadderSizingMeasures): { multiplier: number; topReading: boolean; detail: string } {
  if (settings.kellySizing === "disabled") return { multiplier: 1, topReading: false, detail: "Kelly disabled" };
  if (settings.kellyMultiplierRule === "constant") return { multiplier: settings.kellyConstantMultiplier, topReading: false, detail: `Kelly ×${settings.kellyConstantMultiplier} (constant)` };
  const z = measures.extensionZ;
  let multiplier = 1;
  if (z !== null) {
    if (z >= settings.kellyTopToZ) multiplier = 0;
    else if (z >= settings.kellyTopFromZ) multiplier = 1 - (z - settings.kellyTopFromZ) / (settings.kellyTopToZ - settings.kellyTopFromZ);
    else if (z < 0) multiplier = 1 + (settings.kellyMaxMultiplier - 1) * Math.min(1, -z / kellyFullBoostBelowZ);
  }
  let spyNote = "";
  if (settings.kellySpyMove === "on" && measures.spyMove21 !== null) {
    const spyScale = 1 - (1 - spyMoveLowestScale) * Math.min(1, Math.max(0, (measures.spyMove21 - spyMoveFullScaleUpTo) / spyMoveScaleRange));
    multiplier *= spyScale;
    if (spyScale < 1) spyNote = `, SPY ${(measures.spyMove21 * 100).toFixed(1)}% in 21 sessions ×${spyScale.toFixed(2)}`;
  }
  return { multiplier, topReading: z !== null && z >= settings.kellyTopFromZ, detail: `Kelly ×${multiplier.toFixed(2)} (${z === null ? "no extension z" : `extension z ${z.toFixed(2)}`}${spyNote})` };
}

/** The look's sizing for the sale steps; null when the guard is off and Kelly sizing disabled (today's sizes, untouched). */
export function ladderBuyingSizing(settings: GuardSettings & KellySettings, measures: LadderSizingMeasures): BaselineSizing | null {
  if (settings.knifeGuard === "off" && settings.kellySizing === "disabled") return null;
  const kelly = kellyMultiplier(settings, measures);
  const guard = knifeGuardScale(settings, measures);
  const ceiling = settings.kellySizing === "dynamic" && settings.kellyMultiplierRule === "constant" ? settings.kellyConstantMultiplier : settings.kellySizing === "dynamic" ? settings.kellyMaxMultiplier : 1;
  const buyingScale = Math.min(ceiling, Math.max(0, kelly.multiplier * guard.scale));
  const deeperPutsDepth = settings.kellySizing === "dynamic" && settings.kellyAtTops === "deeper_puts" && kelly.topReading && kelly.multiplier < 1 ? kellyDeeperPutsDepthPerCut * (1 - kelly.multiplier) : null;
  return {
    buyingScale,
    pool: settings.kellySizing === "dynamic",
    deeperPutsDepth,
    detail: [settings.kellySizing === "dynamic" ? kelly.detail : null, settings.knifeGuard !== "off" ? guard.detail : null].filter((part) => part !== null).join(" · "),
    scores: { buyingScale, kellyMultiplier: settings.kellySizing === "dynamic" ? kelly.multiplier : null, knifeScale: settings.knifeGuard !== "off" ? guard.scale : null, extensionZ: measures.extensionZ, fallFromHigh: measures.fallFromHigh, marketShareOfFall: measures.marketShareOfFall, spyMove21: measures.spyMove21 },
  };
}
