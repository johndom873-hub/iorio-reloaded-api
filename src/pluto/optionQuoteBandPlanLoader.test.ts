import { describe, expect, it, vi } from "vitest";
import type { QuoteLoopCycle, QuoteLoopOptionQuote } from "../lib/marketQuoteLoop.js";
import type { OptionQuoteBandCycleWrite, OptionQuoteBandQuoteWrite } from "./optionQuoteBandQuotes.js";
import type { PlutoSettings } from "./settingsStore.js";
import type { PlutoTickerSettings } from "./tickerSettingsStore.js";
import { createOptionQuoteBandConsumer, createOptionQuoteBandPlanner, type OptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T16:00:00Z");
const ticker: PlutoTickerSettings = { symbol: "LADR", tickerId: "t1", allocationPct: null, alwaysHoldTheStock: null, updatedAt: null, updatedByUserId: null };

function dependencies(overrides: Partial<OptionQuoteBandPlannerDependencies> = {}): OptionQuoteBandPlannerDependencies {
  return {
    loadSettings: async () => ({ volFarmerV4CallMinAbsDelta: 0.1, volFarmerV4CallMaxAbsDelta: 0.3, volFarmerV4OptionsExpiry: "next" }) as PlutoSettings,
    loadPaused: async () => false,
    loadEnabledTickers: async () => [ticker],
    // 20 Nov (31 DTE): the $80, $90 and $100 Puts and Calls.
    loadChain: async () => ({ expirations: ["20261120"], strikesByExpiry: new Map([["20261120", [80, 90, 100]]]), fetchedAt: null }),
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

  it("plans the band of each ticker with a price: the universe is the next expiry's contracts, unknown IVs quoted (Puts below the price)", async () => {
    const planner = createOptionQuoteBandPlanner(dependencies());
    expect(await planner.tickers(todayIso)).toEqual([{ tickerId: "t1", symbol: "LADR" }]);
    const plans = await planner.plan(todayIso, new Map([["t1", 100]]), now);
    // 6 contracts (the $80, $90 and $100 strikes, both rights); no IV known yet: every Call and the Puts below $100 are
    // quoted, not the $100 Put at the price (a Put is sold below the price).
    expect(plans.get("t1")).toMatchObject({ symbol: "LADR", plan: { universeCount: 6, unknownImpliedVolatilityCount: 6, firstLookOfDay: true } });
    expect(plans.get("t1")!.plan.contracts).toEqual([
      { expiry: "2026-11-20", strike: 80, right: "C" },
      { expiry: "2026-11-20", strike: 80, right: "P" },
      { expiry: "2026-11-20", strike: 90, right: "C" },
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

  it("a ticker selling the next expiry: only the next listed one", async () => {
    // 23 Oct (3 DTE) is the next listed expiry; 20 Nov (31 DTE) is later.
    const chain = { expirations: ["20261120", "20261023"], strikesByExpiry: new Map([["20261120", [80, 100]], ["20261023", [80, 100]]]), fetchedAt: null };
    const planner = createOptionQuoteBandPlanner(dependencies({ loadChain: async () => chain }));
    const expiries = [...new Set((await planner.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan.contracts.map((contract) => contract.expiry))];
    expect(expiries).toEqual(["2026-10-23"]);
  });

  it("a Vol Farmer v4 ticker selling today's expiry: only the one ending at today's close, none on a day without one, built afresh when the setting changes", async () => {
    // Tue 20 Oct lists 20 Oct (0 DTE) and 23 Oct; Wed 21 Oct lists no expiry ending that day.
    const chain = { expirations: ["20261020", "20261023"], strikesByExpiry: new Map([["20261020", [80, 100]], ["20261023", [80, 100]]]), fetchedAt: null };
    let optionsExpiry: PlutoSettings["volFarmerV4OptionsExpiry"] = "today";
    const loadChain = vi.fn(async () => chain);
    const planner = createOptionQuoteBandPlanner(
      dependencies({ loadSettings: async () => ({ volFarmerV4CallMinAbsDelta: 0.05, volFarmerV4CallMaxAbsDelta: 0.5, volFarmerV4OptionsExpiry: optionsExpiry }) as PlutoSettings, loadChain }),
    );
    const expiriesOn = async (dayIso: string) => [...new Set((await planner.plan(dayIso, new Map([["t1", 100]]), new Date(`${dayIso}T16:00:00Z`))).get("t1")!.plan.contracts.map((contract) => contract.expiry))];
    expect(await expiriesOn(todayIso)).toEqual(["2026-10-20"]);
    optionsExpiry = "next";
    expect(await expiriesOn(todayIso)).toEqual(["2026-10-23"]);
    expect(loadChain).toHaveBeenCalledTimes(2);
    optionsExpiry = "today";
    expect(await expiriesOn("2026-10-21")).toEqual([]);
  });

  it("quotes every contract of the ticker's expiry, whatever its volume", async () => {
    const planner = createOptionQuoteBandPlanner(dependencies());
    // The default chain lists the $80, $90 and $100 strikes of one expiry, both rights.
    expect((await planner.plan(todayIso, new Map([["t1", 100]]), now)).get("t1")!.plan.universeCount).toBe(6);
  });
});

describe("createOptionQuoteBandConsumer", () => {
  const cycleStart = new Date("2026-10-20T16:00:00Z");
  const finishedAt = new Date("2026-10-20T16:00:40Z");
  const cycle = (cycleNumber: number): QuoteLoopCycle => ({ tradingDateIso: todayIso, cycleNumber, now: cycleStart, spotByTicker: new Map([["t1", 100], ["t2", 50]]), impliedVolatilityByTicker: new Map() });
  const quote = (tickerId: string, strike: number, right: "C" | "P" = "P"): QuoteLoopOptionQuote => ({ contract: { tickerId, symbol: tickerId === "t1" ? "LADR" : "VFV", expiry: "2026-11-20", strike, right }, bid: 1, ask: 1.1, last: null, bidSize: 10, askSize: 10, errorCode: null, quotedAt: new Date("2026-10-20T16:00:10Z") });
  const consumerWith = (store: (writes: OptionQuoteBandQuoteWrite[]) => Promise<void>, recordFinished: (writes: OptionQuoteBandCycleWrite[]) => Promise<void>) => createOptionQuoteBandConsumer(createOptionQuoteBandPlanner(dependencies()), store, recordFinished, () => finishedAt);

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
