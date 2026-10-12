import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { kellyFraction } from "../pluto/postModelGates.js";
import knexLibrary, { type Knex } from "knex";
import type { BacktestCompareResponse, BacktestJobView, BacktestOverview, BacktestSessionDetail, BacktestSessionListItem, BacktestSettingsTemplate } from "../backtest/backtestTypes.js";

// The real backtest router on a small express app against the test database, with a temporary data folder holding a
// real symbol file. Only starting and stopping job processes is mocked.
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "backtest-route-test-"));
process.env.BACKTEST_DATA_DIR = dataDirectory;

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run backtest route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const spawnBacktestJobProcessMock = vi.fn<(jobId: string) => number>();
const terminateLeftoverJobProcessesMock = vi.fn<(processGroupId: number | null, jobId: string) => number>();
vi.mock("../backtest/jobs/spawnBacktestJobProcess.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/jobs/spawnBacktestJobProcess.js")>()),
  spawnBacktestJobProcess: (jobId: string) => spawnBacktestJobProcessMock(jobId),
  terminateLeftoverJobProcesses: (processGroupId: number | null, jobId: string) => terminateLeftoverJobProcessesMock(processGroupId, jobId),
}));

const { db } = await import("../db/connection.js");
const { backtestRouter } = await import("./backtest.js");
const { errorHandler } = await import("../middleware/errorHandler.js");
const { lastFinishedBacktestSessionDate } = await import("../backtest/jobs/backtestJobRules.js");
const { splitScheduleFingerprint, writeSplitScheduleCache } = await import("../backtest/engine/splitFactors.js");
const testDb: Knex = db;

const runTag = String(Date.now() % 1_000_000).padStart(6, "0");
const fileSymbol = `BT${runTag}F`;
const downloadSymbolA = `BT${runTag}A`;
const downloadSymbolB = `BT${runTag}B`;
const sessionNamePrefix = `backtest-route-${runTag}`;
let tickerId: string;

let server: Server;
let baseUrl: string;

