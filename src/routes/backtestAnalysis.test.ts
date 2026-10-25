import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLibrary, { type Knex } from "knex";
import { syntheticOptionQuotes, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile } from "../backtest/engine/testSupport/syntheticBacktestData.js";
import type { AnalysisFileFigures } from "../backtest/analysis/analysisFigures.js";
import type { AnalysisRunView, TickerAnalysisView } from "../backtest/analysis/analysisStore.js";

// The Analyse window's routes on the real backtest router against the test database: starting an analysis (Update
// Analysis and Run with these values) stores its row and claims its job, the refusals, the window's view and history,
// the data file's figures before a first analysis, cancelling, and a ticker's lab save re-running its analysis. The job
// process itself is not started (spawn mocked).
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "backtest-analysis-route-test-"));
process.env.BACKTEST_DATA_DIR = dataDirectory;

const spawnBacktestJobProcessMock = vi.fn<(jobId: string) => number>();
const terminateLeftoverJobProcessesMock = vi.fn<(pid: number | null, jobId: string) => number>();
vi.mock("../backtest/jobs/spawnBacktestJobProcess.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/jobs/spawnBacktestJobProcess.js")>()),
  spawnBacktestJobProcess: (jobId: string) => spawnBacktestJobProcessMock(jobId),
  terminateLeftoverJobProcesses: (pid: number | null, jobId: string) => terminateLeftoverJobProcessesMock(pid, jobId),
}));

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run analysis route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { backtestRouter } = await import("./backtest.js");
const { errorHandler } = await import("../middleware/errorHandler.js");
const testDb: Knex = db;
const suffix = `${Date.now() % 100000}`;
const symbol = `AN${suffix}`.slice(0, 8);
const symbolWithoutFile = `AX${suffix}`.slice(0, 8);
let server: Server;
let baseUrl: string;
let userId: string;

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/backtest${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  const days = ["2026-03-02", "2026-03-03", "2026-03-04"].map((tradingDate) => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, 50, ["2026-03-20"], 0.5, 0.04, 1, 3), endOfDayVolume: 100, openInterest: 500 }));
  writeSyntheticSymbolFile(path.join(dataDirectory, `${symbol}.sqlite`), symbol, days);
  writeSyntheticIbkrBarsFromQuotes(path.join(dataDirectory, `${symbol}.sqlite`), days.map(({ tradingDate }) => ({ tradingDate, open: 50, high: 51, low: 49, close: 50, volume: 1_000, impliedVolatility: 0.5 })), 4);
  const [user] = await testDb("users").insert({ username: `analysis-routes-${suffix}`, display_name: "Analysis Routes Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const app = express();
  app.use(express.json());
  app.use((incoming, _response, next) => {
    (incoming as unknown as { session: { userId?: string; authMethod?: string } }).session = { userId, authMethod: "passkey" };
    next();
  });
  app.use("/backtest", backtestRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  spawnBacktestJobProcessMock.mockReset();
  spawnBacktestJobProcessMock.mockReturnValue(424_243);
  terminateLeftoverJobProcessesMock.mockReset();
  terminateLeftoverJobProcessesMock.mockReturnValue(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("backtest_ticker_analyses").whereIn("symbol", [symbol, symbolWithoutFile]).delete();
  await testDb("backtest_jobs").whereIn("symbol", [symbol, symbolWithoutFile]).delete();
  await testDb("backtest_lab_ticker_overrides").where({ symbol }).delete();
  await testDb("backtest_ticker_profiles").where({ symbol }).delete();
  await testDb("backtest_ticker_suitability").where({ symbol }).delete();
  await testDb("backtest_lab_settings_audit").where({ user_id: userId }).delete();
  await testDb("users").where({ id: userId }).delete();
  await testDb.destroy();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("analysis routes", () => {
  let savedRunId: string;
  let trialRunId: string;

  it("starts with no analysis", async () => {
    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ symbol, stored: null, trial: null, active: [], latestProblem: null, fileLastDate: "2026-03-04" });
    expect(view.body.currentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(view.body).toMatchObject({ profile: null, suitability: null });
  });

  it("gives the data file's figures before any analysis, without the chain scan's, storing nothing; refuses a ticker without a file", async () => {
    const figures = await call<AnalysisFileFigures>("GET", `/analyses/${symbol}/file-figures`);
    expect(figures.status).toBe(200);
    expect(figures.body).toMatchObject({ symbol, optionLastDate: "2026-03-04", barsLastDate: "2026-03-04" });
    expect(figures.body.bars.map(([date]) => date)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    expect(figures.body.dataQuality).toMatchObject({ completeDays: 3, firstDate: "2026-03-02", lastDate: "2026-03-04" });
    for (const scanField of ["chains", "fitDays", "largestPotWithoutModel"]) expect(figures.body).not.toHaveProperty(scanField);
    for (const scanField of ["scannedDays", "daysWithoutPrice", "daysWithNothingPassing"]) expect(figures.body.dataQuality).not.toHaveProperty(scanField);
    expect(await testDb("backtest_ticker_analyses").where({ symbol }).first()).toBeUndefined();
    expect(await testDb("backtest_jobs").where({ symbol }).first()).toBeUndefined();

    const missing = await call<{ error: string }>("GET", `/analyses/${symbolWithoutFile}/file-figures`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/no data file/);
  });

  it("gives the header the ticker's stored TradingView profile and its suitability", async () => {
    await testDb("backtest_ticker_profiles").insert({ symbol, tradingview_ticker: `NASDAQ:${symbol}`, company_name: "Analysis Test, Inc.", sector: "Finance", industry: "Investment Banks/Brokers", kind: "stock" });
    await testDb("backtest_ticker_suitability").insert({ symbol, status: "suitable", note: "Fits.", updated_by_user_id: userId });
    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.profile).toEqual({ source: "tradingview", companyName: "Analysis Test, Inc.", exchange: "NASDAQ", sector: "Finance", industry: "Investment Banks/Brokers", kind: "stock" });
    expect(view.body.suitability).toMatchObject({ status: "suitable", note: "Fits." });
    await testDb("backtest_ticker_profiles").where({ symbol }).delete();
    await testDb("backtest_ticker_suitability").where({ symbol }).delete();
  });

  it("Update Analysis stores the analysis with the ticker's lab values and claims an analysis job", async () => {
    const started = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, {});
    expect(started.status).toBe(202);
    savedRunId = started.body.id;
    expect(started.body).toMatchObject({ symbol, reason: "manual", status: "running", sessionId: null, summaryStatus: "pending" });
    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(started.body.labValuesHash).toBe(view.body.currentHash);
    expect(started.body.labValues.trial).toBeNull();
    expect(started.body.labValues.effective.potDollars).toBe(started.body.labValues.tickerOverrides?.potDollars ?? started.body.labValues.defaultPotDollars);

    const job = await testDb("backtest_jobs").where({ id: started.body.jobId }).first("kind", "symbol", "status", "pid");
    expect(job).toEqual({ kind: "analysis", symbol, status: "running", pid: 424_243 });
    expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(started.body.jobId);
  });

  it("refuses a second Update while one runs, a bad trial, and a ticker without a file or with a download running", async () => {
    expect((await call<{ error: string }>("POST", `/analyses/${symbol}`, {})).body.error).toMatch(/already running/);
    const unknown = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { minimumBid: 0.1 } });
    expect(unknown.status).toBe(400);
    const inverted = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { minAbsDelta: 0.5, maxAbsDelta: 0.3 } });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toMatch(/minAbsDelta/);
    expect((await call("POST", `/analyses/${symbolWithoutFile}`, {})).status).toBe(404);

    const [download] = await testDb("backtest_jobs").insert({ kind: "download", symbol, start_date: "2026-03-01", end_date: "2026-03-31", status: "queued" }).returning("id");
    try {
      const refused = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { ladderRungs: 4 } });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/download is running/);
    } finally {
      await testDb("backtest_jobs").where({ id: download.id }).delete();
    }
    expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
  });

  it("Run with these values runs beside a saved analysis, with the trial's values on top of the ticker's", async () => {
    const trial = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, { values: { potDollars: 50_000, ladderSharesPct: 30, ladderShockPct: 75 } });
    expect(trial.status).toBe(202);
    trialRunId = trial.body.id;
    expect(trial.body.reason).toBe("trial");
    expect(trial.body.labValues.trial).toEqual({ potDollars: 50_000, ladderSharesPct: 30, ladderShockPct: 75 });
    expect(trial.body.labValues.effective).toMatchObject({ potDollars: 50_000, baseline: { ladderSharesPct: 30, ladderShock: "fixed", ladderShockPct: 75 } });

    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.active.map((run) => run.reason).sort()).toEqual(["manual", "trial"]);
    const runs = await call<AnalysisRunView[]>("GET", `/analyses/${symbol}/runs`);
    expect(runs.body.map((run) => run.id)).toEqual([trialRunId, savedRunId]);
  });

  it("the window opens the latest succeeded saved analysis with its figures, and a newer succeeded trial", async () => {
    await testDb("backtest_ticker_analyses").where({ id: savedRunId }).update({ status: "succeeded", figures: JSON.stringify({ symbol, marker: "saved" }), summary_status: "written", summary: JSON.stringify({ headline: "Saved." }), option_last_date: "2026-03-04", finished_at: testDb.fn.now() });
    await testDb("backtest_jobs").where({ symbol, kind: "analysis" }).whereIn("id", testDb("backtest_ticker_analyses").where({ id: savedRunId }).select("job_id")).update({ status: "succeeded", finished_at: testDb.fn.now() });
    let view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.stored).toMatchObject({ id: savedRunId, status: "succeeded", figures: { marker: "saved" }, summary: { headline: "Saved." }, optionLastDate: "2026-03-04" });
    expect(view.body.trial).toBeNull();

    await testDb("backtest_ticker_analyses").where({ id: trialRunId }).update({ status: "succeeded", figures: JSON.stringify({ symbol, marker: "trial" }), finished_at: testDb.fn.now() });
    view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.trial).toMatchObject({ id: trialRunId, figures: { marker: "trial" } });
    expect(view.body.active).toEqual([]);

    const statuses = await call<Record<string, { status: string; optionLastDate: string | null }>>("GET", "/analyses");
    expect(statuses.body[symbol]).toMatchObject({ status: "succeeded", optionLastDate: "2026-03-04" });
  });

  it("cancels a running analysis, refuses to cancel a finished one, and never resumes an analysis job", async () => {
    const started = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, {});
    expect(started.status).toBe(202);
    const cancelled = await call<AnalysisRunView>("POST", `/analyses/runs/${started.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await testDb("backtest_jobs").where({ id: started.body.jobId }).first("cancel_requested")).cancel_requested).toBe(true);
    expect((await call("POST", `/analyses/runs/${savedRunId}/cancel`)).status).toBe(409);

    await testDb("backtest_jobs").where({ id: started.body.jobId }).update({ status: "cancelled", finished_at: testDb.fn.now() });
    const resumed = await call<{ error: string }>("POST", `/jobs/${started.body.jobId}/resume`);
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toMatch(/not resumed/);
    // The job ended without its process writing the analysis: the run reads as cancelled.
    expect((await call<AnalysisRunView>("GET", `/analyses/runs/${started.body.id}`)).body.status).toBe("cancelled");
  });

  it("a ticker's lab save re-runs its analysis, replacing a saved one still running", async () => {
    const running = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, {});
    expect(running.status).toBe(202);
    const saved = await call<{ changes: unknown[]; analyses: { started: string[]; skipped: unknown[] } }>("PUT", `/lab-ticker-overrides/${symbol}`, { potDollars: 90_000 });
    expect(saved.status).toBe(200);
    expect(saved.body.analyses).toEqual({ started: [symbol], skipped: [] });
    expect((await testDb("backtest_jobs").where({ id: running.body.jobId }).first("cancel_requested")).cancel_requested).toBe(true);

    const runs = await call<AnalysisRunView[]>("GET", `/analyses/${symbol}/runs`);
    expect(runs.body[0]).toMatchObject({ reason: "ticker_settings", status: "running" });
    expect(runs.body[0]!.labValues.effective.potDollars).toBe(90_000);

    // Nothing changed: no re-run.
    const unchanged = await call<{ analyses: { started: string[] } }>("PUT", `/lab-ticker-overrides/${symbol}`, { potDollars: 90_000 });
    expect(unchanged.body.analyses.started).toEqual([]);
  });
});
