import { describe, expect, it, vi } from "vitest";
import type { PlutoSettings } from "./settingsStore.js";
import type { PlutoTickerSettings } from "./tickerSettingsStore.js";
import { createLadderBandPlanner, type LadderBandPlannerDependencies } from "./ladderBandPlanLoader.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T16:00:00Z");
const ticker: PlutoTickerSettings = { symbol: "LADR", tickerId: "t1", allocationPct: null, ladderSharesPct: null, ladderShockOverridePct: null, ladderRungs: null, ladderMinAbsDelta: null, ladderMaxAbsDelta: 0.2, updatedAt: null, updatedByUserId: null };

function dependencies(overrides: Partial<LadderBandPlannerDependencies> = {}): LadderBandPlannerDependencies {
  return {
    loadSettings: async () => ({ executionStrategy: "cc_put_ladder", ladderMinDte: 1, ladderMaxDte: 45, ladderMinAbsDelta: 0.05, ladderMaxAbsDelta: 0.3 }) as PlutoSettings,
    loadEnabledTickers: async () => [ticker],
    // 20 Nov (31 DTE): the $80, $90 and $100 Puts and Calls.
    loadChain: async () => ({ expirations: ["20261120"], strikesByExpiry: new Map([["20261120", [80, 90, 100]]]), fetchedAt: null }),
    loadPreviousSessionVolume: async () => new Map(["2026-11-20|80|P", "2026-11-20|90|P", "2026-11-20|100|P", "2026-11-20|100|C"].map((key) => [key, 100])),
    loadOvernightImpliedVolatility: async () => new Map(),
    loadForwardAnchors: async () => new Map([["2026-11-20", { forward: 100.3, spotPrice: 100 }]]),
    loadClock: async () => ({ todayIso, closeMinutesEt: 16 * 60, riskFreeRate: 0.04 }),
    loadBandQuotes: async () => [],
    ...overrides,
  };
}

describe("createLadderBandPlanner", () => {
  it("plans nothing while another strategy is active", async () => {
    const planner = createLadderBandPlanner(dependencies({ loadSettings: async () => ({ executionStrategy: "edge_margin" }) as PlutoSettings }));
    expect(await planner.tickers(todayIso)).toEqual([]);
    expect((await planner.plan(todayIso, new Map([["t1", 100]]), now)).size).toBe(0);
  });

  it("plans the band of each ladder ticker with a price: the universe is the volume-qualified 1–45 DTE contracts, unknown IVs quoted (Puts below the price)", async () => {
    const planner = createLadderBandPlanner(dependencies());
    expect(await planner.tickers(todayIso)).toEqual([{ tickerId: "t1", symbol: "LADR" }]);
    const plans = await planner.plan(todayIso, new Map([["t1", 100]]), now);
    // 4 contracts with volume (the $80 and $90 Calls had none); no IV known yet: the $100 Call and the Puts below $100 are
    // quoted, not the $100 Put at the price (a ladder Put is under the rung's cap, below the price).
    expect(plans.get("t1")).toMatchObject({ symbol: "LADR", plan: { universeCount: 4, unknownImpliedVolatilityCount: 4, firstLookOfDay: true } });
    expect(plans.get("t1")!.plan.contracts).toEqual([
      { expiry: "2026-11-20", strike: 80, right: "P" },
      { expiry: "2026-11-20", strike: 90, right: "P" },
      { expiry: "2026-11-20", strike: 100, right: "C" },
    ]);
    expect((await planner.plan(todayIso, new Map([["t1", null]]), now)).size).toBe(0);
  });

  it("reads the day's inputs once per trading day and ticker, Pluto's forwards again until today's fit exists", async () => {
    const loadChain = vi.fn(dependencies().loadChain);
    let fitDone = false;
    const loadForwardAnchors = vi.fn(async () => (fitDone ? new Map([["2026-11-20", { forward: 100.3, spotPrice: 100 }]]) : new Map()));
    const planner = createLadderBandPlanner(dependencies({ loadChain, loadForwardAnchors }));
    await planner.plan(todayIso, new Map([["t1", 100]]), now);
    await planner.plan(todayIso, new Map([["t1", 100]]), now);
    fitDone = true;
    await planner.plan(todayIso, new Map([["t1", 100]]), now);
    await planner.plan(todayIso, new Map([["t1", 100]]), now);
    expect(loadChain).toHaveBeenCalledTimes(1);
    // Before the fit: read at every cycle (3 times); once found, kept.
    expect(loadForwardAnchors).toHaveBeenCalledTimes(3);
    await planner.plan("2026-10-21", new Map([["t1", 100]]), now);
    expect(loadChain).toHaveBeenCalledTimes(2);
  });

  it("without the previous session's volumes, the ticker's universe is empty: the 20% rule sells none of an unknown volume", async () => {
    const planner = createLadderBandPlanner(dependencies({ loadPreviousSessionVolume: async () => null }));
    expect((await planner.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan).toMatchObject({ universeCount: 0, contracts: [] });
  });
});
