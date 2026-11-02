import type { PlutoSettings } from "./settingsStore.js";

// Test support: the Safety Limits at their approved defaults (the 20261030300001 migration), for the tests that spell out
// a whole PlutoSettings.
export const plutoSafetyLimitsSettingsFixture = {
  safetyMaxWorkingOrdersPerTicker: 10,
  safetySpyStressBreakerPct: 5,
  safetyTickerCooldownMinutes: 0,
  safetyMaxOpenPositionsPerTicker: 30,
  safetyMaxOrdersPerTickerPerDay: 30,
  safetyMaxOpenPositions: 120,
  safetyMaxOrdersPerDay: 100,
} as const satisfies Partial<PlutoSettings>;

// Vol Farmer v4's settings at their migration defaults (20261101100001, the lab's best run of 2026-10-30; the buyback 20261102500001).
export const plutoVolFarmerV4SettingsFixture = {
  volFarmerV4FirstPositionPct: 80,
  volFarmerV4PutsStartCallYieldPct: 5,
  volFarmerV4PutMaxAbsDelta: 0.3,
  volFarmerV4StepBelowFirstBreakEvenPct: 15,
  volFarmerV4StepRule: "implied_move_at_put_sale",
  volFarmerV4LeapsMinDte: 180,
  volFarmerV4LeapsAbsDelta: 0.6,
  volFarmerV4LeapsMaxAllocationPct: 10,
  volFarmerV4CallMinAbsDelta: 0.05,
  volFarmerV4CallMaxAbsDelta: 0.5,
  volFarmerV4MaxSpreadPctOfMid: 50,
  volFarmerV4RebalanceBandPct: 20,
  volFarmerV4Rebalances: "both_positions",
  volFarmerV4FirstPositionAfterCalledAway: "wait",
  volFarmerV4OptionsExpiry: "today",
  volFarmerV4OptionsMaxDaysToExpiry: 45,
  volFarmerV4CallStrikeFloor: "none",
  volFarmerV4PutsSold: "calls_yield_little",
  volFarmerV4PutStrikeCap: "first_break_even_less_step",
  volFarmerV4TrimsSell: "higher_break_even_first",
  volFarmerV4TopUpCapPct: 0,
  volFarmerV4CallsInTheMoneyAtLastLook: "assigned",
} as const satisfies Partial<PlutoSettings>;
