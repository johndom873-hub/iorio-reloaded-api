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
import type {
  BacktestActionsPage,
  BacktestCompareResponse,
  BacktestFillsPage,
  BacktestJobDisplayStatus,
  BacktestJobView,
  BacktestOverview,
  BacktestSessionDetail,
  BacktestSessionListItem,
  BacktestSessionsPage,
  BacktestSettingsTemplate,
  CreateBacktestSessionResponse,
} from "../backtest/backtestTypes.js";

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
const { requeuePausedDownload } = await import("../backtest/jobs/backtestJobStore.js");
const { splitScheduleFingerprint, writeSplitScheduleCache } = await import("../backtest/engine/splitFactors.js");
const { lookTimesInWindow } = await import("../backtest/engine/runBacktestSession.js");
const testDb: Knex = db;

const runTag = String(Date.now() % 1_000_000).padStart(6, "0");
const fileSymbol = `BT${runTag}F`;
const secondFileSymbol = `BT${runTag}G`;
const partFileSymbol = `BT${runTag}P`;
const downloadSymbolA = `BT${runTag}A`;
const downloadSymbolB = `BT${runTag}B`;
const downloadSymbolC = `BT${runTag}C`;
const jobListingSymbol = `BT${runTag}L`;
const sessionNamePrefix = `backtest-route-${runTag}`;
let tickerId: string;

let server: Server;
let baseUrl: string;

/** `unavailableDays`: days the downloader recorded as impossible to retrieve (they have no `days` row). */
function writeSymbolFile(symbol: string, days: { tradingDate: string; status: "complete" | "no_data" }[], unavailableDays: string[] = []): void {
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
  if (unavailableDays.length > 0) {
    database.exec("CREATE TABLE unavailable_days (trading_date TEXT PRIMARY KEY, reason TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt_at TEXT NOT NULL);");
    const insertUnavailable = database.prepare("INSERT INTO unavailable_days VALUES (?, ?, ?, ?)");
    for (const tradingDate of unavailableDays) insertUnavailable.run(tradingDate, "quotes at 10:00: HTTP 500", 2, "2026-10-12T00:00:00Z");
  }
  database.close();
}

