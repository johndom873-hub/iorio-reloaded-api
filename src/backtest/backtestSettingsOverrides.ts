import type { BacktestSettings, BacktestSettingsOverrides } from "./backtestTypes.js";

// A session's effective settings: its snapshot with the session-only overrides on top. Pure.

export function applyBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): BacktestSettings {
  return {
    pluto: { ...snapshot.pluto, ...overrides.pluto },
    trading: { ...snapshot.trading, ...overrides.trading },
    kellyFraction: overrides.kellyFraction ?? snapshot.kellyFraction,
  };
}

/** How many values the overrides change (a value equal to the snapshot's does not count). */
export function countBacktestOverrides(snapshot: BacktestSettings, overrides: BacktestSettingsOverrides): number {
  const changedIn = (base: object, changes: object | undefined) =>
    Object.entries(changes ?? {}).filter(([key, value]) => (base as Record<string, unknown>)[key] !== value).length;
  return changedIn(snapshot.pluto, overrides.pluto) + changedIn(snapshot.trading, overrides.trading) + (overrides.kellyFraction !== undefined && overrides.kellyFraction !== snapshot.kellyFraction ? 1 : 0);
}
