import { defaultBacktestBaselineSettings, defaultBacktestModelSettings, defaultBacktestPolicySettings, defaultBacktestSteadyStakeSettings, defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, type BacktestSettings, type BacktestSettingsOverrides, type EffectiveBacktestSettings } from "./backtestTypes.js";

// A session's effective settings: its snapshot with the session-only overrides on top. Pure.

export function applyBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): EffectiveBacktestSettings {
  return {
    pluto: { ...snapshot.pluto, ...overrides.pluto },
    trading: { ...snapshot.trading, ...overrides.trading },
    kellyFraction: overrides.kellyFraction ?? snapshot.kellyFraction,
    // The policy and the model were read by the retired rules sessions only; a snapshot stored before they existed has
    // neither, and the defaults stand in.
    policy: { ...defaultBacktestPolicySettings, ...snapshot.policy, ...overrides.policy },
    // A snapshot stored before the decision maker could change is a rules session's.
    decisionMaker: overrides.decisionMaker ?? snapshot.decisionMaker ?? "rules",
    model: { ...defaultBacktestModelSettings, ...snapshot.model, ...overrides.model },
    baseline: { ...defaultBacktestBaselineSettings, ...snapshot.baseline, ...overrides.baseline },
    steadyStake: { ...defaultBacktestSteadyStakeSettings, ...snapshot.steadyStake, ...overrides.steadyStake },
    volFarmer: { ...defaultBacktestVolFarmerSettings, ...snapshot.volFarmer, ...overrides.volFarmer },
    volFarmerV2: { ...defaultBacktestVolFarmerV2Settings, ...snapshot.volFarmerV2, ...overrides.volFarmerV2 },
  };
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
    changedIn({ ...defaultBacktestSteadyStakeSettings, ...snapshot.steadyStake }, overrides.steadyStake) +
    changedIn({ ...defaultBacktestVolFarmerSettings, ...snapshot.volFarmer }, overrides.volFarmer) +
    changedIn({ ...defaultBacktestVolFarmerV2Settings, ...snapshot.volFarmerV2 }, overrides.volFarmerV2)
  );
}
