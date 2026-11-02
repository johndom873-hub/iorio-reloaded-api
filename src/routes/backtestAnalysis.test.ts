import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLibrary, { type Knex } from "knex";
import { syntheticOptionQuotes, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile } from "../backtest/engine/testSupport/syntheticBacktestData.js";
import type { AnalysisFileFigures } from "../backtest/analysis/analysisFigures.js";
import { treasuryBillCachePath, treasuryBillSeriesId, type TreasuryBillCache } from "../backtest/engine/treasuryBillRates.js";
import type { AnalysisRunView, TickerAnalysisView } from "../backtest/analysis/analysisStore.js";

// The Analyse window's routes on the real backtest router against the test database: starting an analysis (Re-run
// analysis and Run a trial) stores its row and claims its job, the refusals, the window's view and history, the data
// file's figures before a first analysis, cancelling, the Data files table's figures, and a lab save marking analyses out
// of date for Re-run out of date. The job process itself is not started (spawn mocked).
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
  // The T-bill rates the figures need, cached so the test never calls FRED.
  const treasuryBillCache: TreasuryBillCache = { seriesId: treasuryBillSeriesId, fetchedAtIso: "2026-03-05T00:00:00.000Z", observations: ["2026-02-27", ...days.map(({ tradingDate }) => tradingDate)].map((dateIso) => ({ dateIso, ratePercent: 4 })) };
  writeFileSync(treasuryBillCachePath(dataDirectory), JSON.stringify(treasuryBillCache));
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
    expect(view.body).toMatchObject({ symbol, stored: null, trial: null, active: [], latestProblem: null, outOfDate: false, fileLastDate: "2026-03-04" });
    expect(view.body.currentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(view.body.labSavedAt)).not.toBeNaN();
    expect(view.body).toMatchObject({ profile: null, suitability: null });
  });

  it("gives the data file's figures before any analysis, without the expiry days' scan, storing nothing; refuses a ticker without a file", async () => {
    const figures = await call<AnalysisFileFigures>("GET", `/analyses/${symbol}/file-figures`);
    expect(figures.status).toBe(200);
    expect(figures.body).toMatchObject({ symbol, optionFirstDate: "2026-03-02", optionLastDate: "2026-03-04", barsLastDate: "2026-03-04" });
    expect(figures.body.bars.map(([date]) => date)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    // One per bar; three bars are too few for any of them.
    expect(figures.body.barIndicators).toEqual({ ivPercentile: [null, null, null] });
    expect(figures.body.dataQuality).toMatchObject({ completeDays: 3, firstDate: "2026-03-02", lastDate: "2026-03-04", daysWithEveryQuoteAtZero: 0 });
    // The file's only Calls expire on 20 Mar: no expiry day, and Mon 2 to Wed 4 Mar holds no whole week.
    expect(figures.body.expiryWeeks).toEqual({ expiryDays: 0, wholeWeeks: 0, weeksWithExpiryDay: 0, byYear: {}, steadyWeekliesFrom: null, backtestStartDate: "2026-03-02" });
    expect(figures.body.falls).toEqual([]);
    for (const scanField of ["sameDayCalls", "size", "today"]) expect(figures.body).not.toHaveProperty(scanField);
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

  it("Re-run analysis stores the analysis with the lab's v4 values and default account, and claims an analysis job", async () => {
    const started = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, {});
    expect(started.status).toBe(202);
    savedRunId = started.body.id;
    expect(started.body).toMatchObject({ symbol, reason: "manual", status: "running", sessionId: null, formulasVersion: 8 });
    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(started.body.labValuesHash).toBe(view.body.currentHash);
    const { trial, defaultPotDollars, effective } = started.body.labValues;
    expect(trial).toBeNull();
    // The account is the lab's default; with one ticker the pot is the account × (1 + the excess allowance).
    expect(effective.accountDollars).toBe(defaultPotDollars);
    expect(effective.potShareOfAccount).toBeCloseTo(1 + effective.v4.excessAllowancePct / 100, 12);
    expect(effective.potDollars).toBeCloseTo(effective.accountDollars * effective.potShareOfAccount, 6);
    expect(effective.firstPositionShare).toBeCloseTo(effective.v4.firstPositionPct / 100, 12);
    expect((await testDb("backtest_ticker_analyses").where({ id: savedRunId }).first("summary_status")).summary_status).toBe("skipped");

    const job = await testDb("backtest_jobs").where({ id: started.body.jobId }).first("kind", "symbol", "status", "pid");
    expect(job).toEqual({ kind: "analysis", symbol, status: "running", pid: 424_243 });
    expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(started.body.jobId);
  });

  it("refuses a second Re-run while one runs, a bad trial, and a ticker without a file or with a download running", async () => {
    expect((await call<{ error: string }>("POST", `/analyses/${symbol}`, {})).body.error).toMatch(/already running/);
    const unknown = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { accountDollars: 50_000, ladderRungs: 4 } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/not a value/);
    const negative = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { accountDollars: -5 } });
    expect(negative.status).toBe(400);
    expect((await call("POST", `/analyses/${symbolWithoutFile}`, {})).status).toBe(404);

    const [download] = await testDb("backtest_jobs").insert({ kind: "download", symbol, start_date: "2026-03-01", end_date: "2026-03-31", status: "queued" }).returning("id");
    try {
      const refused = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { accountDollars: 50_000 } });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/download is running/);
    } finally {
      await testDb("backtest_jobs").where({ id: download.id }).delete();
    }
    expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
  });

  it("Run a trial runs beside a saved analysis, at its own starting account", async () => {
    const trial = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, { values: { accountDollars: 500_000 } });
    expect(trial.status).toBe(202);
    trialRunId = trial.body.id;
    expect(trial.body.reason).toBe("trial");
    expect(trial.body.labValues.trial).toEqual({ accountDollars: 500_000 });
    expect(trial.body.labValues.effective.accountDollars).toBe(500_000);
    expect(trial.body.labValues.effective.potDollars).toBeCloseTo(500_000 * trial.body.labValues.effective.potShareOfAccount, 6);

    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.active.map((run) => run.reason).sort()).toEqual(["manual", "trial"]);
    const runs = await call<AnalysisRunView[]>("GET", `/analyses/${symbol}/runs`);
    expect(runs.body.map((run) => run.id)).toEqual([trialRunId, savedRunId]);
  });

  it("the window opens the latest succeeded saved analysis with its figures and a newer succeeded trial; the table gets its figures", async () => {
    const tableFigures = { verdict: "suits", failedChecks: [], uncoveredWindows: [], optionsIncomeTwelveMonths: 0.878, v4Cagr: 0.497, holdCagr: 0.437, v4ExcessCalmar: 0.78, holdExcessCalmar: 0.62, smallestPotDollars: 80_351 };
    await testDb("backtest_ticker_analyses").where({ id: savedRunId }).update({ status: "succeeded", figures: JSON.stringify({ symbol, marker: "saved" }), table_figures: JSON.stringify(tableFigures), option_last_date: "2026-03-04", finished_at: testDb.fn.now() });
    await testDb("backtest_jobs").where({ symbol, kind: "analysis" }).whereIn("id", testDb("backtest_ticker_analyses").where({ id: savedRunId }).select("job_id")).update({ status: "succeeded", finished_at: testDb.fn.now() });
    let view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.stored).toMatchObject({ id: savedRunId, status: "succeeded", figures: { marker: "saved" }, optionLastDate: "2026-03-04" });
    expect(view.body).toMatchObject({ trial: null, outOfDate: false });

    // Stored figures with bars gain the price chart's indicators as they are read, one per bar.
    await testDb("backtest_ticker_analyses").where({ id: trialRunId }).update({ status: "succeeded", figures: JSON.stringify({ symbol, marker: "trial", bars: [["2026-03-04", 10, 11, 9, 10.5, 0.4]] }), finished_at: testDb.fn.now() });
    view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.trial).toMatchObject({ id: trialRunId, figures: { marker: "trial", barIndicators: { ivPercentile: [null] } } });
    expect(view.body.active).toEqual([]);

    const table = await call<{ labSavedAt: string; outOfDate: string[]; bySymbol: Record<string, unknown> }>("GET", "/analyses");
    expect(table.body.bySymbol[symbol]).toMatchObject({ status: "succeeded", optionLastDate: "2026-03-04", formulasVersion: 8, outOfDate: false, tableFigures });
    expect(table.body.outOfDate).not.toContain(symbol);
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

  it("a lab save marks the analyses out of date instead of re-running them; Re-run out of date runs them", async () => {
    // The save's confirmation names the analysed tickers a v4 value would put out of date (a dry run).
    const preview = await call<{ changes: { field: string; outOfDate: string[] }[]; outOfDate: string[] }>("POST", "/lab-settings/preview", { overrides: { volFarmerV4: { callMaxAbsDelta: 0.45 } } });
    expect(preview.status).toBe(200);
    expect(preview.body.outOfDate).toContain(symbol);
    expect(preview.body.changes.find((change) => change.field === "volFarmerV4.callMaxAbsDelta")!.outOfDate).toContain(symbol);
    // A save back to the values an analysis ran with leaves it up to date: with it run at 0.45, 0.45 marks nothing.
    const ranWith = await testDb("backtest_ticker_analyses").where({ id: savedRunId }).first("lab_values");
    const ranAt045 = { ...ranWith.lab_values, settings: { ...ranWith.lab_values.settings, volFarmerV4: { ...ranWith.lab_values.settings.volFarmerV4, callMaxAbsDelta: 0.45 } } };
    await testDb("backtest_ticker_analyses").where({ id: savedRunId }).update({ lab_values: JSON.stringify(ranAt045) });
    const backToIt = await call<{ changes: { field: string; outOfDate: string[] }[]; outOfDate: string[] }>("POST", "/lab-settings/preview", { overrides: { volFarmerV4: { callMaxAbsDelta: 0.45 } } });
    expect(backToIt.body.outOfDate).not.toContain(symbol);
    expect(backToIt.body.changes.find((change) => change.field === "volFarmerV4.callMaxAbsDelta")!.outOfDate).not.toContain(symbol);
    await testDb("backtest_ticker_analyses").where({ id: savedRunId }).update({ lab_values: JSON.stringify(ranWith.lab_values) });

    // The stored analysis computed with other values (the lab's default account then) is out of date.
    const stored = await testDb("backtest_ticker_analyses").where({ id: savedRunId }).first("lab_values");
    await testDb("backtest_ticker_analyses").where({ id: savedRunId }).update({ lab_values: JSON.stringify({ ...stored.lab_values, defaultPotDollars: stored.lab_values.defaultPotDollars + 1 }) });
    expect((await call<TickerAnalysisView>("GET", `/analyses/${symbol}`)).body.outOfDate).toBe(true);
    const table = await call<{ outOfDate: string[]; bySymbol: Record<string, { outOfDate: boolean }> }>("GET", "/analyses");
    expect(table.body.bySymbol[symbol]!.outOfDate).toBe(true);
    expect(table.body.outOfDate).toContain(symbol);

    const rerun = await call<{ started: string[]; skipped: { symbol: string }[] }>("POST", "/analyses/rerun-out-of-date");
    expect(rerun.status).toBe(202);
    expect(rerun.body.started).toContain(symbol);
    const runs = await call<AnalysisRunView[]>("GET", `/analyses/${symbol}/runs`);
    expect(runs.body[0]).toMatchObject({ reason: "global_settings", status: "running" });
  });
});
