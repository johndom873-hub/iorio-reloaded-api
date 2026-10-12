import { defaultBacktestPolicySettings, type BacktestSettings, type BacktestSettingsOverrides, type EffectiveBacktestSettings } from "./backtestTypes.js";

// A session's effective settings: its snapshot with the session-only overrides on top. Pure.

export function applyBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): EffectiveBacktestSettings {
  return {
    pluto: { ...snapshot.pluto, ...overrides.pluto },
    trading: { ...snapshot.trading, ...overrides.trading },
    kellyFraction: overrides.kellyFraction ?? snapshot.kellyFraction,
    // A snapshot stored before the wheel was simulated has neither: the defaults stand in.
    policy: { ...defaultBacktestPolicySettings, ...snapshot.policy, ...overrides.policy },
    decisionMaker: overrides.decisionMaker ?? snapshot.decisionMaker ?? "rules",
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
    (overrides.decisionMaker !== undefined && overrides.decisionMaker !== snapshotDecisionMaker ? 1 : 0)
  );
}
