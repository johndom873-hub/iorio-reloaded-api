import type { PlutoSettings } from "./settingsStore.js";

// Test support: the CC + Put Ladder's settings at their approved defaults (Marcelo 2026-10-15,
// the 20261015300001, 20261015300002 and 20261021400001 migrations), for the tests that spell out a whole PlutoSettings.
export const plutoLadderSettingsFixture = {
  ladderMinAbsDelta: 0.05,
  ladderMaxAbsDelta: 0.3,
  ladderMinDte: 1,
  ladderMaxDte: 45,
  ladderMaxSpreadPctOfMid: 50,
  ladderRungs: 5,
  ladderSharesPct: 50,
  ladderShockMinPct: 60,
  ladderShockMaxPct: 80,
  ladderShockNoHistoryPct: 90,
  ladderShockLookbackYears: 10,
  ladderMaxWorkingOrdersPerTicker: 10,
  ladderSpyStressBreakerPct: 5,
  ladderTickerCooldownMinutes: 0,
  ladderMaxOpenPositionsPerTicker: 30,
  ladderMaxOrdersPerTickerPerDay: 30,
  ladderMaxOpenPositions: 120,
  ladderMaxOrdersPerDay: 100,
} as const satisfies Partial<PlutoSettings>;
