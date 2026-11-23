import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// The snapshot window runs against a private copy of the test database's tables (it depends on today's New York date).
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadMarketDataLineBudget } = await import("./marketDataLineBudget.js");
const { easternTodaySql } = await import("../lib/easternTodaySql.js");

const testDb: Knex = db;

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

beforeEach(async () => {
  await testDb("account_pnl_snapshots").del();
});

async function insertSnapshot(daysAgo: number, netLiquidation: number | null): Promise<void> {
  await testDb.raw(`INSERT INTO account_pnl_snapshots (snapshot_date, net_liquidation_value) VALUES (${easternTodaySql} - ?::int, ?)`, [daysAgo, netLiquidation]);
}

describe("loadMarketDataLineBudget", () => {
  it("uses the lowest of the last 5 snapshots, not an older lower one", async () => {
    for (const [daysAgo, netLiquidation] of [
      [1, 1_300_000],
      [2, 1_250_000],
      [3, 1_210_000],
      [4, 1_280_000],
      [5, 1_400_000],
      [6, 900_000],
    ] as const) {
      await insertSnapshot(daysAgo, netLiquidation);
    }
    expect(await loadMarketDataLineBudget(testDb, "live")).toEqual({ budget: 111, estimatedIbkrCeiling: 121, netLiquidationUsed: 1_210_000 });
  });

  it("skips snapshots with no net liquidation", async () => {
    await insertSnapshot(1, null);
    await insertSnapshot(2, 1_500_000);
    expect((await loadMarketDataLineBudget(testDb, "live")).budget).toBe(140);
  });

  it("falls back to the floor when the newest snapshot is older than 7 days", async () => {
    await insertSnapshot(7, 2_000_000);
    await insertSnapshot(10, 2_000_000);
    expect(await loadMarketDataLineBudget(testDb, "live")).toEqual({ budget: 90, estimatedIbkrCeiling: 100, netLiquidationUsed: null });
  });

  it("stays at the floor on the paper login whatever the snapshots say", async () => {
    await insertSnapshot(1, 5_000_000);
    expect((await loadMarketDataLineBudget(testDb, "paper")).budget).toBe(90);
  });
});
