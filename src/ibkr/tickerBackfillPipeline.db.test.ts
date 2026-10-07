import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The database run store against the real test database. Other test files leave their own backfill runs in the
// shared database, so every assertion is narrowed to the tickers this file creates.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the backfill run store tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { databaseRunStore } = await import("./tickerBackfillPipeline.js");
const { buildInitialBackfillSteps } = await import("../lib/tickerBackfillSteps.js");
const testDb: Knex = db;

const createdTickerIds: string[] = [];
let userId = "";
let counter = Date.now() % 100_000;

async function createTicker(onShortlist: boolean): Promise<{ id: string; symbol: string }> {
  const symbol = `BF${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Backfill Store Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, removed_at: onShortlist ? null : new Date() });
  return { id: ticker.id, symbol };
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `backfill-store-${Date.now()}`, display_name: "Backfill Store Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

afterAll(async () => {
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).whereNotNull("resumed_from_run_id").del();
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("databaseRunStore", () => {
  it("lists running runs oldest first with symbol and shortlist membership, and records which run a restart replaces", async () => {
    const onShortlist = await createTicker(true);
    const removed = await createTicker(false);
    const finished = await createTicker(true);
    const older = await databaseRunStore.create(removed.id, buildInitialBackfillSteps());
    await testDb("ticker_backfill_runs").where({ id: older.id }).update({ started_at: new Date(Date.now() - 60_000) });
    const newer = await databaseRunStore.create(onShortlist.id, buildInitialBackfillSteps("option_chain"));
    const done = await databaseRunStore.create(finished.id, buildInitialBackfillSteps());
    await databaseRunStore.finish(done.id, "complete", buildInitialBackfillSteps());

    const running = (await databaseRunStore.listRunning()).filter((run) => createdTickerIds.includes(run.tickerId));
    expect(running.map((run) => [run.id, run.symbol, run.onShortlist, run.resumedFromRunId])).toEqual([
      [older.id, removed.symbol, false, null],
      [newer.id, onShortlist.symbol, true, null],
    ]);
    expect(running[1]!.steps.map((step) => step.key)).toEqual(["chain_warmup", "first_snapshot"]);

    await databaseRunStore.finish(newer.id, "partial", running[1]!.steps);
    const restarted = await databaseRunStore.create(onShortlist.id, buildInitialBackfillSteps("option_chain"), newer.id);
    expect(restarted).toMatchObject({ status: "running", resumedFromRunId: newer.id });
    expect(await databaseRunStore.getLatest(onShortlist.id)).toMatchObject({ id: restarted.id, resumedFromRunId: newer.id });
  });
});
