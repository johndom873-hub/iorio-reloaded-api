import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Knex } from "knex";
import { syntheticOptionQuotes, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile } from "../backtest/engine/testSupport/syntheticBacktestData.js";
import { treasuryBillCachePath, treasuryBillSeriesId, type TreasuryBillCache } from "../backtest/engine/treasuryBillRates.js";
import type { AnalysisRunView, TickerAnalysisView } from "../backtest/analysis/analysisStore.js";
import type { StoredTickerOwnValues, TickerFieldValues, TickerOwnValueChange } from "../backtest/labTickerValuesStore.js";

// A ticker's own Vol Farmer v4 values through the backtest router, on a private copy of the test database: Save and
// Analyse stores them (checked in the table) and starts the ticker's analysis with them, the screens read them back, the
// refusals save nothing, Analyse Only runs a trial with other values, and nulls remove them. The job process itself is
// not started (spawn mocked).
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "backtest-ticker-values-route-test-"));
process.env.BACKTEST_DATA_DIR = dataDirectory;

const spawnBacktestJobProcessMock = vi.fn<(jobId: string) => number>();
vi.mock("../backtest/jobs/spawnBacktestJobProcess.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/jobs/spawnBacktestJobProcess.js")>()),
  spawnBacktestJobProcess: (jobId: string) => spawnBacktestJobProcessMock(jobId),
  terminateLeftoverJobProcesses: () => 0,
}));

vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { up: createTickerValuesTable } = await import("../db/migrations/20261102300001_create_backtest_lab_ticker_values.js");
const { backtestRouter } = await import("./backtest.js");
const { errorHandler } = await import("../middleware/errorHandler.js");
const testDb: Knex = db;
const symbol = "TVROUTE";
const symbolWithoutFile = "TVNOFILE";
let server: Server;
let baseUrl: string;
let userId: string;

