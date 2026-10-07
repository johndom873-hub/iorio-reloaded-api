import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Runs the Day Signals store queries against the test database (same convention as
// ibkrGatewayReconcilePositions.test.ts): `db` is pointed at TEST_DATABASE_URL for this file only.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { loadDayTickerContractContexts, loadDayUnpooledTickers } = await import("./daySignalsContractContextStore.js");
const { pruneDayQuotesOutsideSet, replaceTickerPoolExpiries, loadDaySignalExpiries, loadDayRerankStates, saveDayRerankState } = await import("./daySignalsStore.js");
const testDb: Knex = db;

const tradingDateIso = "2026-09-29";
const nearExpiryIso = "2026-10-23"; // 24 DTE
const farExpiryIso = "2027-06-18"; // far outside the 0-90 DTE capture range
const yyyymmdd = (iso: string) => iso.replaceAll("-", "");

let tickerId = "";
let snapshotId = "";

async function insertQuote(strike: number, right: "C" | "P", expiry = nearExpiryIso): Promise<void> {
  await testDb("day_signal_quotes").insert({ ticker_id: tickerId, expiry, strike, option_right: right, trading_date: tradingDateIso, bid: 1, ask: 2, quoted_at: new Date(), cycle_number: 1 });
}

const quotedContracts = async () =>
  (await testDb("day_signal_quotes").where({ ticker_id: tickerId }).select(testDb.raw("expiry::text as expiry"), "strike", "option_right as right").orderBy(["expiry", "strike", "option_right"])).map(
    (row: { expiry: string; strike: string; right: string }) => `${row.expiry}|${Number(row.strike)}|${row.right}`,
  );

beforeAll(async () => {
  const [ticker] = await testDb("tickers").insert({ symbol: `DS${Date.now() % 100_000}`, company_name: "Day Signals Test Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
  const [snapshot] = await testDb("option_chain_snapshots").insert({ ticker_id: tickerId, trading_date: tradingDateIso, captured_at: new Date(), underlying_price: 281.25, status: "complete" }).returning("id");
  snapshotId = snapshot.id;
  await testDb("option_chain_expiry_strikes").insert([
    { ticker_id: tickerId, expiry: yyyymmdd(nearExpiryIso), strikes: [270, 275, 280, 285] },
    { ticker_id: tickerId, expiry: yyyymmdd(farExpiryIso), strikes: [100, 200] },
  ]);
  await testDb("day_signal_expiries").insert([
    { ticker_id: tickerId, expiry: nearExpiryIso, trading_date: tradingDateIso, snapshot_id: snapshotId, rank: 1, seed_best_edge_dollars: 10, seed_best_net_edge: 0.1, seeded_at: new Date() },
    { ticker_id: tickerId, expiry: "2026-10-30", trading_date: tradingDateIso, snapshot_id: snapshotId, rank: 2, seed_best_edge_dollars: 5, seed_best_net_edge: 0.05, seeded_at: new Date() },
  ]);
  await insertQuote(280, "P");
  await insertQuote(285, "C");
  await insertQuote(290, "P", "2026-10-30");
});

afterAll(async () => {
  await testDb("day_signal_rerank_state").where({ ticker_id: tickerId }).del();
  await testDb("day_signal_quotes").where({ ticker_id: tickerId }).del();
  await testDb("day_signal_expiries").where({ ticker_id: tickerId }).del();
  await testDb("option_chain_expiry_strikes").where({ ticker_id: tickerId }).del();
  await testDb("option_chain_snapshots").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
});

describe("day signals store, against the database", () => {
  it("loads one context per pooled ticker: snapshot spot, strike grids inside the capture DTE range as ISO expiries, and last cycle's contracts", async () => {
    const pool = await loadDaySignalExpiries(tradingDateIso);
    const contexts = await loadDayTickerContractContexts(pool.filter((row) => row.tickerId === tickerId), tradingDateIso);
    expect(contexts.get(tickerId)!.snapshotId).toBe(snapshotId);
    const context = contexts.get(tickerId)!;
    expect(context.snapshotSpotPrice).toBe(281.25);
    expect(context.atmImpliedVolatility).toBeNull(); // no surface fit stored for this test ticker
    expect([...context.strikesByExpiry.keys()]).toEqual([nearExpiryIso]); // the 2027 grid is outside 0-90 DTE
    expect(context.strikesByExpiry.get(nearExpiryIso)).toEqual([270, 275, 280, 285]);
    expect(context.previousContracts).toEqual(expect.arrayContaining([{ expiry: nearExpiryIso, strike: 280, right: "P" }, { expiry: nearExpiryIso, strike: 285, right: "C" }, { expiry: "2026-10-30", strike: 290, right: "P" }]));
    expect(context.heldContracts).toEqual([]);
  });

  it("prunes only this ticker's quotes outside the kept set, and never wipes on an empty set", async () => {
    await pruneDayQuotesOutsideSet(tickerId, []);
    expect(await quotedContracts()).toHaveLength(3);
    await pruneDayQuotesOutsideSet(tickerId, [{ expiry: nearExpiryIso, strike: 280, right: "P" }, { expiry: "2026-10-30", strike: 290, right: "P" }]);
    expect(await quotedContracts()).toEqual([`${nearExpiryIso}|280|P`, `2026-10-30|290|P`]);
  });

  it("replaces one ticker's pooled expiries keeping its snapshot, and deletes the day quotes of expiries that left", async () => {
    const changed = await replaceTickerPoolExpiries(tickerId, tradingDateIso, snapshotId, [{ expiry: "2026-10-30", rank: 1, seedBestEdgeDollars: 99, seedBestNetEdge: 0.9 }], new Date());
    expect(changed).toBe(true);
    const pool = (await loadDaySignalExpiries(tradingDateIso)).filter((row) => row.tickerId === tickerId);
    expect(pool.map((row) => [row.expiry, row.rank, row.snapshotId])).toEqual([["2026-10-30", 1, snapshotId]]);
    expect(await quotedContracts()).toEqual([`2026-10-30|290|P`]);
  });

  it("persists the re-rank state per ticker and day: absent = none, save then update, other days ignored", async () => {
    expect((await loadDayRerankStates(tradingDateIso)).has(tickerId)).toBe(false);
    await saveDayRerankState(tickerId, tradingDateIso, { referenceSpotPrice: 299.73, reranks: 1, firstSeenAt: null, lastLookAt: null, lastLookKind: null });
    expect((await loadDayRerankStates(tradingDateIso)).get(tickerId)).toEqual({ referenceSpotPrice: 299.73, reranks: 1, firstSeenAt: null, lastLookAt: null, lastLookKind: null });
    await saveDayRerankState(tickerId, tradingDateIso, { referenceSpotPrice: 310.5, reranks: 2, firstSeenAt: null, lastLookAt: null, lastLookKind: null });
    expect((await loadDayRerankStates(tradingDateIso)).get(tickerId)).toEqual({ referenceSpotPrice: 310.5, reranks: 2, firstSeenAt: null, lastLookAt: null, lastLookKind: null });
    expect((await loadDayRerankStates("2026-09-30")).has(tickerId)).toBe(false);
  });

  it("creates a pool for a ticker the seed left out (on the given snapshot), and does nothing for an empty expiry list", async () => {
    await testDb("day_signal_expiries").where({ ticker_id: tickerId }).del();
    await testDb("day_signal_quotes").where({ ticker_id: tickerId }).del();
    await insertQuote(280, "P");
    expect(await replaceTickerPoolExpiries(tickerId, tradingDateIso, snapshotId, [{ expiry: nearExpiryIso, rank: 1, seedBestEdgeDollars: 1, seedBestNetEdge: 1 }], new Date())).toBe(true);
    const pool = (await loadDaySignalExpiries(tradingDateIso)).filter((row) => row.tickerId === tickerId);
    expect(pool.map((row) => [row.expiry, row.snapshotId])).toEqual([[nearExpiryIso, snapshotId]]);
    expect(await quotedContracts()).toEqual([`${nearExpiryIso}|280|P`]); // its quote of a pooled expiry survives
    expect(await replaceTickerPoolExpiries(tickerId, tradingDateIso, snapshotId, [], new Date())).toBe(false);
    expect((await loadDaySignalExpiries(tradingDateIso)).filter((row) => row.tickerId === tickerId)).toHaveLength(1);
  });

  it("lists a Signals-on shortlisted ticker with today's snapshot and no pool as unpooled, and stops listing it once pooled", async () => {
    const [user] = await testDb("users").insert({ username: `dstest${Date.now()}`, display_name: "Day Signals Test", password_hash: "x" }).returning("id");
    const [entry] = await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: user.id }).returning("id");
    try {
      await testDb("day_signal_expiries").where({ ticker_id: tickerId }).del();
      // Signals off: a price-only ticker is never in the Day Signals universe.
      expect((await loadDayUnpooledTickers(tradingDateIso)).some((ticker) => ticker.tickerId === tickerId)).toBe(false);
      await testDb("shortlist_entries").where({ id: entry.id }).update({ signals_enabled: true });
      const unpooled = (await loadDayUnpooledTickers(tradingDateIso)).find((ticker) => ticker.tickerId === tickerId);
      expect(unpooled).toMatchObject({ tickerId, snapshotId });
      expect(await replaceTickerPoolExpiries(tickerId, tradingDateIso, snapshotId, [{ expiry: nearExpiryIso, rank: 1, seedBestEdgeDollars: 1, seedBestNetEdge: 1 }], new Date())).toBe(true);
      expect((await loadDayUnpooledTickers(tradingDateIso)).some((ticker) => ticker.tickerId === tickerId)).toBe(false);
      expect((await loadDayUnpooledTickers("2026-09-30")).some((ticker) => ticker.tickerId === tickerId)).toBe(false); // no snapshot that day
    } finally {
      await testDb("shortlist_entries").where({ id: entry.id }).del();
      await testDb("users").where({ id: user.id }).del();
    }
  });
});
