import knexLibrary, { type Knex } from "knex";
import { afterEach, describe, expect, it, vi } from "vitest";

// The suggestions' library rebuild queue against the real test database: one queued rebuild at most, started only when
// no download is queued or running and no rebuild runs. The job process is not started (spawnBacktestJobProcess mocked).
vi.mock("../../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the library queue tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const spawnBacktestJobProcess = vi.hoisted(() => vi.fn(() => 424242));
vi.mock("./spawnBacktestJobProcess.js", () => ({ spawnBacktestJobProcess, terminateLeftoverJobProcesses: vi.fn() }));

const { db } = await import("../../db/connection.js");
const { kickPortfolioLibraryQueue, portfolioLibraryJobSymbol, queuePortfolioLibraryJob } = await import("./backtestJobStore.js");
const testDb: Knex = db;

const statusOf = async (jobId: string) => ((await testDb("backtest_jobs").where({ id: jobId }).first("status")) as { status: string }).status;

describe("the library rebuild queue", () => {
  afterEach(async () => {
    await testDb("backtest_jobs").where({ kind: "portfolio_library" }).delete();
    await testDb("backtest_jobs").where({ kind: "download", symbol: "LIBQUEUETEST" }).delete();
    spawnBacktestJobProcess.mockClear();
  });

  it("waits while a download is queued, keeps one queued rebuild, and starts it once the downloads are done", async () => {
    await testDb("backtest_jobs").where({ kind: "portfolio_library" }).delete();
    const [download] = await testDb("backtest_jobs").insert({ kind: "download", symbol: "LIBQUEUETEST", start_date: "2026-01-02", end_date: "2026-01-09", status: "queued" }).returning("id");
    const first = await queuePortfolioLibraryJob();
    expect(await queuePortfolioLibraryJob()).toBe(first);
    expect(await statusOf(first)).toBe("queued");
    expect(spawnBacktestJobProcess).not.toHaveBeenCalled();

    await testDb("backtest_jobs").where({ id: (download as { id: string }).id }).update({ status: "succeeded", finished_at: testDb.fn.now() });
    expect(await kickPortfolioLibraryQueue()).toBe(first);
    expect(await statusOf(first)).toBe("running");
    expect(spawnBacktestJobProcess).toHaveBeenCalledWith(first);
    expect((await testDb("backtest_jobs").where({ id: first }).first("symbol")).symbol).toBe(portfolioLibraryJobSymbol);
  });

  it("does not start a second rebuild while one runs", async () => {
    await testDb("backtest_jobs").where({ kind: "portfolio_library" }).delete();
    await testDb("backtest_jobs").insert({ kind: "portfolio_library", symbol: portfolioLibraryJobSymbol, status: "running", heartbeat_at: testDb.fn.now() });
    const queued = await queuePortfolioLibraryJob();
    expect(await statusOf(queued)).toBe("queued");
    expect(spawnBacktestJobProcess).not.toHaveBeenCalled();
  });
});
