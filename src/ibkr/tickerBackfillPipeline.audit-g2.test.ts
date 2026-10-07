import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit (G2, 2026-10-07): setups restarted after a server restart (c557ee9) and the option-chain scope started by the Signals
// switch (851800e), against the real run store on the test database. IBKR / network work is faked; every assertion is narrowed to
// the tickers this file creates (listRunning is filtered to them, so other files' rows are never closed or restarted).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the backfill audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => undefined) }));

const { db } = await import("../db/connection.js");
const { databaseRunStore, resumeInterruptedBackfillRuns, startTickerBackfill, waitForBackfillQueue } = await import("./tickerBackfillPipeline.js");
const { buildInitialBackfillSteps, updateStep } = await import("../lib/tickerBackfillSteps.js");
type Store = typeof databaseRunStore;
type Workers = Parameters<typeof resumeInterruptedBackfillRuns>[0] extends infer D ? (D extends { workers: infer W } ? W : never) : never;
const testDb: Knex = db;

const createdTickerIds: string[] = [];
let userId = "";
let counter = Date.now() % 100_000;

async function createTicker(options: { signalsEnabled?: boolean; onShortlist?: boolean } = {}): Promise<{ id: string; symbol: string }> {
  const symbol = `AG2${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Backfill Audit Co", sector: "Technology", ibkr_contract_id: 31337 }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: options.signalsEnabled ?? false, removed_at: options.onShortlist === false ? new Date() : null });
  return { id: ticker.id, symbol };
}

/** listRunning narrowed to this file's tickers, so a resume here never touches another file's runs. */
function scopedStore(overrides: Partial<Store> = {}): Store {
  return {
    ...databaseRunStore,
    listRunning: async () => (await databaseRunStore.listRunning()).filter((run) => createdTickerIds.includes(run.tickerId)),
    ...overrides,
  };
}

function fakeWorkers(overrides: Partial<Workers> = {}) {
  const fetchHistory = vi.fn(async () => ({ barCount: 10, ivPointCount: 10, firstTradingDate: "2021-10-01", lastTradingDate: "2026-10-06", suspectedSplitDates: [], invalidBarDates: [] }));
  const prepareChain = vi.fn(async () => ({
    ticker: { tickerId: "x", symbol: "X", contractId: 1 },
    spotPrice: 10,
    referenceVolatility: 0.3,
    referenceVolatilitySource: "implied_volatility",
    contracts: [],
    chainRefresh: { optionParamsMs: 1, expiries: [{ expiry: "20261120", strikeCount: 5, elapsedMs: 1 }], totalMs: 1 },
  }));
  const workers = {
    connect: vi.fn(async () => ({ ib: {} as never, disconnect: vi.fn() })),
    fetchHistory,
    captureCalendar: vi.fn(async () => ({ resolved: true, earningsWritten: 1, dividendsWritten: 0, historicalEarningsWritten: 1, historicalEarningsSkippedEtf: false, historicalEarningsError: null })),
    loadUniverseTicker: vi.fn(async (tickerId: string, symbol: string) => ({ tickerId, symbol, contractId: 1 })),
    // The real worker's query, so a Signals-off or removed ticker is read from the database as in production.
    loadSignalsEnabled: vi.fn(async (tickerId: string) => Boolean((await testDb("shortlist_entries").where({ ticker_id: tickerId }).whereNull("removed_at").first("signals_enabled"))?.signals_enabled)),
    prepareChain,
    now: () => new Date("2026-10-07T14:00:00Z"),
    ...overrides,
  } as unknown as Workers;
  return { workers, fetchHistory, prepareChain };
}

async function insertInterruptedRun(tickerId: string, options: { scope?: "full" | "option_chain"; resumedFromRunId?: string; startedMinutesAgo?: number } = {}): Promise<string> {
  const steps =
    options.scope === "option_chain"
      ? updateStep(buildInitialBackfillSteps("option_chain"), "chain_warmup", "running", null)
      : updateStep(updateStep(buildInitialBackfillSteps(), "history", "done", "10 daily bars"), "calendar", "running", null);
  const [row] = await testDb("ticker_backfill_runs")
    .insert({
      ticker_id: tickerId,
      status: "running",
      steps: JSON.stringify(steps),
      progress_percent: 25,
      started_at: new Date(Date.now() - (options.startedMinutesAgo ?? 2) * 60_000),
      resumed_from_run_id: options.resumedFromRunId ?? null,
    })
    .returning("id");
  return row.id;
}

const runsOf = (tickerId: string) => testDb("ticker_backfill_runs").where({ ticker_id: tickerId }).orderBy("started_at", "asc");
const statusOf = (steps: { key: string; status: string }[]) => Object.fromEntries(steps.map((step) => [step.key, step.status]));

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `backfill-audit-g2-${Date.now()}`, display_name: "Backfill Audit Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

beforeEach(async () => {
  await waitForBackfillQueue();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  await waitForBackfillQueue();
  // Resumed runs reference the run they replace: clear the link first, then the rows.
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).update({ resumed_from_run_id: null });
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("resumeInterruptedBackfillRuns against the database", () => {
  it("closes a run cut off during the calendar step, restarts it from scratch linked to it, and the Signals-off ticker skips the chain", async () => {
    const ticker = await createTicker({ signalsEnabled: false });
    const interruptedId = await insertInterruptedRun(ticker.id);
    const { workers, fetchHistory, prepareChain } = fakeWorkers();

    const result = await resumeInterruptedBackfillRuns({ store: scopedStore(), workers });
    await waitForBackfillQueue();

    expect(result.resumed).toEqual([ticker.symbol]);
    const [closed, restarted] = await runsOf(ticker.id);
    expect(closed).toMatchObject({ id: interruptedId, status: "partial", progress_percent: 100 });
    expect(closed.finished_at).not.toBeNull();
    expect(statusOf(closed.steps)).toEqual({ history: "done", calendar: "failed", chain_warmup: "failed", first_snapshot: "failed" });
    expect(closed.steps.find((step: { key: string }) => step.key === "calendar").message).toBe("Interrupted by a server restart.");
    expect(restarted).toMatchObject({ status: "complete", resumed_from_run_id: interruptedId });
    expect(statusOf(restarted.steps)).toEqual({ history: "done", calendar: "done", chain_warmup: "skipped", first_snapshot: "skipped" });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(prepareChain).not.toHaveBeenCalled();
  });

  it("two restarts in a row: the resumed run is closed on the second boot, not restarted again; a Retry after that is resumable once more", async () => {
    const ticker = await createTicker({ signalsEnabled: true });
    const originalId = await insertInterruptedRun(ticker.id, { startedMinutesAgo: 5 });
    // First boot: the queue never gets to run the restart before the second restart (the work hangs, then is abandoned).
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => (releaseHang = resolve));
    const { workers: hangingWorkers } = fakeWorkers({ fetchHistory: vi.fn(async () => { await hang; throw new Error("process died"); }) as never });
    const firstBoot = await resumeInterruptedBackfillRuns({ store: scopedStore(), workers: hangingWorkers });
    expect(firstBoot.resumed).toEqual([ticker.symbol]);
    const resumedRow = (await runsOf(ticker.id)).at(-1)!;
    expect(resumedRow).toMatchObject({ status: "running", resumed_from_run_id: originalId });

    // Second boot, while that restart is still "running" in the database.
    const { workers } = fakeWorkers();
    const secondBoot = await resumeInterruptedBackfillRuns({ store: scopedStore(), workers });
    expect(secondBoot).toEqual({ resumed: [], notResumed: [{ symbol: ticker.symbol, reason: "already_resumed_once" }] });
    expect(await databaseRunStore.getLatest(ticker.id)).toMatchObject({ id: resumedRow.id, status: "partial" });

    // Let the hung first-boot work fail so the queue drains; its finish must not resurrect anything (it lands on the closed row).
    releaseHang();
    await waitForBackfillQueue();
    expect((await runsOf(ticker.id)).filter((row) => row.status === "running")).toHaveLength(0);

    // The operator's Retry starts a fresh run with no link, so a third boot that cuts it off restarts it once more.
    let releaseRetry: () => void = () => {};
    const retryHang = new Promise<void>((resolve) => (releaseRetry = resolve));
    const retryWorkers = fakeWorkers({ fetchHistory: vi.fn(async () => { await retryHang; throw new Error("process died"); }) as never }).workers;
    const retry = await startTickerBackfill(ticker.id, ticker.symbol, { store: scopedStore(), workers: retryWorkers });
    expect(retry.resumedFromRunId).toBeNull();
    const thirdBoot = await resumeInterruptedBackfillRuns({ store: scopedStore({ listRunning: async () => (await databaseRunStore.listRunning()).filter((run) => run.tickerId === ticker.id) }), workers });
    expect(thirdBoot.resumed).toEqual([ticker.symbol]);
    expect((await runsOf(ticker.id)).at(-1)).toMatchObject({ resumed_from_run_id: retry.id });
    releaseRetry();
    await waitForBackfillQueue();
    expect((await runsOf(ticker.id)).at(-1)).toMatchObject({ status: "complete", resumed_from_run_id: retry.id });
  });

  it("a ticker removed from the shortlist mid-setup is closed and not restarted; removed and re-added is restarted", async () => {
    const removed = await createTicker({ onShortlist: false });
    const readded = await createTicker({ onShortlist: false, signalsEnabled: false });
    await testDb("shortlist_entries").insert({ ticker_id: readded.id, added_by_user_id: userId, signals_enabled: true });
    await insertInterruptedRun(removed.id);
    await insertInterruptedRun(readded.id);
    const { workers } = fakeWorkers();

    const result = await resumeInterruptedBackfillRuns({ store: scopedStore({ listRunning: async () => (await databaseRunStore.listRunning()).filter((run) => [removed.id, readded.id].includes(run.tickerId)) }), workers });
    await waitForBackfillQueue();

    expect(result.notResumed).toEqual([{ symbol: removed.symbol, reason: "not_on_shortlist" }]);
    expect(result.resumed).toEqual([readded.symbol]);
    expect((await runsOf(removed.id)).map((row) => row.status)).toEqual(["partial"]);
    expect(statusOf((await runsOf(readded.id)).at(-1)!.steps)).toMatchObject({ chain_warmup: "done" });
  });
});

describe("one setup per ticker, whatever starts it", () => {
  it("a Retry that lands between the boot closing a run and restarting it does not make the setup run twice", async () => {
    const ticker = await createTicker({ signalsEnabled: true });
    // Stale (past the 30-minute window), so the Retry does not join it.
    const interruptedId = await insertInterruptedRun(ticker.id, { startedMinutesAgo: 45 });
    const { workers, fetchHistory } = fakeWorkers();
    const store = scopedStore({
      finish: async (runId, status, steps) => {
        await databaseRunStore.finish(runId, status, steps);
        // The operator's Retry Full Setup (POST /shortlist/:tickerId/backfill) arriving right now.
        if (runId === interruptedId) await startTickerBackfill(ticker.id, ticker.symbol, { store: databaseRunStore, workers });
      },
    });

    await resumeInterruptedBackfillRuns({ store, workers });
    await waitForBackfillQueue();

    // One closed run, one live setup that ran once.
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("two starts for the same ticker at the same moment (Signals switched on in two tabs, or Signals on plus Retry) run the setup once", async () => {
    const ticker = await createTicker({ signalsEnabled: true });
    const { workers, prepareChain } = fakeWorkers();
    // Both requests read "nothing running" before either creates its run.
    let arrivals = 0;
    let releaseBoth: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
    const store = scopedStore({
      getLatest: async (tickerId) => {
        const latest = await databaseRunStore.getLatest(tickerId);
        arrivals += 1;
        if (arrivals === 2) releaseBoth();
        await bothArrived;
        return latest;
      },
    });

    const [first, second] = await Promise.all([
      startTickerBackfill(ticker.id, ticker.symbol, { store, workers }, "option_chain"),
      startTickerBackfill(ticker.id, ticker.symbol, { store, workers }, "option_chain"),
    ]);
    await waitForBackfillQueue();

    expect(prepareChain).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
  });
});

describe("closeRunning", () => {
  it("closes a stale running run but leaves a fresh one (a start racing this one) running", async () => {
    const stale = await createTicker({ signalsEnabled: true });
    const fresh = await createTicker({ signalsEnabled: true });
    const staleId = await insertInterruptedRun(stale.id, { startedMinutesAgo: 45 });
    const freshId = await insertInterruptedRun(fresh.id, { startedMinutesAgo: 1 });
    await databaseRunStore.closeRunning(stale.id);
    await databaseRunStore.closeRunning(fresh.id);
    expect((await testDb("ticker_backfill_runs").where({ id: staleId }).first()).status).toBe("partial");
    expect((await testDb("ticker_backfill_runs").where({ id: freshId }).first()).status).toBe("running");
    await databaseRunStore.finish(freshId, "partial", buildInitialBackfillSteps());
  });
});

describe("resume keeps going past one bad row", () => {
  it("a failure closing one interrupted run does not leave the later runs unrestarted", async () => {
    const first = await createTicker({ signalsEnabled: true });
    const second = await createTicker({ signalsEnabled: true });
    const firstRunId = await insertInterruptedRun(first.id, { startedMinutesAgo: 3 });
    await insertInterruptedRun(second.id, { startedMinutesAgo: 2 });
    const { workers } = fakeWorkers();
    const store = scopedStore({
      listRunning: async () => (await databaseRunStore.listRunning()).filter((run) => [first.id, second.id].includes(run.tickerId)),
      finish: async (runId, status, steps) => {
        if (runId === firstRunId) throw new Error("connection terminated unexpectedly");
        await databaseRunStore.finish(runId, status, steps);
      },
    });

    await resumeInterruptedBackfillRuns({ store, workers }).catch(() => undefined);
    await waitForBackfillQueue();

    expect((await runsOf(second.id)).at(-1)).toMatchObject({ status: "complete" });
    // Tidy the deliberately failed row so it does not linger as 'running'.
    await databaseRunStore.finish(firstRunId, "partial", buildInitialBackfillSteps());
  });
});