/** Runs `run` with BACKTEST_CLAUDE_CLI_PATH set to `value` (unset when undefined), then puts back what .env gave. */
async function withClaudeCliPath<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.BACKTEST_CLAUDE_CLI_PATH;
  if (value === undefined) delete process.env.BACKTEST_CLAUDE_CLI_PATH;
  else process.env.BACKTEST_CLAUDE_CLI_PATH = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.BACKTEST_CLAUDE_CLI_PATH;
    else process.env.BACKTEST_CLAUDE_CLI_PATH = before;
  }
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
  // 2026-09-01..11: Labor Day stored as no_data; the 9th could not be retrieved (no row, recorded as unavailable).
  writeSymbolFile(
    fileSymbol,
    [
      { tradingDate: "2026-09-01", status: "complete" },
      { tradingDate: "2026-09-02", status: "complete" },
      { tradingDate: "2026-09-03", status: "complete" },
      { tradingDate: "2026-09-04", status: "complete" },
      { tradingDate: "2026-09-07", status: "no_data" },
      { tradingDate: "2026-09-08", status: "complete" },
      { tradingDate: "2026-09-10", status: "complete" },
      { tradingDate: "2026-09-11", status: "complete" },
    ],
    ["2026-09-09"],
  );
  // A second file covering less: 2026-09-02..10.
  writeSymbolFile(
    secondFileSymbol,
    [
      { tradingDate: "2026-09-02", status: "complete" },
      { tradingDate: "2026-09-03", status: "complete" },
      { tradingDate: "2026-09-04", status: "complete" },
      { tradingDate: "2026-09-07", status: "no_data" },
      { tradingDate: "2026-09-08", status: "complete" },
      { tradingDate: "2026-09-10", status: "complete" },
    ],
    ["2026-09-09"],
  );
  // A file whose download stopped part-way: nothing stored for the 3rd and the 4th.
  writeSymbolFile(partFileSymbol, [
    { tradingDate: "2026-09-01", status: "complete" },
    { tradingDate: "2026-09-02", status: "complete" },
    { tradingDate: "2026-09-08", status: "complete" },
    { tradingDate: "2026-09-10", status: "complete" },
  ], ["2026-09-09"]);
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
  await testDb("backtest_jobs").whereIn("symbol", [fileSymbol, downloadSymbolA, downloadSymbolB, downloadSymbolC, jobListingSymbol]).del();
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
    expect(template.settings).toMatchObject({ decisionMaker: "rules", policy: { roll: "flagged_legs", buyback: "when_offered", sharesInProfit: "call_else_sell", eventClose: "stress_vs_remaining", afterBlockedChoice: "try_next" } });
    expect(template.rows.map((row) => row.group)).toEqual([...Array(12).fill("Capital and sizing"), ...Array(15).fill("Candidate quality"), ...Array(7).fill("Model"), ...Array(6).fill("Trading window and system checks"), ...Array(6).fill("Decisions (stand-in for the AI)"), ...Array(42).fill("Baseline wheel")]);
    expect(template.settings.baseline).toEqual({ entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15, callStrike: "delta_range", entryCallStrike: "any", entryWhenSharesUncovered: "wait", maxSharesPctOfAccount: 100, minCallYieldPct: 0, putsWhenNoCall: "off", putBudgetPctPerDte: 1, ladderSharesPct: 50, ladderRungs: 5, ladderShock: "history", ladderShockPct: 70, ladderShockMinPct: 60, ladderShockMaxPct: 80, ladderShockNoHistoryPct: 90, ladderShockLookbackYears: 10, ladderTop: "break_even", ladderPace: "any_look", ladderMinutesBetweenRungs: 0, ladderMaxRungsPerSession: 0, ladderPutVersusCall: "call_first", ladderPutYieldMarginPct: 0, shareFill: "plus_one_cent", dayValueOptions: "marked", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "best_contract" });
    expect(template.rows.find((row) => row.path === "decisionMaker")?.choices?.map((choice) => choice.value)).toEqual(["rules", "llm", "baseline"]);
    expect(template.rows[0]).toEqual({ path: "pluto.capitalBudgetPct", group: "Capital and sizing", label: "Capital budget", unit: "percent", now: Number(plutoRow.capital_budget_pct), editable: true, note: "% of the account" });
    // The looks inside Pluto's window and the system checks replayed at each: the window is shown, the checks can be changed.
    expect(template.rows.filter((row) => row.group === "Trading window and system checks").map((row) => [row.path, row.unit, row.now, row.editable])).toEqual([
      ["pluto.windowStartEt", "time", plutoRow.window_start_et, false],
      ["pluto.windowEndEt", "time", plutoRow.window_end_et, false],
      ["pluto.maxActionsPerSession", "integer", Number(plutoRow.max_actions_per_session), true],
      ["pluto.tickerCooldownMinutes", "integer", Number(plutoRow.ticker_cooldown_minutes), true],
      ["pluto.dailyLossBreakerPct", "percent", Number(plutoRow.daily_loss_breaker_pct), true],
      ["pluto.spyStressBreakerPct", "percent", Number(plutoRow.spy_stress_breaker_pct), true],
    ]);
    expect(template.rows.find((row) => row.path === "pluto.maxActionsPerSession")).toMatchObject({ label: "Max orders per day", note: "across every symbol and every look of the day, automatic closes included" });
    // The sector cap binds once a session runs several symbols on one book.
    expect(template.rows.find((row) => row.path === "pluto.maxSectorExposurePct")).toMatchObject({ group: "Capital and sizing", label: "Max per sector", unit: "percent", editable: true, now: Number(plutoRow.max_sector_exposure_pct) });
    expect(template.rows.find((row) => row.path === "pluto.minGrade")?.now).toBe(plutoRow.min_grade);
    expect(template.rows.find((row) => row.path === "fixed.earningsDateKnownCalendarDaysAhead")).toMatchObject({ group: "Candidate quality", label: "Earnings dates known 30 days ahead", unit: "days", now: 30, editable: false });
    const tradingRow = await testDb("trading_settings").first("max_position_pct_of_portfolio");
    expect(template.rows.slice(5, 9).map((row) => [row.path, row.label])).toEqual([
      ["pluto.minCashReservePct", "Min cash reserve"],
      ["trading.maxPositionPctOfPortfolio", "Max order size (order gate)"],
      ["trading.maxConcentrationPerTickerPct", "Max per ticker (order gate)"],
      ["trading.minCashReservePct", "Min cash reserve (order gate)"],
    ]);
    expect(template.rows[6]).toMatchObject({ now: Number(tradingRow.max_position_pct_of_portfolio), editable: true, note: "% of the account" });
    // A look after 10:00 measures how far each expiry's quotes moved from the 10:00 surface: the limit binds again.
    expect(template.rows.find((row) => row.path === "pluto.maxIvShiftVp")).toMatchObject({ editable: true, now: Number(plutoRow.max_iv_shift_vp) });
    const forecastRowIndex = template.rows.findIndex((row) => row.path === "fixed.forecastWindowDays");
    expect(template.rows.slice(forecastRowIndex, forecastRowIndex + 2).map((row) => [row.path, row.now, row.editable])).toEqual([
      ["fixed.forecastWindowDays", 21, false],
      ["fixed.gradeCutPoints", "20 / 10 / 0%", false],
    ]);
    // The decisions the AI model makes live, as choices: who decides, and the rules that stand in for it.
    expect(template.rows.filter((row) => row.group === "Decisions (stand-in for the AI)").map((row) => [row.path, row.unit, row.now, row.editable, row.choices?.map((choice) => choice.value)])).toEqual([
      ["decisionMaker", "choice", "rules", true, ["rules", "llm", "baseline"]],
      ["policy.roll", "choice", "flagged_legs", true, ["flagged_legs", "any_eligible", "never"]],
      ["policy.buyback", "choice", "when_offered", true, ["when_offered", "never"]],
      ["policy.sharesInProfit", "choice", "call_else_sell", true, ["call_else_sell", "always_sell", "always_keep"]],
      ["policy.eventClose", "choice", "stress_vs_remaining", true, ["stress_vs_remaining", "never", "always"]],
      ["policy.afterBlockedChoice", "choice", "try_next", true, ["try_next", "stop"]],
    ]);
    // The baseline wheel's own rows come last.
    expect(template.rows.filter((row) => row.group === "Baseline wheel").map((row) => [row.path, row.now, row.editable])).toEqual([
      ["baseline.entry", "put", true],
      ["baseline.minAbsDelta", 0.05, true],
      ["baseline.maxAbsDelta", 0.6, true],
      ["baseline.minDte", 1, true],
      ["baseline.maxDte", 45, true],
      ["baseline.maxSpreadPctOfMid", 15, true],
      ["baseline.callStrike", "delta_range", true],
      ["baseline.entryCallStrike", "any", true],
      ["baseline.entryWhenSharesUncovered", "wait", true],
      ["baseline.maxSharesPctOfAccount", 100, true],
      ["baseline.minCallYieldPct", 0, true],
      ["baseline.putsWhenNoCall", "off", true],
      ["baseline.putBudgetPctPerDte", 1, true],
      ["baseline.ladderSharesPct", 50, true],
      ["baseline.ladderRungs", 5, true],
      ["baseline.ladderShock", "history", true],
      ["baseline.ladderShockPct", 70, true],
      ["baseline.ladderShockMinPct", 60, true],
      ["baseline.ladderShockMaxPct", 80, true],
      ["baseline.ladderShockNoHistoryPct", 90, true],
      ["baseline.ladderShockLookbackYears", 10, true],
      ["baseline.ladderTop", "break_even", true],
      ["baseline.ladderPace", "any_look", true],
      ["baseline.ladderPutVersusCall", "call_first", true],
      ["baseline.ladderPutYieldMarginPct", 0, true],
      ["baseline.ladderMinutesBetweenRungs", 0, true],
      ["baseline.ladderMaxRungsPerSession", 0, true],
      ["baseline.shareFill", "plus_one_cent", true],
      ["baseline.dayValueOptions", "marked", true],
      ["baseline.callDeltaRange", "entry_range", true],
      ["baseline.callMinAbsDelta", 0.05, true],
      ["baseline.callMaxAbsDelta", 0.6, true],
      ["baseline.takeProfitPct", 0, true],
      ["baseline.shareStopLossPct", 0, true],
      ["baseline.earnings", "ignore", true],
      ["baseline.maxAccountPctPerStock", 100, true],
      ["baseline.looks", "every_look", true],
      ["baseline.volatilityEdgeFilter", "off", true],
      ["baseline.minVolatilityEdgePoints", 0, true],
      ["baseline.ranking", "premium_yield", true],
      ["baseline.expiryChoice", "any_in_range", true],
      ["baseline.coverage", "best_contract", true],
    ]);
    expect(template.rows.find((row) => row.path === "policy.afterBlockedChoice")).toMatchObject({ label: "After a choice Pluto's checks refuse", choices: [{ value: "try_next", label: "Choose again, but no more opens where the account has no room" }, { value: "stop", label: "Stop for this look" }] });
    // The AI model can be picked once the Claude Code CLI is configured.
    const decisionMakerChoices = async () => ((await request("GET", "/backtest/settings-template")).body as BacktestSettingsTemplate).rows.find((row) => row.path === "decisionMaker")?.choices;
    const baselineChoice = { value: "baseline", label: "Baseline wheel (no Pluto rules, no Signals)" };
    expect(await withClaudeCliPath(undefined, decisionMakerChoices)).toEqual([
      { value: "rules", label: "Rules (below)" },
      { value: "llm", label: "The AI model", unavailableReason: "BACKTEST_CLAUDE_CLI_PATH is not set in the API's .env" },
      baselineChoice,
    ]);
    expect(await withClaudeCliPath("/usr/local/bin/claude", decisionMakerChoices)).toEqual([
      { value: "rules", label: "Rules (below)" },
      { value: "llm", label: "The AI model" },
      baselineChoice,
    ]);
    expect(template.notReplayed).toHaveLength(7);
    expect(template.notReplayed.join(" ")).not.toMatch(/macro|daily-loss breaker and market stress|one look a day/i);
  });

  describe("downloads and jobs", () => {
    let firstJob: BacktestJobView;
    let secondJob: BacktestJobView;

    /** Where each status sits in the Downloads list: the running download, the stopped ones, the queue, the finished ones. */
    const downloadListGroupByDisplayStatus: Record<BacktestJobDisplayStatus, number> = { running: 0, stopped: 1, queued: 2, succeeded: 3, failed: 3, cancelled: 3 };
    const isUnfinishedJob = (job: BacktestJobView) => job.status === "queued" || job.status === "running";
    const countUnfinishedDownloads = async () => Number((await testDb("backtest_jobs").where({ kind: "download" }).whereIn("status", ["queued", "running"]).count("* as count").first())?.count);
    async function insertListingDownload(fields: Record<string, unknown>): Promise<string> {
      const [row] = await testDb("backtest_jobs").insert({ kind: "download", symbol: jobListingSymbol, ...fields }).returning("id");
      return row.id as string;
    }

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

    it("remove a queued download that never ran from the list altogether, and keep one that ran before as cancelled", async () => {
      const [neverRan] = await testDb("backtest_jobs").insert({ kind: "download", symbol: downloadSymbolC, start_date: "2024-01-02", end_date: "2024-01-05", status: "queued" }).returning("id");
      const removed = await request("POST", `/backtest/jobs/${neverRan.id}/cancel`);
      expect(removed.body).toMatchObject({ id: neverRan.id, status: "cancelled", displayStatus: "cancelled" });
      expect(await testDb("backtest_jobs").where({ id: neverRan.id }).first("id")).toBeUndefined();

      const [ranBefore] = await testDb("backtest_jobs")
        .insert({ kind: "download", symbol: downloadSymbolC, start_date: "2024-01-02", end_date: "2024-01-05", status: "queued", started_at: testDb.raw("now() - interval '1 hour'"), progress_done: 2, progress_total: 4, earlier_run_seconds: 30 })
        .returning("id");
      expect((await request("POST", `/backtest/jobs/${ranBefore.id}/cancel`)).body).toMatchObject({ status: "cancelled" });
      expect((await testDb("backtest_jobs").where({ id: ranBefore.id }).first("status")).status).toBe("cancelled");
      await testDb("backtest_jobs").where({ id: ranBefore.id }).delete();
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

    it("put a new download first and pause the running one, which then waits right after it", async () => {
      const [running] = await testDb("backtest_jobs")
        .insert({ kind: "download", symbol: downloadSymbolA, start_date: "2024-01-02", end_date: "2024-01-05", status: "running", pid: 777, heartbeat_at: testDb.fn.now(), started_at: testDb.raw("now() - interval '10 minutes'"), progress_done: 3, progress_total: 9, earlier_run_seconds: 60 })
        .returning("id");
      const [queuedEarlier] = await testDb("backtest_jobs").insert({ kind: "download", symbol: downloadSymbolB, start_date: "2024-01-02", end_date: "2024-01-05", status: "queued", queued_at: testDb.raw("now() - interval '1 hour'") }).returning("id");

      expect(await request("POST", "/backtest/downloads", { symbol: downloadSymbolC, pauseRunning: true })).toEqual({ status: 400, body: { error: "pauseRunning goes with putFirst: only a download put first can pause the running one." } });
      expect((await request("POST", "/backtest/downloads", { symbol: downloadSymbolC, putFirst: "yes" })).status).toBe(400);

      const created = await request("POST", "/backtest/downloads", { symbol: downloadSymbolC, putFirst: true, pauseRunning: true });
      expect(created.status).toBe(201);
      const putFirst = created.body as BacktestJobView;
      // It waits for the running one to stop: the two never share ThetaData's single login.
      expect(putFirst).toMatchObject({ displayStatus: "queued", putFirst: true });
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
      expect(await testDb("backtest_jobs").where({ id: running.id }).first("cancel_requested", "pause_requested")).toEqual({ cancel_requested: true, pause_requested: true });
      expect((await request("GET", "/backtest/overview")).body).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ id: running.id, pauseRequested: true })]) });

      // Its process ends: back in the queue with what it saved, its run time added; not cancelled.
      expect(await requeuePausedDownload(running.id as string, 777, { done: 4, total: 9, label: "saved up to 2024-01-03" })).toBe(true);
      const paused = await testDb("backtest_jobs").where({ id: running.id }).first("status", "pid", "cancel_requested", "pause_requested", "progress_done", "earlier_run_seconds", "finished_at");
      expect(paused).toMatchObject({ status: "queued", pid: null, cancel_requested: false, pause_requested: false, progress_done: 4, finished_at: null });
      expect(paused.earlier_run_seconds).toBeGreaterThanOrEqual(660);

      // The queue: the job put first, then the paused one, then the one queued before both.
      await request("GET", "/backtest/overview");
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(putFirst.id);
      spawnBacktestJobProcessMock.mockClear();
      await testDb("backtest_jobs").where({ id: putFirst.id }).update({ status: "succeeded", finished_at: testDb.fn.now() });
      await request("GET", "/backtest/overview");
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(running.id);
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalledWith(queuedEarlier.id);
      await testDb("backtest_jobs").whereIn("id", [running.id, queuedEarlier.id, putFirst.id]).delete();
    });

    it("move a queued download to the top without pausing, refuse one that is not queued, and leave a plain cancel cancelled", async () => {
      const [running] = await testDb("backtest_jobs").insert({ kind: "download", symbol: downloadSymbolA, start_date: "2024-01-02", end_date: "2024-01-05", status: "running", pid: 778, heartbeat_at: testDb.fn.now(), started_at: testDb.fn.now() }).returning("id");
      const [first] = await testDb("backtest_jobs").insert({ kind: "download", symbol: downloadSymbolB, start_date: "2024-01-02", end_date: "2024-01-05", status: "queued", queued_at: testDb.raw("now() - interval '2 hours'") }).returning("id");
      const [second] = await testDb("backtest_jobs").insert({ kind: "download", symbol: downloadSymbolC, start_date: "2024-01-02", end_date: "2024-01-05", status: "queued", queued_at: testDb.raw("now() - interval '1 hour'") }).returning("id");

      const moved = await request("POST", `/backtest/jobs/${second.id}/put-first`, {});
      expect(moved.body).toMatchObject({ id: second.id, displayStatus: "queued", putFirst: true });
      expect(await testDb("backtest_jobs").where({ id: running.id }).first("cancel_requested", "pause_requested")).toEqual({ cancel_requested: false, pause_requested: false });
      const queueOrder = ((await request("GET", "/backtest/overview")).body as BacktestOverview).jobs.filter((job) => job.displayStatus === "queued" && [first.id, second.id].includes(job.id)).map((job) => job.id);
      expect(queueOrder).toEqual([second.id, first.id]);
      expect((await request("POST", `/backtest/jobs/${running.id}/put-first`, {})).status).toBe(409);
      expect((await request("POST", `/backtest/jobs/${second.id}/put-first`, { pauseRunning: 1 })).status).toBe(400);

      // A cancel while pausing ends the job cancelled.
      await request("POST", `/backtest/jobs/${second.id}/put-first`, { pauseRunning: true });
      await request("POST", `/backtest/jobs/${running.id}/cancel`);
      expect(await requeuePausedDownload(running.id as string, 778, { done: 0, total: 0, label: null })).toBe(false);
      await testDb("backtest_jobs").whereIn("id", [running.id, first.id, second.id]).delete();
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

    it("list the downloads as the queue runs them (running, stopped, the queue in the order it starts them, then the last to end of the finished ones up to 50) and the 50 latest backtests", async () => {
      const secondsAgo = (seconds: number) => testDb.raw("now() - (?::int * interval '1 second')", [seconds]);
      const instantSecondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);
      const daySeconds = 86_400;
      // The running download (its heartbeat fresh, so the overview starts nothing) and two that stopped.
      const running = await insertListingDownload({ status: "running", queued_at: secondsAgo(900), started_at: secondsAgo(900), heartbeat_at: secondsAgo(2) });
      const stoppedLongAgo = await insertListingDownload({ status: "running", queued_at: secondsAgo(30 * daySeconds), started_at: secondsAgo(30 * daySeconds), heartbeat_at: secondsAgo(30 * daySeconds) });
      const stoppedRecently = await insertListingDownload({ status: "running", queued_at: secondsAgo(3_600), started_at: secondsAgo(3_600), heartbeat_at: secondsAgo(300) });
      // The queue goes by when each entered it (a resume enters it again), then by creation, then by id.
      const sharedEntry = instantSecondsAgo(20);
      const sharedEntryAndCreation = instantSecondsAgo(10);
      const resumedLast = await insertListingDownload({ status: "queued", created_at: instantSecondsAgo(3 * daySeconds), queued_at: instantSecondsAgo(5) });
      const twins = [
        await insertListingDownload({ status: "queued", created_at: sharedEntryAndCreation, queued_at: sharedEntryAndCreation }),
        await insertListingDownload({ status: "queued", created_at: sharedEntryAndCreation, queued_at: sharedEntryAndCreation }),
      ];
      const sameEntryCreatedLater = await insertListingDownload({ status: "queued", created_at: instantSecondsAgo(3_600), queued_at: sharedEntry });
      const queuedSecond = await insertListingDownload({ status: "queued", created_at: instantSecondsAgo(30), queued_at: instantSecondsAgo(30) });
      const sameEntryCreatedEarlier = await insertListingDownload({ status: "queued", created_at: instantSecondsAgo(7_200), queued_at: sharedEntry });
      const queuedFirst = await insertListingDownload({ status: "queued", created_at: instantSecondsAgo(40), queued_at: instantSecondsAgo(40) });
      // 53 finished downloads that ended 10–530 s ago, and a failed one without finished_at whose last heartbeat was 25 s ago.
      const finishedStatuses = ["succeeded", "failed", "cancelled"];
      await testDb("backtest_jobs").insert(
        Array.from({ length: 53 }, (_, index) => ({ kind: "download", symbol: jobListingSymbol, status: finishedStatuses[index % 3], queued_at: secondsAgo(900), started_at: secondsAgo(900), finished_at: secondsAgo((index + 1) * 10) })),
      );
      const finishedByEnd = (await testDb("backtest_jobs").where({ symbol: jobListingSymbol }).whereNotNull("finished_at").orderBy("finished_at", "desc").select("id")).map((row) => row.id as string);
      const failedWithoutFinish = await insertListingDownload({ status: "failed", queued_at: secondsAgo(900), started_at: secondsAgo(900), heartbeat_at: secondsAgo(25) });
      const finishedInEndOrder = [...finishedByEnd.slice(0, 2), failedWithoutFinish, ...finishedByEnd.slice(2)];
      // A backtest that finished 8 days ago.
      const [oldBacktest] = await testDb("backtest_jobs").insert({ kind: "backtest", symbol: jobListingSymbol, status: "failed", queued_at: secondsAgo(8 * daySeconds + 600), finished_at: secondsAgo(8 * daySeconds) }).returning("id");

      const overview = (await request("GET", "/backtest/overview")).body as BacktestOverview;
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
      const listedDownloads = overview.jobs.filter((job) => job.kind === "download");
      const listedIds = listedDownloads.map((job) => job.id);

      const unfinishedInListOrder = [running, stoppedRecently, stoppedLongAgo, queuedFirst, queuedSecond, sameEntryCreatedEarlier, sameEntryCreatedLater, ...[...twins].sort(), resumedLast];
      expect(listedIds.filter((id) => unfinishedInListOrder.includes(id))).toEqual(unfinishedInListOrder);
      expect(unfinishedInListOrder.map((id) => listedDownloads.find((job) => job.id === id)?.displayStatus)).toEqual(["running", "stopped", "stopped", ...Array<string>(7).fill("queued")]);
      // Whatever else the shared database holds: the groups in that order, and every unfinished download listed.
      const listGroups = listedDownloads.map((job) => downloadListGroupByDisplayStatus[job.displayStatus]);
      expect(listGroups).toEqual([...listGroups].sort((a, b) => a - b));
      const unfinishedDownloadCount = await countUnfinishedDownloads();
      expect(listedDownloads.filter(isUnfinishedJob)).toHaveLength(unfinishedDownloadCount);
      // The finished ones fill the list up to 50, the last to end first: whichever of these made it are the last of them to
      // end (the one without finished_at among them), and none listed ended before the latest one left out.
      expect(listedDownloads).toHaveLength(Math.max(50, unfinishedDownloadCount));
      const listedFinishedOfThese = listedIds.filter((id) => finishedInEndOrder.includes(id));
      expect(listedFinishedOfThese.length).toBeGreaterThan(3);
      expect(listedFinishedOfThese.length).toBeLessThan(finishedInEndOrder.length);
      expect(listedFinishedOfThese).toEqual(finishedInEndOrder.slice(0, listedFinishedOfThese.length));
      const endedAt = (job: BacktestJobView) => new Date(job.finishedAt ?? job.heartbeatAt ?? job.createdAt).getTime();
      const listedEndTimes = listedDownloads.filter((job) => !isUnfinishedJob(job)).map(endedAt);
      expect(listedEndTimes).toEqual([...listedEndTimes].sort((a, b) => b - a));
      const latestLeftOut = await testDb("backtest_jobs").where({ id: finishedInEndOrder[listedFinishedOfThese.length] }).first("finished_at");
      expect(listedEndTimes.every((time) => time >= new Date(latestLeftOut.finished_at).getTime())).toBe(true);
      // The backtests are listed as before: each kind has its own 50, however old; the backtest stays while there are no more than 50.
      const backtestJobCount = Number((await testDb("backtest_jobs").where({ kind: "backtest" }).count("* as count").first())?.count);
      expect(overview.jobs.filter((job) => job.kind === "backtest")).toHaveLength(Math.min(50, backtestJobCount));
      if (backtestJobCount <= 50) expect(overview.jobs.map((job) => job.id)).toContain(oldBacktest.id);

      // Each time the running download ends, the queue starts the next one listed.
      const queuedInListOrder = listedDownloads.filter((job) => job.displayStatus === "queued").map((job) => job.id);
      let runningId = running;
      for (const expectedNext of queuedInListOrder) {
        await testDb("backtest_jobs").where({ id: runningId }).update({ status: "succeeded", finished_at: testDb.fn.now() });
        const downloadsAfter = ((await request("GET", "/backtest/overview")).body as BacktestOverview).jobs.filter((job) => job.kind === "download");
        expect(downloadsAfter[0]).toMatchObject({ id: expectedNext, displayStatus: "running" });
        runningId = expectedNext;
      }
      expect(spawnBacktestJobProcessMock.mock.calls.map(([jobId]) => jobId)).toEqual(queuedInListOrder);

      await testDb("backtest_jobs").where({ symbol: jobListingSymbol }).del();
    });

    it("list every unfinished download however many, and no finished one once they reach 50", async () => {
      const secondsAgo = (seconds: number) => testDb.raw("now() - (?::int * interval '1 second')", [seconds]);
      const running = await insertListingDownload({ status: "running", queued_at: secondsAgo(900), started_at: secondsAgo(900), heartbeat_at: secondsAgo(2) });
      const stopped = await insertListingDownload({ status: "running", queued_at: secondsAgo(3_600), started_at: secondsAgo(3_600), heartbeat_at: secondsAgo(300) });
      // 52 queued: with the running and the stopped one, 54 unfinished downloads.
      const queuedRows: { id: string; queued_at: Date }[] = await testDb("backtest_jobs")
        .insert(Array.from({ length: 52 }, (_, index) => ({ kind: "download", symbol: jobListingSymbol, status: "queued", queued_at: secondsAgo(600 - index) })))
        .returning(["id", "queued_at"]);
      const queuedInQueueOrder = [...queuedRows].sort((a, b) => new Date(a.queued_at).getTime() - new Date(b.queued_at).getTime()).map((row) => row.id);
      const finished = await insertListingDownload({ status: "succeeded", queued_at: secondsAgo(60), started_at: secondsAgo(60), finished_at: secondsAgo(1) });

      const listedDownloads = ((await request("GET", "/backtest/overview")).body as BacktestOverview).jobs.filter((job) => job.kind === "download");
      expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
      const unfinishedDownloadCount = await countUnfinishedDownloads();
      expect(unfinishedDownloadCount).toBeGreaterThanOrEqual(54);
      expect(listedDownloads).toHaveLength(unfinishedDownloadCount);
      expect(listedDownloads.every(isUnfinishedJob)).toBe(true);
      const theseInListOrder = [running, stopped, ...queuedInQueueOrder];
      expect(listedDownloads.map((job) => job.id).filter((id) => theseInListOrder.includes(id))).toEqual(theseInListOrder);
      expect(listedDownloads.map((job) => job.id)).not.toContain(finished);

      await testDb("backtest_jobs").where({ symbol: jobListingSymbol }).del();
    });
  });

  describe("sessions", () => {
    let session: BacktestSessionListItem;
    let sessionJob: BacktestJobView;
    let secondSession: BacktestSessionListItem;

    const sessionRequest = (name: string, overrides: unknown = {}) => ({ name: `${sessionNamePrefix} ${name}`, symbol: fileSymbol, startDate: "2026-09-01", endDate: "2026-09-11", startingValue: 1_000_000, tablesMode: "walk_forward", overrides });
    /** This run's sessions in the Sessions list (the shared test database holds others), with more of the query after it. */
    const listSessions = async (query = "") => (await request("GET", `/backtest/sessions?search=${encodeURIComponent(sessionNamePrefix)}${query}`)).body as BacktestSessionsPage;

    it("summarize the symbol file in the overview", async () => {
      const { body } = await request("GET", "/backtest/overview");
      const overview = body as BacktestOverview;
      expect(overview.dataDirectory).toBe(dataDirectory);
      expect(overview.files.find((file) => file.symbol === fileSymbol)).toMatchObject({
        firstDate: "2026-09-01",
        lastDate: "2026-09-11",
        completeDays: 7,
        missingWeekdays: 1,
        // One day recorded as impossible to retrieve; a file from before intraday quotes.
        daysWithIssues: 0,
        unavailableDays: 1,
        intradayDays: null,
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
      expect((await request("POST", "/backtest/sessions", sessionRequest("x", { pluto: { windowStartEt: "11:00" } }))).body).toEqual({ error: "pluto.windowStartEt cannot be changed for a session." });
      expect(await withClaudeCliPath(undefined, () => request("POST", "/backtest/sessions", sessionRequest("x", { decisionMaker: "llm" })))).toEqual({
        status: 400,
        body: { error: "The AI model as decision maker needs BACKTEST_CLAUDE_CLI_PATH in the API's .env (the Claude Code CLI to call): set it and restart the API." },
      });
      expect((await request("POST", "/backtest/sessions", sessionRequest("x", { policy: { roll: "sometimes" } }))).status).toBe(400);
      expect((await request("POST", "/backtest/sessions", sessionRequest("x", { policy: { eventClose: "sometimes" } }))).status).toBe(400);
    });

    it("take the AI model as decision maker once the CLI is configured, with the calls and model time it may take", async () => {
      const { status, body } = await withClaudeCliPath("/usr/local/bin/claude", () => request("POST", "/backtest/sessions", sessionRequest("llm", { decisionMaker: "llm" })));
      expect(status).toBe(201);
      const created = body as CreateBacktestSessionResponse;
      // 2026-09-01 to 2026-09-11: 9 weekdays; the looks of a full day in Pluto's window, 1 to 2 calls each, 4.8 seconds a call.
      const window = await testDb("pluto_settings").where({ id: 1 }).first("window_start_et", "window_end_et");
      const looksPerDay = lookTimesInWindow(window.window_start_et, window.window_end_et, 16 * 60).length;
      expect(looksPerDay).toBeGreaterThan(0);
      expect(created.llmEstimate).toEqual({ tradingDays: 9, callsLow: 9 * looksPerDay, callsHigh: 18 * looksPerDay, modelHoursLow: Math.round(((9 * looksPerDay * 4.8) / 3600) * 10) / 10, modelHoursHigh: Math.round(((18 * looksPerDay * 4.8) / 3600) * 10) / 10 });
      expect(created.session.overrideCount).toBe(1);
      expect((await testDb("backtest_sessions").where({ id: created.session.id }).first("overrides")).overrides).toEqual({ decisionMaker: "llm" });
      expect((await request("DELETE", `/backtest/sessions/${created.session.id}`)).status).toBe(204);
    });

    it("estimate a session before it starts: the AI model's calls and model time, nothing created, the same checks as creating it", async () => {
      const sessionsBefore = await testDb("backtest_sessions").count({ total: "*" }).first();
      const llm = await withClaudeCliPath("/usr/local/bin/claude", () => request("POST", "/backtest/sessions/estimate", sessionRequest("estimate", { decisionMaker: "llm" })));
      expect(llm.status).toBe(200);
      const window = await testDb("pluto_settings").where({ id: 1 }).first("window_start_et", "window_end_et");
      const looksPerDay = lookTimesInWindow(window.window_start_et, window.window_end_et, 16 * 60).length;
      expect((llm.body as { llmEstimate: unknown }).llmEstimate).toMatchObject({ tradingDays: 9, callsLow: 9 * looksPerDay, callsHigh: 18 * looksPerDay });
      expect((llm.body as { warnings: string[] }).warnings).toEqual([`${fileSymbol}: 7 of its 7 days in the period have no intraday quotes: on those days it gets one look, at 10:00.`]);
      expect((await request("POST", "/backtest/sessions/estimate", sessionRequest("estimate"))).body).toMatchObject({ llmEstimate: null });
      const { name: _unnamed, ...withoutName } = sessionRequest("estimate");
      expect((await request("POST", "/backtest/sessions/estimate", withoutName)).status).toBe(200);
      expect((await withClaudeCliPath(undefined, () => request("POST", "/backtest/sessions/estimate", sessionRequest("estimate", { decisionMaker: "llm" })))).status).toBe(400);
      expect((await request("POST", "/backtest/sessions/estimate", { ...sessionRequest("estimate"), endDate: "2026-09-14" })).status).toBe(400);
      expect(await testDb("backtest_sessions").count({ total: "*" }).first()).toEqual(sessionsBefore);
    });

    it("refuse a period in which the file has weekdays with nothing stored, and take one with only days recorded as unavailable", async () => {
      const partSession = (startDate: string, endDate: string) => ({ ...sessionRequest("part"), symbol: partFileSymbol, startDate, endDate });
      expect(await request("POST", "/backtest/sessions", partSession("2026-09-01", "2026-09-10"))).toEqual({
        status: 400,
        // The 3rd, the 4th and Labor Day (no row says it was a holiday); the 9th is recorded as unavailable and is not one of them.
        body: { error: `${partFileSymbol}'s file has 3 weekdays missing between 2026-09-03 and 2026-09-07: finish its download or shorten the period.` },
      });
      const { status, body } = await request("POST", "/backtest/sessions", partSession("2026-09-08", "2026-09-10"));
      expect(status).toBe(201);
      const created = body as CreateBacktestSessionResponse;
      // The file has no intraday quotes: the session runs, and the answer says what that means.
      expect(created.warnings).toEqual([`${partFileSymbol}: 2 of its 2 days in the period have no intraday quotes: on those days it gets one look, at 10:00.`]);
      expect((await request("DELETE", `/backtest/sessions/${created.session.id}`)).status).toBe(204);
    });

    it("store the settings snapshot and only the changed values, and start the backtest job", async () => {
      const currentMinEdgeYield = Number((await testDb("pluto_settings").where({ id: 1 }).first("min_edge_yield_pct")).min_edge_yield_pct);
      const { status, body } = await request("POST", "/backtest/sessions", sessionRequest("edge", { pluto: { minEdgeYieldPct: currentMinEdgeYield + 5, maxAbsDelta: undefined }, kellyFraction }));
      expect(status).toBe(201);
      ({ session, job: sessionJob } = body as CreateBacktestSessionResponse);
      expect((body as CreateBacktestSessionResponse).warnings).toEqual([`${fileSymbol}: 7 of its 7 days in the period have no intraday quotes: on those days it gets one look, at 10:00.`]);
      expect((body as CreateBacktestSessionResponse).llmEstimate).toBeNull();
      expect(session).toMatchObject({ symbol: fileSymbol, startDate: "2026-09-01", endDate: "2026-09-11", startingValue: 1_000_000, tablesMode: "walk_forward", status: "queued", overrideCount: 1, metrics: null });
      expect(sessionJob).toMatchObject({ kind: "backtest", sessionId: session.id, sessionName: session.name, displayStatus: "running" });
      expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(sessionJob.id);
      const row = await testDb("backtest_sessions").where({ id: session.id }).first("settings_snapshot", "overrides");
      expect(row.overrides).toEqual({ pluto: { minEdgeYieldPct: currentMinEdgeYield + 5 } });
      expect(Object.keys(row.settings_snapshot).sort()).toEqual(["baseline", "decisionMaker", "kellyFraction", "model", "pluto", "policy", "trading"]);
      expect(row.settings_snapshot).toMatchObject({ decisionMaker: "rules", policy: { roll: "flagged_legs", buyback: "when_offered", sharesInProfit: "call_else_sell", eventClose: "stress_vs_remaining", afterBlockedChoice: "try_next" } });
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
      expect(detail.session.detectedSplits).toEqual([{ symbol: fileSymbol, lastDayBefore: "2026-09-04", firstDayAfter: "2026-09-08", ratio: 2 }]);
      expect(detail.job?.id).toBe(sessionJob.id);
      expect(detail.days.map((day) => [day.tradingDate, day.accountValue, day.dailyReturn, day.drawdown])).toEqual([
        ["2026-09-01", 1_000_000, null, 0],
        ["2026-09-02", 1_010_000, 0.01, 0],
        ["2026-09-03", 999_900, -0.01, 999_900 / 1_010_000 - 1],
      ]);
      expect(detail.days[1]).toMatchObject({ cash: 1_000_100, exposureDollars: 40_000, interestDollars: 11.5, baselineValue: 990_000, baselineDailyReturn: -0.01 });
      expect(detail.monthlyReturns).toEqual([{ month: "2026-09", sessionReturn: 999_900 / 1_000_000 - 1, baselineReturn: 0, spyBaselineReturn: null }]);
      expect(detail.trades).toHaveLength(1);
      expect(detail.trades[0]).toMatchObject({ openedOn: "2026-09-01", expiry: "2026-09-11", strike: 40, fillPrice: 0.525, sharePriceAtOpen: null, delta: -0.22, edgeYield: null, settledOn: "2026-09-11", inTheMoneyAtExpiry: false, pnlDollars: 518.2 });
      expect(typeof detail.trades[0]!.id).toBe("number");
      expect(detail.accuracyByMarginBand.find((band) => band.label === "10–20%")).toEqual({ label: "10–20%", tradeCount: 1, cycleCount: null, predictedPnlDollars: 400, calibratedPnlDollars: 300, realizedPnlDollars: 518.2 });
      // A session stored before the wheel was simulated has no book: its trade row has no leg or ending, the rest is empty.
      expect(detail.trades[0]).toMatchObject({ legId: null, endedBy: null });
      expect(detail).toMatchObject({ positions: [], cycles: [], tickerStatistics: [], allSymbolsStatistics: null, bookCounts: { filledActions: 0, blockedActions: 0, fills: 0 } });
      // Its symbol comes from the session.
      expect(detail.trades[0]!.symbol).toBe(fileSymbol);
    });

    it("return a session's simulated book: positions with their legs, wheel cycles and the per-ticker statistics, and its actions and fills page by page", async () => {
      const at = "2026-09-01T14:00:00.000Z";
      const settledAt = "2026-09-04T20:00:00.000Z";
      const bucket = { premium: 0, stock: 0, total: 0, capital: 0 };
      await testDb("backtest_positions").insert([
        { session_id: session.id, position_id: "position-4", sequence: 1, symbol: fileSymbol, strategy_key: "unstructured", status: "open", opened_at: settledAt, unstructured_reason: "csp_assigned_stock", capital_at_risk_dollars: 4000, capital_deployed_dollars: 4000, realized_pnl_dollars: 0, realized_premium_pnl_dollars: 0, realized_stock_pnl_dollars: 0, unrealized_pnl_dollars: -150, share_source_position_ids: JSON.stringify(["position-1"]) },
        { session_id: session.id, position_id: "position-1", sequence: 0, symbol: fileSymbol, strategy_key: "cash_secured_put", status: "closed", opened_at: at, closed_at: settledAt, close_reason: "assigned", capital_at_risk_dollars: 3950, capital_deployed_dollars: 3950, realized_pnl_dollars: 49.32, realized_premium_pnl_dollars: 49.32, realized_stock_pnl_dollars: 0, unrealized_pnl_dollars: null },
      ]);
      await testDb("backtest_position_legs").insert([
        { session_id: session.id, leg_id: "leg-5", sequence: 1, position_id: "position-4", leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 40, entry_at: settledAt },
        { session_id: session.id, leg_id: "leg-2", sequence: 0, position_id: "position-1", leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: 40, expiry_date: "2026-09-04", multiplier: 100, entry_price: 0.4932, entry_at: at, exit_price: 0, exit_at: settledAt, settled_as: "assigned", expiry_close: 38.5, dte_at_entry: 3, realized_pnl_dollars: 49.32 },
      ]);
      await testDb("backtest_fills").insert([
        { session_id: session.id, fill_id: "trade-6", sequence: 1, position_id: "position-4", leg_id: "leg-5", symbol: fileSymbol, instrument: "stock", side: "buy", quantity: 100, multiplier: 1, price: 40, commission_dollars: 0, executed_at: settledAt, trading_date: "2026-09-04", is_closing: false, action_id: null },
        { session_id: session.id, fill_id: "trade-3", sequence: 0, position_id: "position-1", leg_id: "leg-2", symbol: fileSymbol, instrument: "option", side: "sell", quantity: 1, multiplier: 100, price: 0.5, commission_dollars: 0.68, executed_at: at, trading_date: "2026-09-01", is_closing: false, action_id: "action-1" },
      ]);
      await testDb("backtest_actions").insert([
        { session_id: session.id, action_id: "action-2", sequence: 1, trading_date: "2026-09-02", at: "2026-09-02T14:00:00.000Z", pass_number: 1, symbol: fileSymbol, kind: "open_cash_secured_put", candidate_id: `${fileSymbol}:open:2`, description: `${fileSymbol} Sell $39 Put · 11 Sep (9DTE)`, automatic: false, chosen_because: "Pluto's top pick by Edge Yield", outcome: "blocked", block_reason: "sizing: no room", gate_results: JSON.stringify([{ gate: "sizing", ok: false, detail: "no room" }]) },
        { session_id: session.id, action_id: "action-1", sequence: 0, trading_date: "2026-09-01", at, pass_number: 1, symbol: fileSymbol, kind: "open_cash_secured_put", candidate_id: `${fileSymbol}:open:1`, description: `${fileSymbol} Sell $40 Put · 4 Sep (3DTE) · 1× @ 0.50`, automatic: false, chosen_because: "Pluto's top pick by Edge Yield", outcome: "filled", gate_results: JSON.stringify([{ gate: "sizing", ok: true, detail: "1 contract" }]), contract: JSON.stringify({ strategyKey: "cash_secured_put", expiry: "2026-09-04", strike: 40, right: "P" }), candidate_scores: JSON.stringify({ dte: 3 }), quantity: 1, limit_price: 0.5, fill_price: 0.5, position_ids: JSON.stringify(["position-1"]) },
      ]);
      await testDb("backtest_cycles").insert({ session_id: session.id, symbol: fileSymbol, cycle_number: 1, status: "open", opened_at: at, opened_on: "2026-09-01", assigned_on: "2026-09-04", age_sessions: 5, total_dollars: -100.68, net_premium_dollars: 49.32, shares_held: 100, break_even_per_share: 39.5068, buckets: JSON.stringify({ csp: { ...bucket, premium: 49.32, stock: -150, total: -100.68, capital: 4000 }, unstructured: bucket, cc: bucket, hedge: bucket }), data_flags: JSON.stringify([]) });

      const detail = (await request("GET", `/backtest/sessions/${session.id}`)).body as BacktestSessionDetail;
      // In the order the simulated book created them, whatever order the rows were stored in.
      expect(detail.positions.map((position) => [position.positionId, position.strategyKey, position.status, position.closeReason, position.legs.map((leg) => leg.legId)])).toEqual([
        ["position-1", "cash_secured_put", "closed", "assigned", ["leg-2"]],
        ["position-4", "unstructured", "open", null, ["leg-5"]],
      ]);
      expect(detail.positions[0]).toMatchObject({ openedAt: at, closedAt: settledAt, realizedPnlDollars: 49.32, unrealizedPnlDollars: null, shareSourcePositionIds: [] });
      expect(detail.positions[0]!.legs[0]).toEqual({ legId: "leg-2", parentLegId: null, legType: "option", side: "short", quantity: 1, optionType: "put", strike: 40, expiry: "2026-09-04", multiplier: 100, entryPrice: 0.4932, entryAt: at, exitPrice: 0, exitAt: settledAt, settledAs: "assigned", expiryClose: 38.5, dteAtEntry: 3, realizedPnlDollars: 49.32, priceScale: 1 });
      expect(detail.positions[1]).toMatchObject({ unstructuredReason: "csp_assigned_stock", unrealizedPnlDollars: -150, shareSourcePositionIds: ["position-1"] });
      // Each position names the wheel cycle running when it opened: the put and the shares it put to the book are one cycle.
      expect(detail.positions.map((position) => [position.positionId, position.cycleNumber, position.cycleLabel])).toEqual([
        ["position-1", 1, `${fileSymbol} #1`],
        ["position-4", 1, `${fileSymbol} #1`],
      ]);
      // The actions and fills are not in the detail: it carries their counts, and they are read through their own pages.
      expect(detail).not.toHaveProperty("actions");
      expect(detail).not.toHaveProperty("fills");
      expect(detail.bookCounts).toEqual({ filledActions: 1, blockedActions: 1, fills: 2 });
      const bookUrl = `/backtest/sessions/${session.id}`;
      const fillsPage = (await request("GET", `${bookUrl}/fills`)).body as BacktestFillsPage;
      expect(fillsPage).toEqual({
        fills: [
          { fillId: "trade-3", positionId: "position-1", legId: "leg-2", symbol: fileSymbol, instrument: "option", side: "sell", quantity: 1, multiplier: 100, price: 0.5, priceScale: 1, commissionDollars: 0.68, executedAt: at, tradingDate: "2026-09-01", isClosing: false, actionId: "action-1" },
          { fillId: "trade-6", positionId: "position-4", legId: "leg-5", symbol: fileSymbol, instrument: "stock", side: "buy", quantity: 100, multiplier: 1, price: 40, priceScale: 1, commissionDollars: 0, executedAt: settledAt, tradingDate: "2026-09-04", isClosing: false, actionId: null },
        ],
        total: 2,
        limit: 200,
        offset: 0,
      });
      const actionsPage = (await request("GET", `${bookUrl}/actions`)).body as BacktestActionsPage;
      expect(actionsPage).toMatchObject({ total: 2, limit: 200, offset: 0 });
      expect(actionsPage.actions.map((action) => [action.actionId, action.tradingDate, action.outcome, action.blockReason, action.fillPrice, action.positionIds])).toEqual([
        ["action-1", "2026-09-01", "filled", null, 0.5, ["position-1"]],
        ["action-2", "2026-09-02", "blocked", "sizing: no room", null, []],
      ]);
      expect(actionsPage.actions[0]).toMatchObject({ at, passNumber: 1, kind: "open_cash_secured_put", automatic: false, gateResults: [{ gate: "sizing", ok: true, detail: "1 contract" }], contract: { strategyKey: "cash_secured_put", expiry: "2026-09-04", strike: 40, right: "P" }, candidateScores: { dte: 3 }, quantity: 1, limitPrice: 0.5 });
      // Filters (trading dates inclusive, symbol, the actions' outcome) and pages; total counts what the filters match.
      const actionIds = async (query: string) => ((await request("GET", `${bookUrl}/actions?${query}`)).body as BacktestActionsPage).actions.map((action) => action.actionId);
      const fillIds = async (query: string) => ((await request("GET", `${bookUrl}/fills?${query}`)).body as BacktestFillsPage).fills.map((fill) => fill.fillId);
      expect(await actionIds("outcome=blocked")).toEqual(["action-2"]);
      expect(await actionIds("from=2026-09-02")).toEqual(["action-2"]);
      expect(await actionIds("to=2026-09-01")).toEqual(["action-1"]);
      expect(await actionIds(`symbol=${fileSymbol.toLowerCase()}&from=2026-09-01&to=2026-09-02`)).toEqual(["action-1", "action-2"]);
      expect(await actionIds("symbol=ZZZZ")).toEqual([]);
      expect((await request("GET", `${bookUrl}/actions?limit=1&offset=1`)).body).toMatchObject({ actions: [expect.objectContaining({ actionId: "action-2" })], total: 2, limit: 1, offset: 1 });
      expect(await fillIds("from=2026-09-02&to=2026-09-04")).toEqual(["trade-6"]);
      expect(await fillIds("limit=1")).toEqual(["trade-3"]);
      expect((await request("GET", `${bookUrl}/fills?to=2026-09-01`)).body).toMatchObject({ total: 1 });
      expect(await request("GET", `${bookUrl}/actions?from=1%20Sep`)).toEqual({ status: 400, body: { error: "from must be a date (YYYY-MM-DD)." } });
      expect(await request("GET", `${bookUrl}/actions?from=2026-09-05&to=2026-09-01`)).toEqual({ status: 400, body: { error: "from must be on or before to." } });
      expect(await request("GET", `${bookUrl}/actions?outcome=maybe`)).toEqual({ status: 400, body: { error: "outcome must be filled or blocked." } });
      expect(await request("GET", `${bookUrl}/actions?limit=1001`)).toEqual({ status: 400, body: { error: "limit must be a whole number from 1 to 1000." } });
      expect(await request("GET", `${bookUrl}/fills?offset=-1`)).toEqual({ status: 400, body: { error: "offset must be a whole number from 0." } });
      expect(await request("GET", `${bookUrl}/fills?outcome=filled`)).toEqual({ status: 400, body: { error: "outcome filters actions only." } });
      expect((await request("GET", "/backtest/sessions/00000000-0000-4000-8000-000000000000/actions")).status).toBe(404);
      expect((await request("GET", "/backtest/sessions/00000000-0000-4000-8000-000000000000/fills")).status).toBe(404);
      expect(detail.cycles).toEqual([expect.objectContaining({ symbol: fileSymbol, cycleNumber: 1, status: "open", openedAt: at, closedAt: null, openedOn: "2026-09-01", closedOn: null, assignedOn: "2026-09-04", recoverySessions: null, ageSessions: 5, totalDollars: -100.68, netPremiumDollars: 49.32, sharesHeld: 100, breakEvenPerShare: 39.5068, dataFlags: [] })]);
      expect(detail.cycles[0]!.buckets.csp).toEqual({ premium: 49.32, stock: -150, total: -100.68, capital: 4000 });
      // Computed from the positions and cycles when the session is read.
      expect(detail.tickerStatistics).toEqual([
        { symbol: fileSymbol, optionSaleCount: 1, averageTradedDte: 3, putPositionCount: 1, putPositionsEnded: 1, putPositionsAssigned: 1, putAssignedShare: 1, realizedPnlDollars: 49.32, totalPnlDollars: -100.68, closedCycleCount: 0, openCycleCount: 1, recoverySessions: { count: 0, mean: null, median: null, longest: null }, openCycles: [{ symbol: fileSymbol, cycleNumber: 1, openedOn: "2026-09-01", assignedOn: "2026-09-04", ageSessions: 5, totalDollars: -100.68, sharesHeld: 100 }] },
      ]);
      // The same figures over every symbol together, and a session narrowed to one symbol.
      expect(detail.allSymbolsStatistics).toEqual({ ...detail.tickerStatistics[0]!, symbol: "All symbols" });
      const otherSymbol = (await request("GET", `/backtest/sessions/${session.id}?symbol=zzzz`)).body as BacktestSessionDetail;
      expect(otherSymbol).toMatchObject({ trades: [], positions: [], cycles: [], tickerStatistics: [], allSymbolsStatistics: null });
      expect(otherSymbol.days).toHaveLength(3);
      const sameSymbol = (await request("GET", `/backtest/sessions/${session.id}?symbol=${fileSymbol.toLowerCase()}`)).body as BacktestSessionDetail;
      expect(sameSymbol.positions).toHaveLength(2);
      expect(sameSymbol.trades).toHaveLength(1);
      expect((await request("GET", `/backtest/sessions/${session.id}?symbol=1abc`)).status).toBe(400);
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
      // The wheel cycles of a finished session measured per cycle, and how each session measures P&L.
      const { pnl_basis: pnlBasisBefore, status: statusBefore } = await testDb("backtest_sessions").where({ id: session.id }).first("pnl_basis", "status");
      await testDb("backtest_sessions").where({ id: session.id }).update({ pnl_basis: "wheel_cycle", status: "succeeded" });
      try {
        const finished = (await request("GET", `/backtest/compare?ids=${session.id},${secondSession.id}`)).body as BacktestCompareResponse;
        expect(finished.sessions.map((entry) => [entry.pnlBasis, entry.wheelCycles])).toEqual([
          ["wheel_cycle", { cycleCount: 1, closedCycleCount: 0, openCycleCount: 1, totalPnlDollars: -100.68, openCyclePnlDollars: -100.68 }],
          [secondSession.pnlBasis, null],
        ]);
        const listed = (await listSessions()).sessions.find((entry) => entry.id === session.id)!;
        expect(listed).toMatchObject({ pnlBasis: "wheel_cycle", wheelCycles: { openCycleCount: 1, totalPnlDollars: -100.68 } });
      } finally {
        await testDb("backtest_sessions").where({ id: session.id }).update({ pnl_basis: pnlBasisBefore, status: statusBefore });
      }
      expect((await request("GET", "/backtest/compare?ids=nope")).status).toBe(400);
      expect((await request("GET", "/backtest/compare?ids=00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("list sessions page by page, newest first, filtered by name, symbol and status, each with its latest job's run", async () => {
      const everything = await listSessions();
      expect(everything).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(everything.sessions.map((entry) => entry.id)).toEqual([secondSession.id, session.id]);
      expect(everything.symbols).toContain(fileSymbol);
      expect(await listSessions("&limit=1&offset=1")).toMatchObject({ sessions: [expect.objectContaining({ id: session.id })], total: 2, limit: 1, offset: 1 });

      // The name: any part, ignoring case; % and _ are not wildcards.
      const idsFor = async (query: string) => ((await request("GET", `/backtest/sessions?${query}`)).body as BacktestSessionsPage).sessions.map((entry) => entry.id);
      expect(await idsFor(`search=${encodeURIComponent(`${sessionNamePrefix} PLAIN`.toUpperCase())}`)).toEqual([secondSession.id]);
      expect(await idsFor(`search=${encodeURIComponent(`${sessionNamePrefix}%`)}`)).toEqual([]);
      expect(await idsFor(`search=${encodeURIComponent(sessionNamePrefix.replace("-", "_"))}`)).toEqual([]);
      // The symbol (any case) and the status: both sessions are still queued, which "running" matches.
      expect((await listSessions(`&symbol=${fileSymbol.toLowerCase()}`)).total).toBe(2);
      expect((await listSessions(`&symbol=${secondFileSymbol}`)).total).toBe(0);
      expect((await listSessions("&status=running")).total).toBe(2);
      expect((await listSessions("&status=succeeded")).total).toBe(0);

      // Each session carries its latest job's run, a stale heartbeat showing as stopped: the overview lists only the latest jobs.
      await testDb("backtest_jobs").where({ id: sessionJob.id }).update({ heartbeat_at: testDb.raw("now() - interval '2 minutes'") });
      try {
        const listed = (await listSessions()).sessions.find((entry) => entry.id === session.id)!;
        expect(listed.latestRun).toMatchObject({ status: "running", displayStatus: "stopped" });
      } finally {
        await testDb("backtest_jobs").where({ id: sessionJob.id }).update({ heartbeat_at: testDb.fn.now() });
      }

      expect(await request("GET", "/backtest/sessions?status=maybe")).toEqual({ status: 400, body: { error: "status must be succeeded, running, failed or cancelled." } });
      expect(await request("GET", "/backtest/sessions?symbol=1abc")).toEqual({ status: 400, body: { error: 'Not a valid symbol: "1abc"' } });
      expect(await request("GET", "/backtest/sessions?limit=201")).toEqual({ status: 400, body: { error: "limit must be a whole number from 1 to 200." } });
      expect(await request("GET", "/backtest/sessions?offset=-1")).toEqual({ status: 400, body: { error: "offset must be a whole number from 0." } });
      // The overview no longer carries the sessions.
      expect((await request("GET", "/backtest/overview")).body).not.toHaveProperty("sessions");
    });

    it("take a list of symbols for one book, inside the period all their files cover", async () => {
      const several = (startDate: string, endDate: string) => ({ name: `${sessionNamePrefix} several`, symbols: [fileSymbol.toLowerCase(), secondFileSymbol], startDate, endDate, startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} });
      expect(await request("POST", "/backtest/sessions", several("2026-09-01", "2026-09-11"))).toEqual({
        status: 400,
        body: { error: `The data files together cover 2026-09-02 to 2026-09-10 (${secondFileSymbol} starts 2026-09-02, ${secondFileSymbol} ends 2026-09-10): the dates must be inside that.` },
      });
      expect((await request("POST", "/backtest/sessions", { ...several("2026-09-02", "2026-09-10"), symbols: [fileSymbol, downloadSymbolA] })).body).toEqual({ error: `There is no data file for ${downloadSymbolA}: download it first.` });

      const { status, body } = await request("POST", "/backtest/sessions", several("2026-09-02", "2026-09-10"));
      expect(status).toBe(201);
      const created = body as { session: BacktestSessionListItem; job: BacktestJobView };
      const symbolsLabel = `${fileSymbol}, ${secondFileSymbol}`;
      expect(created.session).toMatchObject({ symbol: symbolsLabel, symbols: [fileSymbol, secondFileSymbol], startDate: "2026-09-02", endDate: "2026-09-10", status: "queued" });
      expect(created.job).toMatchObject({ kind: "backtest", symbol: symbolsLabel, sessionId: created.session.id });
      const row = await testDb("backtest_sessions").where({ id: created.session.id }).first("symbol", "symbols");
      expect(row).toEqual({ symbol: symbolsLabel, symbols: [fileSymbol, secondFileSymbol] });
      // The list, the detail and the comparison show the symbols; buy and hold is one curve for the list.
      const listed = (await listSessions()).sessions.find((entry) => entry.id === created.session.id)!;
      expect(listed.symbols).toEqual([fileSymbol, secondFileSymbol]);
      // The Symbol filter matches any of a session's symbols.
      expect((await listSessions(`&symbol=${secondFileSymbol}`)).sessions.map((entry) => entry.id)).toEqual([created.session.id]);
      expect((await listSessions()).symbols).toEqual(expect.arrayContaining([fileSymbol, secondFileSymbol]));
      const detail = (await request("GET", `/backtest/sessions/${created.session.id}`)).body as BacktestSessionDetail;
      expect(detail.session).toMatchObject({ symbol: symbolsLabel, symbols: [fileSymbol, secondFileSymbol] });
      // Splits are listed per symbol (the cached schedule written above is the first symbol's).
      expect(detail.session.detectedSplits).toEqual([{ symbol: fileSymbol, lastDayBefore: "2026-09-04", firstDayAfter: "2026-09-08", ratio: 2 }]);
      const comparison = (await request("GET", `/backtest/compare?ids=${created.session.id},${session.id}`)).body as BacktestCompareResponse;
      expect(comparison.sessions.map((entry) => entry.symbols)).toEqual([[fileSymbol, secondFileSymbol], [fileSymbol]]);
      expect(comparison.curves.map((curve) => curve.label)).toEqual([created.session.name, session.name, `Buy and hold · ${symbolsLabel}`, `Buy and hold · ${fileSymbol}`]);
      // A request written before sessions took a list still names one symbol.
      const single = (await request("POST", "/backtest/sessions", { name: `${sessionNamePrefix} single`, symbol: fileSymbol, startDate: "2026-09-01", endDate: "2026-09-11", startingValue: 1_000_000, tablesMode: "walk_forward", overrides: {} })).body as { session: BacktestSessionListItem };
      expect(single.session).toMatchObject({ symbol: fileSymbol, symbols: [fileSymbol] });
      expect((await request("DELETE", `/backtest/sessions/${created.session.id}`)).status).toBe(204);
      expect((await request("DELETE", `/backtest/sessions/${single.session.id}`)).status).toBe(204);
    });

    it("delete a session after stopping its running job", async () => {
      expect((await request("DELETE", `/backtest/sessions/${session.id}`)).status).toBe(204);
      expect(terminateLeftoverJobProcessesMock).toHaveBeenCalledWith(424_242, sessionJob.id);
      expect(await testDb("backtest_sessions").where({ id: session.id }).first()).toBeUndefined();
      expect(await testDb("backtest_jobs").where({ id: sessionJob.id }).first()).toBeUndefined();
      expect(await testDb("backtest_session_days").where({ session_id: session.id }).first()).toBeUndefined();
      for (const table of ["backtest_positions", "backtest_position_legs", "backtest_fills", "backtest_actions", "backtest_cycles"]) expect(await testDb(table).where({ session_id: session.id }).first()).toBeUndefined();
      expect((await request("GET", `/backtest/sessions/${session.id}`)).status).toBe(404);
      expect((await request("DELETE", `/backtest/sessions/${session.id}`)).status).toBe(404);
    });
  });
});
