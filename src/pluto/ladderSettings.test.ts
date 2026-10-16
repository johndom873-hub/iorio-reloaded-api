import { describe, expect, it } from "vitest";
import { defaultBacktestBaselineSettings } from "../backtest/backtestTypes.js";
import { validateBaselineSettings } from "../backtest/jobs/backtestSessionRequest.js";
import { ladderBaselineFromPlutoSettings } from "./ladderSettings.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

// The values the all-tickers run of 2026-10-15 used (tmp/ladder-research/specs_current_all.json, the 50% variant):
// what Marcelo adopted for the CC + Put Ladder.
const adoptedBaselineOverrides = {
  entry: "covered_call", minAbsDelta: 0.05, maxAbsDelta: 0.3, minDte: 1, maxDte: 45, callStrike: "above_break_even", entryCallStrike: "any", callDeltaRange: "entry_range",
  ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "fill_down_ranking", earnings: "ignore", maxAccountPctPerStock: 100, maxSharesPctOfAccount: 100,
  takeProfitPct: 0, shareStopLossPct: 0, looks: "every_look", putsWhenNoCall: "reserve_ladder", ladderSharesPct: 50, ladderTop: "price", ladderPace: "any_look",
  ladderShock: "history", ladderRungs: 5, entryWhenSharesUncovered: "buy", ladderShockMinPct: 60, ladderShockMaxPct: 80, maxSpreadPctOfMid: 50,
  ladderPutVersusCall: "higher_yield", ladderPutYieldMarginPct: 0,
  // Marcelo 2026-10-16: the |delta| range is the Calls'; the ladder's Puts go by the rung's cap.
  ladderPutDeltaRange: "none",
} as const;

const settingsAtDefaults = plutoLadderSettingsFixture as unknown as PlutoSettings;

describe("ladderBaselineFromPlutoSettings", () => {
  it("at the approved defaults, is exactly the adopted backtest configuration", () => {
    const live = { ...defaultBacktestBaselineSettings, ...ladderBaselineFromPlutoSettings(settingsAtDefaults) };
    const adopted = { ...defaultBacktestBaselineSettings, ...adoptedBaselineOverrides };
    expect(live).toEqual(adopted);
  });

  it("is a valid backtest baseline, so a session can replay it", () => {
    expect(validateBaselineSettings({ ...defaultBacktestBaselineSettings, ...ladderBaselineFromPlutoSettings(settingsAtDefaults, { ladderSharesPct: 30, ladderRungs: 4, minAbsDelta: 0.08, maxAbsDelta: 0.25 }) })).toBeNull();
  });

  it("takes each ticker override it is given and the strategy's value for the rest", () => {
    const baseline = ladderBaselineFromPlutoSettings({ ...settingsAtDefaults, ladderMaxAbsDelta: 0.25, ladderRungs: 4 }, { ladderSharesPct: 70, ladderRungs: null, minAbsDelta: 0.1, maxAbsDelta: null });
    expect(baseline).toMatchObject({ ladderSharesPct: 70, minAbsDelta: 0.1, maxAbsDelta: 0.25, ladderRungs: 4 });
  });
});
