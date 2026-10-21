import { defaultBacktestBaselineSettings, defaultBacktestModelSettings, defaultBacktestPolicySettings, defaultBacktestSteadyStakeSettings, type BacktestModelSettings, type BacktestSettings, type BacktestSettingsOverrides, type EffectiveBacktestSettings } from "./backtestTypes.js";
import { liveSurfaceFitLimits, type SurfaceFitLimits } from "../lib/impliedVolatilitySurface.js";
import { gradeMarginCutPoints, type GradeMarginCutPoints } from "../lib/contractValuation.js";
import type { TradingSettings } from "../lib/tradingSettingsStore.js";

// A session's effective settings: its snapshot with the session-only overrides on top. Pure.

export function applyBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): EffectiveBacktestSettings {
  return {
    pluto: { ...snapshot.pluto, ...overrides.pluto },
    trading: { ...snapshot.trading, ...overrides.trading },
    kellyFraction: overrides.kellyFraction ?? snapshot.kellyFraction,
    // A snapshot stored before the wheel was simulated has neither: the defaults stand in.
    policy: { ...defaultBacktestPolicySettings, ...snapshot.policy, ...overrides.policy },
    decisionMaker: overrides.decisionMaker ?? snapshot.decisionMaker ?? "rules",
    model: { ...defaultBacktestModelSettings, ...snapshot.model, ...overrides.model },
    baseline: { ...defaultBacktestBaselineSettings, ...snapshot.baseline, ...overrides.baseline },
    steadyStake: { ...defaultBacktestSteadyStakeSettings, ...snapshot.steadyStake, ...overrides.steadyStake },
  };
}

/** The share of the half-spread the model charges, percent: the model's own, else the fills' (sessions before the split). */
export function modelSpreadCostChargedPct(settings: Pick<EffectiveBacktestSettings, "model" | "trading">): number {
  return settings.model.spreadCostChargedPct ?? settings.trading.spreadCostChargedPct;
}

/** The trading settings the model scores with: the session's, with the model's spread cost share. The same object when nothing differs. */
export function tradingSettingsForScoring(settings: Pick<EffectiveBacktestSettings, "model" | "trading">): TradingSettings {
  const trading = settings.trading as TradingSettings;
  const modelShare = modelSpreadCostChargedPct(settings);
  return modelShare === trading.spreadCostChargedPct ? trading : { ...trading, spreadCostChargedPct: modelShare };
}

/** The surface fit's limits of a session: live's object when the session keeps live's values. */
export function surfaceFitLimitsOf(model: BacktestModelSettings): SurfaceFitLimits {
  const limits = { maximumSpreadFractionOfMid: model.surfaceMaxSpreadPctOfMid / 100, minimumPointsPerSlice: model.surfaceMinPointsPerSlice, maximumSliceRmseVolatility: model.surfaceMaxRmseVp / 100 };
  const same = (Object.keys(limits) as (keyof SurfaceFitLimits)[]).every((key) => limits[key] === liveSurfaceFitLimits[key]);
  return same ? liveSurfaceFitLimits : limits;
}

/** The grade cut points of a session, as fractions; null when they are live's (nothing to re-grade). */
export function gradeCutPointsOf(model: BacktestModelSettings): GradeMarginCutPoints | null {
  const cutPoints = { strong: model.gradeStrongMarginPct / 100, good: model.gradeGoodMarginPct / 100, weak: model.gradeWeakMarginPct / 100 };
  return cutPoints.strong === gradeMarginCutPoints.strong && cutPoints.good === gradeMarginCutPoints.good && cutPoints.weak === gradeMarginCutPoints.weak ? null : cutPoints;
}

/** How many values the overrides change (a value equal to the snapshot's does not count). */
export function countBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): number {
  const changedIn = (base: object, changes: object | undefined) =>
    Object.entries(changes ?? {}).filter(([key, value]) => (base as Record<string, unknown>)[key] !== value).length;
  const snapshotDecisionMaker = snapshot.decisionMaker ?? "rules";
  return (
    changedIn(snapshot.pluto, overrides.pluto) +
    changedIn(snapshot.trading, overrides.trading) +
    changedIn({ ...defaultBacktestPolicySettings, ...snapshot.policy }, overrides.policy) +
    (overrides.kellyFraction !== undefined && overrides.kellyFraction !== snapshot.kellyFraction ? 1 : 0) +
    (overrides.decisionMaker !== undefined && overrides.decisionMaker !== snapshotDecisionMaker ? 1 : 0) +
    changedIn({ ...defaultBacktestModelSettings, ...snapshot.model }, overrides.model) +
    changedIn({ ...defaultBacktestBaselineSettings, ...snapshot.baseline }, overrides.baseline) +
    changedIn({ ...defaultBacktestSteadyStakeSettings, ...snapshot.steadyStake }, overrides.steadyStake)
  );
}
