import { describe, expect, it, vi } from "vitest";
import type { QuoteLoopCycle, QuoteLoopOptionQuote } from "../lib/marketQuoteLoop.js";
import type { OptionQuoteBandCycleWrite, OptionQuoteBandQuoteWrite } from "./optionQuoteBandQuotes.js";
import type { PlutoSettings } from "./settingsStore.js";
import type { PlutoTickerSettings } from "./tickerSettingsStore.js";
import { createLadderQuoteConsumer, createOptionQuoteBandPlanner, type OptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T16:00:00Z");
const ticker: PlutoTickerSettings = { symbol: "LADR", tickerId: "t1", strategy: "cc_put_ladder", allocationPct: null, ladderSharesPct: null, ladderShockOverridePct: null, ladderRungs: null, ladderMinAbsDelta: null, ladderMaxAbsDelta: 0.2, updatedAt: null, updatedByUserId: null };

function dependencies(overrides: Partial<OptionQuoteBandPlannerDependencies> = {}): OptionQuoteBandPlannerDependencies {
  return {
    loadSettings: async () => ({ ladderMinDte: 1, ladderMaxDte: 45, ladderMinAbsDelta: 0.05, ladderMaxAbsDelta: 0.3, volFarmerV2CallMinAbsDelta: 0.1, volFarmerV2CallMaxAbsDelta: 0.3 }) as PlutoSettings,
    loadPaused: async () => false,
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

describe("createOptionQuoteBandPlanner", () => {
  it("plans nothing while Pluto is paused", async () => {
    const planner = createOptionQuoteBandPlanner(dependencies({ loadPaused: async () => true }));
    expect(await planner.tickers(todayIso)).toEqual([]);
    expect((await planner.plan(todayIso, new Map([["t1", 100]]), now)).size).toBe(0);
  });

  it("plans the band of each ladder ticker with a price: the universe is the volume-qualified 1–45 DTE contracts, unknown IVs quoted (Puts below the price)", async () => {
    const planner = createOptionQuoteBandPlanner(dependencies());
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

  it("reads the day's inputs once per trading day and ticker, the forwards again until the band has quotes", async () => {
    const loadChain = vi.fn(dependencies().loadChain);
    let fitDone = false;
    const loadForwardAnchors = vi.fn(async () => (fitDone ? new Map([["2026-11-20", { forward: 100.3, spotPrice: 100 }]]) : new Map()));
    const planner = createOptionQuoteBandPlanner(dependencies({ loadChain, loadForwardAnchors }));
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

  it("a Vol Farmer v2 ticker: only the next listed expiry, built afresh when the ticker's strategy changes during the day", async () => {
    // 23 Oct (3 DTE) is the next listed expiry; 20 Nov (31 DTE) is inside the ladder's range but not v2's.
    const chain = { expirations: ["20261120", "20261023"], strikesByExpiry: new Map([["20261120", [80, 100]], ["20261023", [80, 100]]]), fetchedAt: null };
    const volume = new Map(["2026-11-20|80|P", "2026-11-20|100|C", "2026-10-23|80|P", "2026-10-23|100|C"].map((key) => [key, 100]));
    let strategy: PlutoTickerSettings["strategy"] = null;
    const loadChain = vi.fn(async () => chain);
    const planner = createOptionQuoteBandPlanner(dependencies({ loadEnabledTickers: async () => [{ ...ticker, strategy }], loadChain, loadPreviousSessionVolume: async () => volume }));
    const expiriesOf = async () => [...new Set((await planner.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan.contracts.map((contract) => contract.expiry))];
    expect(await expiriesOf()).toEqual(["2026-10-23"]);
    strategy = "cc_put_ladder";
    expect((await expiriesOf()).sort()).toEqual(["2026-10-23", "2026-11-20"]);
    expect(loadChain).toHaveBeenCalledTimes(2);
  });

  it("without the previous session's volumes, the ticker's expiry is taken whole: the 20% rule is lifted on it for the day", async () => {
    const withVolumes = createOptionQuoteBandPlanner(dependencies());
    // The volumes above give the $80, $90, $100 Puts and the $100 Call; without any, the $80 and $90 Calls join them.
    expect((await withVolumes.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan.universeCount).toBe(4);
    const planner = createOptionQuoteBandPlanner(dependencies({ loadPreviousSessionVolume: async () => null }));
    expect((await planner.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan.universeCount).toBe(6);
  });
});

describe("createLadderQuoteConsumer", () => {
  const cycleStart = new Date("2026-10-20T16:00:00Z");
  const finishedAt = new Date("2026-10-20T16:00:40Z");
  const cycle = (cycleNumber: number): QuoteLoopCycle => ({ tradingDateIso: todayIso, cycleNumber, now: cycleStart, spotByTicker: new Map([["t1", 100], ["t2", 50]]), impliedVolatilityByTicker: new Map() });
  const quote = (tickerId: string, strike: number, right: "C" | "P" = "P"): QuoteLoopOptionQuote => ({ contract: { tickerId, symbol: tickerId === "t1" ? "LADR" : "VFV", expiry: "2026-11-20", strike, right }, bid: 1, ask: 1.1, last: null, errorCode: null, quotedAt: new Date("2026-10-20T16:00:10Z") });
  const consumerWith = (store: (writes: OptionQuoteBandQuoteWrite[]) => Promise<void>, recordFinished: (writes: OptionQuoteBandCycleWrite[]) => Promise<void>) => createLadderQuoteConsumer(createOptionQuoteBandPlanner(dependencies()), store, recordFinished, () => finishedAt);

  it("records each quoted ticker's cycle as finished once every batch of it is stored", async () => {
    let releaseFirstBatch!: () => void;
    const firstBatchStored = new Promise<void>((resolve) => (releaseFirstBatch = resolve));
    const batchSizes: number[] = [];
    const store = vi.fn(async (writes: OptionQuoteBandQuoteWrite[]) => {
      batchSizes.push(writes.length);
      if (batchSizes.length === 1) await firstBatchStored;
    });
    const recordFinished = vi.fn(async (_writes: OptionQuoteBandCycleWrite[]) => {});
    const consumer = consumerWith(store, recordFinished);
    // LADR's 20 Puts fill the first batch; its Call and VFV's two quotes are stored at the end of the cycle.
    const quotes = [...Array.from({ length: 20 }, (_, index) => quote("t1", 60 + index)), quote("t1", 105, "C"), quote("t2", 45), quote("t2", 55, "C")];
    for (const each of quotes) consumer.onQuote!(each, cycle(7));
    const completing = consumer.onCycleComplete!(quotes, cycle(7));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batchSizes).toEqual([20, 3]);
    expect(recordFinished).not.toHaveBeenCalled();
    releaseFirstBatch();
    await completing;
    expect(recordFinished).toHaveBeenCalledWith([
      { tickerId: "t1", tradingDateIso: todayIso, cycleNumber: 7, startedAt: cycleStart, finishedAt },
      { tickerId: "t2", tradingDateIso: todayIso, cycleNumber: 7, startedAt: cycleStart, finishedAt },
    ]);
  });

  it("does not record a cycle with a batch that failed to store; the next cycle is recorded", async () => {
    let failNextWrite = true;
    const store = vi.fn(async (_writes: OptionQuoteBandQuoteWrite[]) => {
      if (!failNextWrite) return;
      failNextWrite = false;
      throw new Error("connection lost");
    });
    const recordFinished = vi.fn(async (_writes: OptionQuoteBandCycleWrite[]) => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consumer = consumerWith(store, recordFinished);
    const quotes = Array.from({ length: 21 }, (_, index) => quote("t1", 60 + index));
    for (const each of quotes) consumer.onQuote!(each, cycle(7));
    await consumer.onCycleComplete!(quotes, cycle(7));
    expect(recordFinished).not.toHaveBeenCalled();
    for (const each of quotes) consumer.onQuote!(each, cycle(8));
    await consumer.onCycleComplete!(quotes, cycle(8));
    expect(recordFinished).toHaveBeenCalledTimes(1);
    expect(recordFinished.mock.calls[0]![0]).toMatchObject([{ tickerId: "t1", cycleNumber: 8 }]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("option quote band write failed — connection lost"));
    consoleError.mockRestore();
  });

  it("leaves a failed last batch for the loop to report, and records nothing", async () => {
    const recordFinished = vi.fn(async (_writes: OptionQuoteBandCycleWrite[]) => {});
    const consumer = consumerWith(async () => Promise.reject(new Error("connection lost")), recordFinished);
    const quotes = [quote("t1", 60)];
    consumer.onQuote!(quotes[0]!, cycle(7));
    await expect(consumer.onCycleComplete!(quotes, cycle(7))).rejects.toThrow("connection lost");
    expect(recordFinished).not.toHaveBeenCalled();
  });
});
