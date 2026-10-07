import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Audit D (2026-10-07): day_signal_rerank_state's look columns (migration 20261007300002) against the test database.
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Day Signals store audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const store = await import("./daySignalsStore.js");
const testDb: Knex = db;
const tickerIds: string[] = [];
let counter = Date.now() % 100_000;

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `AWS${(counter += 1)}` }).returning(["id"]);
  tickerIds.push(ticker.id);
  return ticker.id;
}

afterEach(async () => {
  await testDb("day_signal_rerank_state").whereIn("ticker_id", tickerIds).del();
});

afterAll(async () => {
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb.destroy();
});

describe("day_signal_rerank_state look columns — audit D", () => {
  it("rejects a look kind other than price or timed", async () => {
    const tickerId = await createTicker();
    await expect(store.saveDayRerankState(tickerId, "2031-03-03", { referenceSpotPrice: 1, reranks: 1, firstSeenAt: null, lastLookAt: new Date(), lastLookKind: "hourly" as unknown as "timed" })).rejects.toThrow(/day_signal_rerank_state_last_look_kind_check/);
  });

  it("keeps millisecond look times exactly (the 15-minute gap compares them to the millisecond)", async () => {
    const tickerId = await createTicker();
    const lastLookAt = new Date("2031-03-03T15:22:48.123Z");
    const firstSeenAt = new Date("2031-03-03T14:07:16.987Z");
    await store.saveDayRerankState(tickerId, "2031-03-03", { referenceSpotPrice: 407.29, reranks: 2, firstSeenAt, lastLookAt, lastLookKind: "price" });
    const loaded = (await store.loadDayRerankStates("2031-03-03")).get(tickerId)!;
    expect(loaded.lastLookAt!.getTime()).toBe(lastLookAt.getTime());
    expect(loaded.firstSeenAt!.getTime()).toBe(firstSeenAt.getTime());
  });

  it("the first save of a new day replaces yesterday's look times, and yesterday's row is no longer loaded for today", async () => {
    const tickerId = await createTicker();
    await store.saveDayRerankState(tickerId, "2031-03-03", { referenceSpotPrice: 100, reranks: 5, firstSeenAt: new Date("2031-03-03T14:07:00Z"), lastLookAt: new Date("2031-03-03T19:50:00Z"), lastLookKind: "timed" });
    expect((await store.loadDayRerankStates("2031-03-04")).has(tickerId)).toBe(false);
    await store.saveDayRerankState(tickerId, "2031-03-04", { referenceSpotPrice: 90, reranks: 0, firstSeenAt: new Date("2031-03-04T14:07:00Z"), lastLookAt: null, lastLookKind: null });
    expect((await store.loadDayRerankStates("2031-03-04")).get(tickerId)).toEqual({ referenceSpotPrice: 90, reranks: 0, firstSeenAt: new Date("2031-03-04T14:07:00Z"), lastLookAt: null, lastLookKind: null });
    expect((await store.loadDayRerankStates("2031-03-03")).has(tickerId)).toBe(false);
  });
});
