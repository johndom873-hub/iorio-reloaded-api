import type { PlutoSettings } from "./settingsStore.js";

// Test support: the strategy switch and the CC + Put Ladder's settings at their approved defaults (Marcelo 2026-10-15,
// the 20261015300001 and 20261015300002 migrations), for the tests that spell out a whole PlutoSettings.
export const plutoLadderSettingsFixture = {
  executionStrategy: "edge_margin",
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
  ladderMaxWorkingOrdersPerTicker: 5,
  ladderSpyStressBreakerPct: 5,
  ladderTickerCooldownMinutes: 0,
  ladderMaxOpenPositionsPerTicker: 5,
  ladderMaxOrdersPerTickerPerDay: 30,
} as const satisfies Partial<PlutoSettings>;
