import { describe, expect, it, vi } from "vitest";
import type { BackfillRunStatus, BackfillStep } from "../lib/tickerBackfillSteps.js";
import {
  executeBackfillRun,
  startTickerBackfill,
  waitForBackfillQueue,
  type BackfillRunStore,
  type BackfillStepWorkers,
  type HistoryStepResult,
  type TickerBackfillDependencies,
  type TickerBackfillRun,
} from "./tickerBackfillPipeline.js";
import type { PreparedTicker } from "./runOptionChainCapture.js";

// --- fakes -----------------------------------------------------------------

function inMemoryStore() {
  const runs = new Map<string, TickerBackfillRun>();
  const progressLog: { runId: string; percent: number }[] = [];
  let counter = 0;
  const store: BackfillRunStore = {
    getLatest: async (tickerId) => [...runs.values()].filter((run) => run.tickerId === tickerId).at(-1) ?? null,
    closeRunning: async (tickerId) => {
      for (const run of runs.values()) if (run.tickerId === tickerId && run.status === "running") run.status = "partial";
    },
    create: async (tickerId, steps) => {
      const run: TickerBackfillRun = { id: `run-${++counter}`, tickerId, status: "running", steps, progressPercent: 0, startedAt: new Date().toISOString(), finishedAt: null };
      runs.set(run.id, run);
      return { ...run };
    },
    saveProgress: async (runId, steps) => {
      const run = runs.get(runId)!;
      run.steps = steps;
      run.progressPercent = Math.round((steps.filter((step) => !["pending", "running"].includes(step.status)).length / steps.length) * 100);
      progressLog.push({ runId, percent: run.progressPercent });
    },
    finish: async (runId, status, steps) => {
      const run = runs.get(runId)!;
      Object.assign(run, { status, steps, progressPercent: 100, finishedAt: new Date().toISOString() });
    },
  };
  return { store, runs, progressLog };
}

const history: HistoryStepResult = { barCount: 1253, ivPointCount: 1250, firstTradingDate: "2021-09-22", lastTradingDate: "2026-09-18", suspectedSplitDates: [], invalidBarDates: [] };
const prepared = (): PreparedTicker => ({
  ticker: { tickerId: "t1", symbol: "SMCI", contractId: 1 },
  spotPrice: 40,
  referenceVolatility: 0.6,
  referenceVolatilitySource: "implied_volatility",
  contracts: [
    { expiry: "20261016", strike: 40, right: "P" },
    { expiry: "20261016", strike: 42, right: "C" },
    { expiry: "20261120", strike: 40, right: "P" },
  ],
  chainRefresh: {
    optionParamsMs: 900,
    expiries: [
      { expiry: "20261016", strikeCount: 120, elapsedMs: 4500 },
      { expiry: "20261120", strikeCount: 88, elapsedMs: 4800 },
    ],
    totalMs: 10_200,
  },
});

function workers(overrides: Partial<BackfillStepWorkers> = {}) {
  const disconnect = vi.fn();
  const connect = vi.fn(async () => ({ ib: {} as never, disconnect }));
  const base: BackfillStepWorkers = {
    connect,
    fetchHistory: vi.fn(async () => history),
    captureCalendar: vi.fn(async () => ({ resolved: true, earningsWritten: 2, dividendsWritten: 0, historicalEarningsWritten: 5, historicalEarningsSkippedEtf: false, historicalEarningsError: null })),
    loadUniverseTicker: vi.fn(async (tickerId: string, symbol: string) => ({ tickerId, symbol, contractId: 1 })),
    prepareChain: vi.fn(async () => prepared()),
    now: () => new Date(Date.UTC(2026, 8, 21, 14, 30)),
    ...overrides,
  };
  return { workers: base, connect, disconnect };
}

const statusOf = (steps: BackfillStep[]) => Object.fromEntries(steps.map((step) => [step.key, step.status]));
const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});

// --- executeBackfillRun ------------------------------------------------------