type SaveAnswer = { tickerValues: StoredTickerOwnValues | null; changes: TickerOwnValueChange[]; run: AnalysisRunView };

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/backtest${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

/** Ends the running saved analysis, as its job would, so the next save can start one. */
const finishSavedAnalyses = () => testDb("backtest_ticker_analyses").where({ symbol }).whereNot({ reason: "trial" }).whereIn("status", ["queued", "running"]).update({ status: "cancelled", finished_at: testDb.fn.now() });

beforeAll(async () => {
  const days = ["2026-03-02", "2026-03-03", "2026-03-04"].map((tradingDate) => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, 50, ["2026-03-20"], 0.5, 0.04, 1, 3), endOfDayVolume: 100, openInterest: 500 }));
  writeSyntheticSymbolFile(path.join(dataDirectory, `${symbol}.sqlite`), symbol, days);
  writeSyntheticIbkrBarsFromQuotes(path.join(dataDirectory, `${symbol}.sqlite`), days.map(({ tradingDate }) => ({ tradingDate, open: 50, high: 51, low: 49, close: 50, volume: 1_000, impliedVolatility: 0.5 })), 4);
  const treasuryBillCache: TreasuryBillCache = { seriesId: treasuryBillSeriesId, fetchedAtIso: "2026-03-05T00:00:00.000Z", observations: ["2026-02-27", ...days.map(({ tradingDate }) => tradingDate)].map((dateIso) => ({ dateIso, ratePercent: 4 })) };
  writeFileSync(treasuryBillCachePath(dataDirectory), JSON.stringify(treasuryBillCache));
  // The lab seeds from Pluto's and the trading settings: copied from the shared schema.
  await testDb.raw("INSERT INTO pluto_settings SELECT * FROM public.pluto_settings");
  await testDb.raw("INSERT INTO trading_settings SELECT * FROM public.trading_settings");
  if (!(await testDb.schema.hasTable("backtest_lab_ticker_values"))) await createTickerValuesTable(testDb);
  const [user] = await testDb("users").insert({ username: "ticker-values-routes", display_name: "Ticker Values Routes", password_hash: "not-a-real-hash" }).returning("id");
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
  spawnBacktestJobProcessMock.mockReturnValue(424_244);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dropIsolatedTestDatabase(testDb);
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("a ticker's own values routes", () => {
  it("Save and Analyse stores the values and starts the ticker's analysis with them", async () => {
    const saved = await call<SaveAnswer>("PUT", `/ticker-values/${symbol}`, { callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 60 });
    expect(saved.status).toBe(200);
    expect(saved.body.tickerValues?.values).toEqual({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 60, putMaxAbsDelta: null, leapsMaxAccountPct: null });
    expect(saved.body.changes).toHaveLength(3);
    expect(saved.body.run).toMatchObject({ symbol, reason: "ticker_settings", status: "running" });
    expect(saved.body.run.labValues.tickerValues).toEqual(saved.body.tickerValues?.values);
    expect(saved.body.run.labValues.effective.v4).toMatchObject({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 60, putMaxAbsDelta: 0.3, leapsMaxAccountPct: 10 });
    expect(saved.body.run.labValues.effective.firstPositionShare).toBeCloseTo(0.6, 12);
    expect(spawnBacktestJobProcessMock).toHaveBeenCalledWith(saved.body.run.jobId);

    const row = await testDb("backtest_lab_ticker_values").where({ symbol }).first();
    expect(row).toMatchObject({ call_min_abs_delta: "0.1000", call_max_abs_delta: "0.4000", first_position_pct: "60.0000", put_max_abs_delta: null, leaps_max_account_pct: null, updated_by_user_id: userId });
    const stored = await testDb("backtest_ticker_analyses").where({ id: saved.body.run.id }).first("reason", "lab_values", "lab_values_hash");
    expect(stored.reason).toBe("ticker_settings");
    expect(stored.lab_values.tickerValues).toEqual(saved.body.tickerValues?.values);
    const audit = await testDb("backtest_lab_settings_audit").where({ symbol }).orderBy("field").select("field", "old_value", "new_value", "user_id");
    expect(audit).toEqual([
      { field: "volFarmerV4.callMaxAbsDelta", old_value: null, new_value: "0.4", user_id: userId },
      { field: "volFarmerV4.callMinAbsDelta", old_value: null, new_value: "0.1", user_id: userId },
      { field: "volFarmerV4.firstPositionPct", old_value: null, new_value: "60", user_id: userId },
    ]);
  });

  it("the Analyse window, the Data files table and New session read the values back", async () => {
    const view = await call<TickerAnalysisView>("GET", `/analyses/${symbol}`);
    expect(view.body.tickerValues?.values).toMatchObject({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 60 });
    expect(view.body.labTickerFieldValues).toEqual({ callMinAbsDelta: 0.05, callMaxAbsDelta: 0.5, firstPositionPct: 80, putMaxAbsDelta: 0.3, leapsMaxAccountPct: 10 });
    expect(view.body.active[0]?.labValuesHash).toBe(view.body.currentHash);

    const table = await call<{ tickerValuesBySymbol: Record<string, StoredTickerOwnValues>; labTickerFieldValues: TickerFieldValues }>("GET", "/analyses");
    expect(table.body.tickerValuesBySymbol[symbol]?.values.firstPositionPct).toBe(60);
    expect(table.body.labTickerFieldValues.firstPositionPct).toBe(80);

    const all = await call<{ labValues: TickerFieldValues; bySymbol: Record<string, StoredTickerOwnValues> }>("GET", "/ticker-values");
    expect(all.status).toBe(200);
    expect(Object.keys(all.body.bySymbol)).toEqual([symbol]);
    expect(all.body.labValues.callMaxAbsDelta).toBe(0.5);
  });

  it("refuses, saving nothing, while the saved analysis runs, a bad value, and a ticker without a data file", async () => {
    const running = await call<{ error: string }>("PUT", `/ticker-values/${symbol}`, { putMaxAbsDelta: 0.2 });
    expect(running.status).toBe(409);
    expect(running.body.error).toMatch(/already running/);
    await finishSavedAnalyses();
    const outOfRange = await call<{ error: string }>("PUT", `/ticker-values/${symbol}`, { putMaxAbsDelta: 1.5 });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.error).toMatch(/putMaxAbsDelta must be a number from 0.01 to 0.99/);
    const crossed = await call<{ error: string }>("PUT", `/ticker-values/${symbol}`, { callMinAbsDelta: 0.45 });
    expect(crossed.status).toBe(400);
    expect(crossed.body.error).toMatch(/callMinAbsDelta must not be above/);
    expect((await call("PUT", `/ticker-values/${symbolWithoutFile}`, { putMaxAbsDelta: 0.2 })).status).toBe(404);
    expect((await testDb("backtest_lab_ticker_values").where({ symbol }).first()).put_max_abs_delta).toBeNull();
    expect(await testDb("backtest_lab_ticker_values").where({ symbol: symbolWithoutFile }).first()).toBeUndefined();
    expect(spawnBacktestJobProcessMock).not.toHaveBeenCalled();
  });

  it("Analyse Only runs a trial with the panel's values, nothing saved for the ticker", async () => {
    const trial = await call<AnalysisRunView>("POST", `/analyses/${symbol}`, { values: { accountDollars: 200_000, volFarmerV4: { callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 70, putMaxAbsDelta: 0.2, leapsMaxAccountPct: 10 } } });
    expect(trial.status).toBe(202);
    expect(trial.body.reason).toBe("trial");
    expect(trial.body.labValues.trial?.volFarmerV4).toMatchObject({ firstPositionPct: 70, putMaxAbsDelta: 0.2 });
    expect(trial.body.labValues.effective.v4).toMatchObject({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 70, putMaxAbsDelta: 0.2 });
    expect((await testDb("backtest_lab_ticker_values").where({ symbol }).first()).first_position_pct).toBe("60.0000");
    const crossed = await call<{ error: string }>("POST", `/analyses/${symbol}`, { values: { accountDollars: 200_000, volFarmerV4: { callMinAbsDelta: 0.45 } } });
    expect(crossed.status).toBe(400);
    expect(crossed.body.error).toMatch(/The trial's values: volFarmerV4.callMinAbsDelta must not be above/);
  });

  it("nulls give the ticker the lab's values again: its row is deleted, and its analysis runs with none", async () => {
    const removed = await call<SaveAnswer>("PUT", `/ticker-values/${symbol}`, { callMinAbsDelta: null, callMaxAbsDelta: null, firstPositionPct: null });
    expect(removed.status).toBe(200);
    expect(removed.body.tickerValues).toBeNull();
    expect(removed.body.run.labValues.tickerValues).toBeNull();
    expect(await testDb("backtest_lab_ticker_values").where({ symbol }).first()).toBeUndefined();
    expect((await call<{ bySymbol: Record<string, unknown> }>("GET", "/ticker-values")).body.bySymbol).toEqual({});
  });
});