function writeSymbolFile(symbol: string, days: { tradingDate: string; status: "complete" | "no_data" }[]): void {
  const database = new DatabaseSync(path.join(dataDirectory, `${symbol}.sqlite`));
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE days (
      trading_date TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')),
      quote_rows INTEGER NOT NULL, eod_rows INTEGER NOT NULL, open_interest_rows INTEGER NOT NULL, fetched_at TEXT NOT NULL
    );
  `);
  const insert = database.prepare("INSERT INTO days VALUES (?, ?, ?, ?, ?, ?)");
  for (const day of days) insert.run(day.tradingDate, day.status, day.status === "complete" ? 900 : 0, 0, 0, "2026-10-12T00:00:00Z");
  database.close();
}

async function request(method: string, route: string, body?: unknown, authenticated = true): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(authenticated ? { "x-test-user": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  // 2026-09-01..11: Labor Day stored as no_data, the 9th never fetched (one missing weekday).
  writeSymbolFile(fileSymbol, [
    { tradingDate: "2026-09-01", status: "complete" },
    { tradingDate: "2026-09-02", status: "complete" },
    { tradingDate: "2026-09-03", status: "complete" },
    { tradingDate: "2026-09-04", status: "complete" },
    { tradingDate: "2026-09-07", status: "no_data" },
    { tradingDate: "2026-09-08", status: "complete" },
    { tradingDate: "2026-09-10", status: "complete" },
    { tradingDate: "2026-09-11", status: "complete" },
  ]);
  const [ticker] = await testDb("tickers").insert({ symbol: fileSymbol }).returning("id");
  tickerId = ticker.id;
  await testDb("daily_price_bars").insert([
    { ticker_id: tickerId, trading_date: "2016-01-04", open_price: 10, high_price: 11, low_price: 9, close_price: 10.5, volume: 100 },
    { ticker_id: tickerId, trading_date: "2026-09-11", open_price: 20, high_price: 21, low_price: 19, close_price: 20.5, volume: 100 },
  ]);

  const app = express();
  app.use(express.json());
  app.use((incoming, _response, next) => {
    (incoming as unknown as { session: { userId?: string; authMethod?: string } }).session = incoming.header("x-test-user") ? { userId: "test-user", authMethod: "passkey" } : {};
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
  spawnBacktestJobProcessMock.mockReturnValue(424_242);
  terminateLeftoverJobProcessesMock.mockReset();
  terminateLeftoverJobProcessesMock.mockReturnValue(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("backtest_sessions").where("name", "like", `${sessionNamePrefix}%`).del();
  await testDb("backtest_jobs").whereIn("symbol", [fileSymbol, downloadSymbolA, downloadSymbolB]).del();
  await testDb("daily_price_bars").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("backtest routes", () => {
  it("require a logged-in session", async () => {
    expect((await request("GET", "/backtest/overview", undefined, false)).status).toBe(401);
  });

  it("serve the settings template in the New session table's order, with the current values", async () => {
    const { status, body } = await request("GET", "/backtest/settings-template");
    expect(status).toBe(200);
    const template = body as BacktestSettingsTemplate;
    const plutoRow = await testDb("pluto_settings").where({ id: 1 }).first();
    expect(template.settings.kellyFraction).toBe(kellyFraction);
    expect(template.settings.pluto.minEdgeYieldPct).toBe(Number(plutoRow.min_edge_yield_pct));
    expect(template.settings.trading).not.toHaveProperty("commissionEstimator");
    expect(template.rows.map((row) => row.group)).toEqual([...Array(12).fill("Capital and sizing"), ...Array(14).fill("Candidate quality"), ...Array(7).fill("Model")]);
    expect(template.rows[0]).toEqual({ path: "pluto.capitalBudgetPct", group: "Capital and sizing", label: "Capital budget", unit: "percent", now: Number(plutoRow.capital_budget_pct), editable: true, note: "% of the account" });
    expect(template.rows.find((row) => row.path === "pluto.maxActionsPerSession")).toMatchObject({ editable: false, note: "one look a day at 10:00 on one symbol: at most one order a day" });
    expect(template.rows.find((row) => row.path === "pluto.minGrade")?.now).toBe(plutoRow.min_grade);
    const tradingRow = await testDb("trading_settings").first("max_position_pct_of_portfolio");
    expect(template.rows.slice(5, 9).map((row) => [row.path, row.label])).toEqual([
      ["pluto.minCashReservePct", "Min cash reserve"],
      ["trading.maxPositionPctOfPortfolio", "Max order size (order gate)"],
      ["trading.maxConcentrationPerTickerPct", "Max per ticker (order gate)"],
      ["trading.minCashReservePct", "Min cash reserve (order gate)"],
    ]);
    expect(template.rows[6]).toMatchObject({ now: Number(tradingRow.max_position_pct_of_portfolio), editable: true, note: "% of the account" });
    expect(template.rows.find((row) => row.path === "pluto.maxIvShiftVp")).toMatchObject({ editable: false, note: "no intraday quotes in the history: always 0 in a backtest" });
    expect(template.rows.slice(-2).map((row) => [row.path, row.now, row.editable])).toEqual([
      ["fixed.forecastWindowDays", 21, false],
      ["fixed.gradeCutPoints", "20 / 10 / 0%", false],
    ]);
    expect(template.notReplayed).toHaveLength(8);
  });

  describe("downloads and jobs", () => {
    let firstJob: BacktestJobView;
    let secondJob: BacktestJobView;

    it("refuse an invalid symbol or start date", async () => {
      expect(await request("POST", "/backtest/downloads", { symbol: "1abc" })).toEqual({ status: 400, body: { error: 'Not a valid symbol: "1abc"' } });
      expect((await request("POST", "/backtest/downloads", { symbol: downloadSymbolA, startDate: "2020-02-30" })).status).toBe(400);
      expect(await request("POST", "/backtest/downloads", { symbol: downloadSymbolA, startDate: "2015-12-31" })).toEqual({ status: 400, body: { error: "The start date must be on or after 2016-01-01: the IBKR daily history starts there." } });
    });

    it("start a download at once when none is running, from 2020-01-01 to the last finished session", async () => {
      const { status, body } = await request("POST", "/backtest/downloads", { symbol: downloadSymbolA.toLowerCase() });
      expect(status).toBe(201);
      firstJob = body as BacktestJobView;
      expect(firstJob).toMatchObject({ kind: "download", symbol: downloadSymbolA, status: "running", displayStatus: "running", sessionId: null, progressDone: 0, etaSeconds: null });
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(firstJob.id);
      const row = await testDb("backtest_jobs").where({ id: firstJob.id }).first(testDb.raw("start_date::text as start_date"), testDb.raw("end_date::text as end_date"), "pid");
      expect(row).toEqual({ start_date: "2020-01-01", end_date: lastFinishedBacktestSessionDate(new Date()), pid: 424_242 });
    });

    it("queue a second download while one runs, and refuse a duplicate", async () => {
      const { status, body } = await request("POST", "/backtest/downloads", { symbol: downloadSymbolB, startDate: "2024-01-02" });
      expect(status).toBe(201);
      secondJob = body as BacktestJobView;
      expect(secondJob.displayStatus).toBe("queued");
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
      expect((await request("POST", "/backtest/downloads", { symbol: downloadSymbolA })).status).toBe(409);
    });

    it("show a running download whose heartbeat stopped as stopped, and start the next queued one", async () => {
      await testDb("backtest_jobs").where({ id: firstJob.id }).update({ heartbeat_at: testDb.raw("now() - interval '2 minutes'") });
      const { body } = await request("GET", "/backtest/overview");
      const jobs = (body as BacktestOverview).jobs;
      expect(jobs.find((job) => job.id === firstJob.id)?.displayStatus).toBe("stopped");
      expect(jobs.find((job) => job.id === secondJob.id)?.displayStatus).toBe("running");
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(secondJob.id);
      const ids = jobs.map((job) => job.id);
      expect(ids.indexOf(secondJob.id)).toBeLessThan(ids.indexOf(firstJob.id));
    });

    it("ask a running job to stop, and cancel a stopped one at once (stopping what is left of its process)", async () => {
      const running = await request("POST", `/backtest/jobs/${secondJob.id}/cancel`);
      expect(running.status).toBe(200);
      expect((running.body as BacktestJobView).displayStatus).toBe("running");
      expect((await testDb("backtest_jobs").where({ id: secondJob.id }).first("cancel_requested")).cancel_requested).toBe(true);

      const stopped = await request("POST", `/backtest/jobs/${firstJob.id}/cancel`);
      expect(stopped.body).toMatchObject({ status: "cancelled", displayStatus: "cancelled" });
      expect((stopped.body as BacktestJobView).finishedAt).not.toBeNull();
      expect(terminateLeftoverJobProcessesMock).toHaveBeenCalledWith(424_242, firstJob.id);
      expect((await request("POST", `/backtest/jobs/${firstJob.id}/cancel`)).status).toBe(409);
    });

    it("resume a cancelled download into the queue, and refuse resuming a running one", async () => {
      const resumed = await request("POST", `/backtest/jobs/${firstJob.id}/resume`);
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ status: "queued", displayStatus: "queued", error: null, finishedAt: null });
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
      expect((await request("POST", `/backtest/jobs/${secondJob.id}/resume`)).status).toBe(409);
      expect((await request("POST", "/backtest/jobs/not-a-uuid/resume")).status).toBe(404);
    });

    it("start the queued download once the running one is cancelled", async () => {
      await testDb("backtest_jobs").where({ id: secondJob.id }).update({ status: "cancelled", finished_at: testDb.fn.now() });
      await request("GET", "/backtest/overview");
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(firstJob.id);
      await testDb("backtest_jobs").whereIn("id", [firstJob.id, secondJob.id]).update({ status: "cancelled", finished_at: testDb.fn.now() });
    });

    it("mark a job failed when its process cannot be started", async () => {
      spawnBacktestJobProcessMock.mockImplementation(() => {
        throw new Error("spawn node ENOENT");
      });
      await testDb("backtest_jobs").where({ id: secondJob.id }).update({ status: "failed" });
      const { body } = await request("POST", `/backtest/jobs/${secondJob.id}/resume`);
      expect(body).toMatchObject({ status: "failed", error: "The job process could not be started: spawn node ENOENT" });
      await testDb("backtest_jobs").where({ id: secondJob.id }).update({ status: "cancelled" });
    });
  });

  describe("sessions", () => {
    let session: BacktestSessionListItem;
    let sessionJob: BacktestJobView;
    let secondSession: BacktestSessionListItem;

    const sessionRequest = (name: string, overrides: unknown = {}) => ({ name: `${sessionNamePrefix} ${name}`, symbol: fileSymbol, startDate: "2026-09-01", endDate: "2026-09-11", startingValue: 1_000_000, tablesMode: "walk_forward", overrides });

    it("summarize the symbol file in the overview", async () => {
      const { body } = await request("GET", "/backtest/overview");
      const overview = body as BacktestOverview;
      expect(overview.dataDirectory).toBe(dataDirectory);
      expect(overview.files.find((file) => file.symbol === fileSymbol)).toMatchObject({
        firstDate: "2026-09-01",
        lastDate: "2026-09-11",
        completeDays: 7,
        missingWeekdays: 1,
        barsFirstDate: "2016-01-04",
        barsLastDate: "2026-09-11",
        detectedSplits: null,
      });
    });

    it("show the splits the engine cached for the file, only while the file and the bars are what they were inferred from", async () => {
      const splits = [
        { lastDayBefore: "2026-08-28", firstDayAfter: "2026-09-01", ratio: 10 },
        { lastDayBefore: "2026-09-04", firstDayAfter: "2026-09-08", ratio: 2 },
      ];
      const schedule = { segments: [], splits, unresolved: [] };
      const fileOf = async () => ((await request("GET", "/backtest/overview")).body as BacktestOverview).files.find((file) => file.symbol === fileSymbol)!;
      // Inferred when the symbol had 3 bars: stale, not shown. Then from today's data (7 complete days and 2 bars to 2026-09-11): shown.
      writeSplitScheduleCache(dataDirectory, { symbol: fileSymbol, fingerprint: splitScheduleFingerprint(7, "2026-09-11", 3, "2026-09-11"), builtAtIso: "2026-10-12T00:00:00Z", schedule });
      expect((await fileOf()).detectedSplits).toBeNull();
      writeSplitScheduleCache(dataDirectory, { symbol: fileSymbol, fingerprint: splitScheduleFingerprint(7, "2026-09-11", 2, "2026-09-11"), builtAtIso: "2026-10-12T00:00:00Z", schedule });
      expect((await fileOf()).detectedSplits).toEqual(splits);
    });

    it("refuse a session outside the data file or without a file", async () => {
      expect((await request("POST", "/backtest/sessions", { ...sessionRequest("x"), endDate: "2026-09-14" })).body).toEqual({ error: `The ${fileSymbol} data file covers 2026-09-01 to 2026-09-11: the dates must be inside it.` });
      expect((await request("POST", "/backtest/sessions", { ...sessionRequest("x"), symbol: downloadSymbolA })).status).toBe(400);
      expect((await request("POST", "/backtest/sessions", sessionRequest("x", { pluto: { maxActionsPerSession: 1 } }))).status).toBe(400);
    });

    it("store the settings snapshot and only the changed values, and start the backtest job", async () => {
      const currentMinEdgeYield = Number((await testDb("pluto_settings").where({ id: 1 }).first("min_edge_yield_pct")).min_edge_yield_pct);
      const { status, body } = await request("POST", "/backtest/sessions", sessionRequest("edge", { pluto: { minEdgeYieldPct: currentMinEdgeYield + 5, maxAbsDelta: undefined }, kellyFraction }));
      expect(status).toBe(201);
      ({ session, job: sessionJob } = body as { session: BacktestSessionListItem; job: BacktestJobView });
      expect(session).toMatchObject({ symbol: fileSymbol, startDate: "2026-09-01", endDate: "2026-09-11", startingValue: 1_000_000, tablesMode: "walk_forward", status: "queued", overrideCount: 1, metrics: null });
      expect(sessionJob).toMatchObject({ kind: "backtest", sessionId: session.id, sessionName: session.name, displayStatus: "running" });
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(sessionJob.id);
      const row = await testDb("backtest_sessions").where({ id: session.id }).first("settings_snapshot", "overrides");
      expect(row.overrides).toEqual({ pluto: { minEdgeYieldPct: currentMinEdgeYield + 5 } });
      expect(Object.keys(row.settings_snapshot).sort()).toEqual(["kellyFraction", "pluto", "trading"]);
      expect(row.settings_snapshot.pluto.minEdgeYieldPct).toBe(currentMinEdgeYield);
    });

    it("return a session's days with drawdowns, monthly returns, trades and model accuracy", async () => {
      await testDb("backtest_session_days").insert([
        { session_id: session.id, trading_date: "2026-09-01", account_value: 1_000_000, cash: 1_000_000, exposure_dollars: 0, interest_dollars: 0, daily_return: null, baseline_value: 1_000_000, baseline_daily_return: null, decision_summary: "Sold 1 put" },
        { session_id: session.id, trading_date: "2026-09-02", account_value: 1_010_000, cash: 1_000_100, exposure_dollars: 40_000, interest_dollars: 11.5, daily_return: 0.01, baseline_value: 990_000, baseline_daily_return: -0.01, decision_summary: null },
        { session_id: session.id, trading_date: "2026-09-03", account_value: 999_900, cash: 1_000_200, exposure_dollars: 40_000, interest_dollars: 11.5, daily_return: -0.01, baseline_value: 1_000_000, baseline_daily_return: 0.0101, decision_summary: null },
      ]);
      await testDb("backtest_trades").insert({
        session_id: session.id,
        opened_on: "2026-09-01",
        strategy_key: "cash_secured_put",
        expiry: "2026-09-11",
        strike: 40,
        option_right: "P",
        contracts: 10,
        bid: 0.5,
        ask: 0.6,
        fill_price: 0.525,
        commission_dollars: 6.8,
        spot_at_open: 42.1,
        exposure_dollars: 39_475,
        dte: 10,
        delta: -0.22,
        grade: "good",
        edge_margin: 0.15,
        expected_pnl_dollars: 400,
        calibrated_expected_pnl_dollars: 300,
        settled_on: "2026-09-11",
        settlement_close: 43,
        in_the_money_at_expiry: false,
        pnl_dollars: 518.2,
      });

      const { status, body } = await request("GET", `/backtest/sessions/${session.id}`);
      expect(status).toBe(200);
      const detail = body as BacktestSessionDetail;
      expect(detail.session).toMatchObject({ id: session.id, overrides: { pluto: expect.any(Object) }, baselineMetrics: null, dataLastDate: null, error: null, finishedAt: null });
      // Only the split inside 2026-09-01..11 (the cached schedule written above also has one ending on the 1st).
      expect(detail.session.detectedSplits).toEqual([{ lastDayBefore: "2026-09-04", firstDayAfter: "2026-09-08", ratio: 2 }]);
      expect(detail.job?.id).toBe(sessionJob.id);
      expect(detail.days.map((day) => [day.tradingDate, day.accountValue, day.dailyReturn, day.drawdown])).toEqual([
        ["2026-09-01", 1_000_000, null, 0],
        ["2026-09-02", 1_010_000, 0.01, 0],
        ["2026-09-03", 999_900, -0.01, 999_900 / 1_010_000 - 1],
      ]);
      expect(detail.days[1]).toMatchObject({ cash: 1_000_100, exposureDollars: 40_000, interestDollars: 11.5, baselineValue: 990_000, baselineDailyReturn: -0.01 });
      expect(detail.monthlyReturns).toEqual([{ month: "2026-09", sessionReturn: 999_900 / 1_000_000 - 1, baselineReturn: 0 }]);
      expect(detail.trades).toHaveLength(1);
      expect(detail.trades[0]).toMatchObject({ openedOn: "2026-09-01", expiry: "2026-09-11", strike: 40, fillPrice: 0.525, sharePriceAtOpen: null, delta: -0.22, edgeYield: null, settledOn: "2026-09-11", inTheMoneyAtExpiry: false, pnlDollars: 518.2 });
      expect(typeof detail.trades[0]!.id).toBe("number");
      expect(detail.accuracyByMarginBand.find((band) => band.label === "10–20%")).toEqual({ label: "10–20%", tradeCount: 1, predictedPnlDollars: 400, calibratedPnlDollars: 300, realizedPnlDollars: 518.2 });
    });

    it("compare sessions with one buy-and-hold curve per symbol, period and starting value", async () => {
      ({ session: secondSession } = (await request("POST", "/backtest/sessions", sessionRequest("plain"))).body as { session: BacktestSessionListItem });
      const { status, body } = await request("GET", `/backtest/compare?ids=${session.id},${secondSession.id}`);
      expect(status).toBe(200);
      const comparison = body as BacktestCompareResponse;
      expect(comparison.sessions.map((entry) => [entry.id, entry.overrideCount])).toEqual([
        [session.id, 1],
        [secondSession.id, 0],
      ]);
      expect(comparison.curves.map((curve) => [curve.key, curve.label, curve.points.length])).toEqual([
        [session.id, session.name, 3],
        [secondSession.id, secondSession.name, 0],
        [`baseline:${session.id}`, `Buy and hold · ${fileSymbol}`, 3],
      ]);
      expect(comparison.curves[2]!.points[1]).toEqual({ tradingDate: "2026-09-02", value: 990_000 });
      expect((await request("GET", "/backtest/compare?ids=nope")).status).toBe(400);
      expect((await request("GET", "/backtest/compare?ids=00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("list sessions newest first", async () => {
      const sessions = ((await request("GET", "/backtest/overview")).body as BacktestOverview).sessions.filter((entry) => entry.name.startsWith(sessionNamePrefix));
      expect(sessions.map((entry) => entry.id)).toEqual([secondSession.id, session.id]);
    });

    it("delete a session after stopping its running job", async () => {
      expect((await request("DELETE", `/backtest/sessions/${session.id}`)).status).toBe(204);
      expect(terminateLeftoverJobProcessesMock).toHaveBeenCalledWith(424_242, sessionJob.id);
      expect(await testDb("backtest_sessions").where({ id: session.id }).first()).toBeUndefined();
      expect(await testDb("backtest_jobs").where({ id: sessionJob.id }).first()).toBeUndefined();
      expect(await testDb("backtest_session_days").where({ session_id: session.id }).first()).toBeUndefined();
      expect((await request("GET", `/backtest/sessions/${session.id}`)).status).toBe(404);
      expect((await request("DELETE", `/backtest/sessions/${session.id}`)).status).toBe(404);
    });
  });
});