describe("executeBackfillRun", () => {
  it("runs all four steps on one connection; the snapshot step is always skipped, the run completes", async () => {
    const { store, runs } = inMemoryStore();
    const { workers: w, connect, disconnect } = workers();
    const run = await store.create("t1", []);
    runs.get(run.id)!.steps = [];
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const finished = runs.get(run.id)!;
    expect(finished.status).toBe("complete");
    expect(statusOf(finished.steps)).toEqual({ history: "done", calendar: "done", chain_warmup: "done", first_snapshot: "skipped" });
    expect(finished.steps.find((step) => step.key === "history")!.message).toBe("1253 daily bars (2021-09-22 to 2026-09-18), 1250 implied-volatility points.");
    expect(finished.steps.find((step) => step.key === "calendar")!.message).toBe("2 earnings and 0 dividend events. 5 historical earnings dates.");
    expect(finished.steps.find((step) => step.key === "chain_warmup")!.message).toBe("Strike grids stored for 2 expiries (208 strikes) in 10s; 3 contracts selected for capture.");
    expect(finished.steps.find((step) => step.key === "first_snapshot")!.message).toBe("Captured by tonight's job in the normal 10:00 ET window, same as every other ticker.");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("a failing step is marked failed with its error text, the later steps still run, and the run ends partial", async () => {
    const error = silence();
    const { store } = inMemoryStore();
    const { workers: w } = workers({ fetchHistory: async () => { throw new Error("pacing violation"); } });
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const finished = (await store.getLatest("t1"))!;
    expect(finished.status).toBe("partial");
    expect(statusOf(finished.steps)).toEqual({ history: "failed", calendar: "done", chain_warmup: "done", first_snapshot: "skipped" });
    expect(finished.steps[0]!.message).toBe("pacing violation");
    error.mockRestore();
  });

  it("an unresolved calendar is skipped, not failed, and does not make the run partial", async () => {
    const { store } = inMemoryStore();
    const { workers: w } = workers({ captureCalendar: async () => ({ resolved: false, earningsWritten: 0, dividendsWritten: 0, historicalEarningsWritten: 0, historicalEarningsSkippedEtf: false, historicalEarningsError: null }) });
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const finished = (await store.getLatest("t1"))!;
    expect(finished.steps[1]).toMatchObject({ status: "skipped", message: "Ticker not found on TradingView; forward calendar unavailable. 0 historical earnings dates." });
    expect(finished.status).toBe("complete");
  });

  it("if the strike step fails, the snapshot step is skipped with that specific reason", async () => {
    const error = silence();
    const { store } = inMemoryStore();
    const { workers: w } = workers({ prepareChain: async () => { throw new Error("no usable spot price"); } });
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const finished = (await store.getLatest("t1"))!;
    expect(statusOf(finished.steps)).toMatchObject({ chain_warmup: "failed", first_snapshot: "skipped" });
    expect(finished.steps[3]!.message).toBe("Skipped because the strike step did not finish.");
    expect(finished.status).toBe("partial");
    error.mockRestore();
  });

  it("when IBKR cannot be reached, the IBKR steps fail, the calendar still runs, and nothing is left to disconnect", async () => {
    const error = silence();
    const { store } = inMemoryStore();
    const connect = vi.fn(async () => { throw new Error("Timed out connecting to IBKR Gateway."); });
    const { workers: w } = workers({ connect });
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const finished = (await store.getLatest("t1"))!;
    expect(statusOf(finished.steps)).toEqual({ history: "failed", calendar: "done", chain_warmup: "failed", first_snapshot: "skipped" });
    expect(finished.steps[0]!.message).toBe("Timed out connecting to IBKR Gateway.");
    expect(finished.status).toBe("partial");
    error.mockRestore();
  });

  it("adds a note to the history message when the split guard flagged a date", async () => {
    const { store } = inMemoryStore();
    const { workers: w } = workers({ fetchHistory: async () => ({ ...history, suspectedSplitDates: ["2024-10-01"] }) });
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    expect((await store.getLatest("t1"))!.steps[0]!.message).toContain("Possible stock split on 2024-10-01");
  });

  it("reports progress in step order: each step goes running then finished, percent never decreases, and ends at 100", async () => {
    const { store, progressLog } = inMemoryStore();
    const { workers: w } = workers();
    const run = await store.create("t1", []);
    await executeBackfillRun(run.id, "t1", "SMCI", { store, workers: w });
    const percents = progressLog.map((entry) => entry.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(100);
    expect(progressLog.length).toBe(8); // running + finished for each of 4 steps
  });

  it("still records the final state and disconnects when the store itself throws mid-run", async () => {
    const { store } = inMemoryStore();
    const finish = vi.fn(async () => {});
    let saves = 0;
    const flaky: BackfillRunStore = { ...store, finish, saveProgress: async () => { if (++saves === 3) throw new Error("db blip"); } };
    const { workers: w, disconnect } = workers();
    const run = await store.create("t1", []);
    await expect(executeBackfillRun(run.id, "t1", "SMCI", { store: flaky, workers: w })).rejects.toThrow("db blip");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

// --- startTickerBackfill -----------------------------------------------------

describe("startTickerBackfill", () => {
  it("returns immediately with a running run and finishes it in the background", async () => {
    const { store } = inMemoryStore();
    let releaseHistory: () => void = () => {};
    const { workers: w } = workers({ fetchHistory: vi.fn(() => new Promise<HistoryStepResult>((resolve) => { releaseHistory = () => resolve(history); })) });
    const started = await startTickerBackfill("t1", "SMCI", { store, workers: w });
    expect(started.status).toBe("running");
    expect((await store.getLatest("t1"))!.status).toBe("running");
    await vi.waitFor(() => expect(w.fetchHistory).toHaveBeenCalled());
    releaseHistory();
    await waitForBackfillQueue();
    expect((await store.getLatest("t1"))!.status).toBe("complete");
  });

  it("joins a run that is already running instead of starting another", async () => {
    const { store } = inMemoryStore();
    const existing = await store.create("t1", []);
    const create = vi.spyOn(store, "create");
    const { workers: w } = workers();
    const joined = await startTickerBackfill("t1", "SMCI", { store, workers: w });
    expect(joined.id).toBe(existing.id);
    expect(create).not.toHaveBeenCalled();
    expect(w.connect).not.toHaveBeenCalled();
  });

  it("starts a fresh run when the previous one already finished", async () => {
    const { store } = inMemoryStore();
    const { workers: w } = workers();
    const first = await startTickerBackfill("t1", "SMCI", { store, workers: w });
    await waitForBackfillQueue();
    const second = await startTickerBackfill("t1", "SMCI", { store, workers: w });
    await waitForBackfillQueue();
    expect(second.id).not.toBe(first.id);
    expect(w.fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("closes a leftover running row before creating the new run", async () => {
    const { store } = inMemoryStore();
    const closeRunning = vi.spyOn(store, "closeRunning");
    const create = vi.spyOn(store, "create");
    const { workers: w } = workers();
    await startTickerBackfill("t1", "SMCI", { store, workers: w });
    await waitForBackfillQueue();
    expect(closeRunning.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });

  it("runs different tickers one at a time (never two IBKR history requests at once)", async () => {
    const { store } = inMemoryStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const { workers: w } = workers({
      fetchHistory: async (_connection, _tickerId, symbol) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(symbol);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        return history;
      },
    });
    const dependencies: TickerBackfillDependencies = { store, workers: w };
    await Promise.all([startTickerBackfill("t1", "AAA", dependencies), startTickerBackfill("t2", "BBB", dependencies), startTickerBackfill("t3", "CCC", dependencies)]);
    await waitForBackfillQueue();
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("a run that crashes does not block the next queued run", async () => {
    const error = silence();
    const { store } = inMemoryStore();
    let finishCalls = 0;
    const crashingFirst: BackfillRunStore = { ...store, finish: async (runId, status, steps) => { if (++finishCalls === 1) throw new Error("db down"); return store.finish(runId, status, steps); } };
    const { workers: w } = workers();
    await startTickerBackfill("t1", "AAA", { store: crashingFirst, workers: w });
    const second = await startTickerBackfill("t2", "BBB", { store: crashingFirst, workers: w });
    await waitForBackfillQueue();
    expect((await store.getLatest("t2"))!.status).toBe("complete");
    expect(second.tickerId).toBe("t2");
    error.mockRestore();
  });
});

// Keeps the unused-type import honest for the status union the store uses.
export type _RunStatusForTests = BackfillRunStatus;
