import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// The ladder band's tables and the planner's database readers, on a private copy of the test tables: the band quotes
// stored and read back, Pluto's 10:00 forwards from today's fit, and the previous session's volumes.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadLadderBandQuotes, upsertLadderBandQuotes } = await import("./ladderBandQuotes.js");
const { defaultLadderBandPlannerDependencies } = await import("./ladderBandPlanLoader.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const todayIso = "2026-10-20";

beforeAll(async () => {
  await testDb("tickers").insert({ id: tickerId, symbol: "BAND", company_name: "Band Co" });
  await testDb("market_calendar").insert(["2026-10-16", "2026-10-19", "2026-10-20"].map((calendar_date) => ({ calendar_date, is_open: true })));
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("the ladder band's tables", () => {
  it("keeps each contract's latest quote of the day, with the cycle's stock price", async () => {
    const quote = { tickerId, tradingDateIso: todayIso, expiry: "2026-11-20", strike: 90, right: "P" as const, bid: 1.2, ask: 1.3, stockPrice: 100.5, errorCode: null, quotedAt: new Date("2026-10-20T15:00:00Z"), cycleNumber: 1 };
    await upsertLadderBandQuotes([quote, { ...quote, strike: 85, bid: 0.6, ask: 0.7 }]);
    await upsertLadderBandQuotes([{ ...quote, bid: 1.1, ask: 1.2, stockPrice: 101, quotedAt: new Date("2026-10-20T15:03:00Z"), cycleNumber: 2 }]);
    const quotes = await loadLadderBandQuotes(tickerId, todayIso);
    expect(quotes.sort((a, b) => a.strike - b.strike)).toEqual([
      { expiry: "2026-11-20", strike: 85, right: "P", bid: 0.6, ask: 0.7, stockPrice: 100.5, errorCode: null, quotedAt: new Date("2026-10-20T15:00:00Z"), cycleNumber: 1 },
      { expiry: "2026-11-20", strike: 90, right: "P", bid: 1.1, ask: 1.2, stockPrice: 101, errorCode: null, quotedAt: new Date("2026-10-20T15:03:00Z"), cycleNumber: 2 },
    ]);
    expect(await loadLadderBandQuotes(tickerId, "2026-10-19")).toEqual([]);
  });

  it("reads Pluto's 10:00 forwards only from today's finished fit", async () => {
    expect((await defaultLadderBandPlannerDependencies.loadForwardAnchors(tickerId, todayIso)).size).toBe(0);
    const [snapshot] = await testDb("option_chain_snapshots").insert({ ticker_id: tickerId, trading_date: todayIso, captured_at: new Date("2026-10-20T14:00:00Z"), status: "complete", underlying_price: 100 }).returning("id");
    await testDb("option_surface_fits").insert([
      { snapshot_id: snapshot.id, expiry: "2026-11-20", years_to_expiry: 31 / 365, forward_price: 100.25, status: "ok", point_count: 20, dropped_counts: {}, underlying_price: 100.1 },
      // A failed slice still has a forward (the parity one) and the snapshot's price stands in for a missing fit price.
      { snapshot_id: snapshot.id, expiry: "2026-12-18", years_to_expiry: 59 / 365, forward_price: 100.6, status: "fit_failed", point_count: 3, dropped_counts: {}, underlying_price: null },
    ]);
    // The fit has not finished: no anchors yet.
    expect((await defaultLadderBandPlannerDependencies.loadForwardAnchors(tickerId, todayIso)).size).toBe(0);
    await testDb("option_chain_snapshots").where({ id: snapshot.id }).update({ fit_completed_at: new Date("2026-10-20T14:06:00Z") });
    expect(await defaultLadderBandPlannerDependencies.loadForwardAnchors(tickerId, todayIso)).toEqual(
      new Map([
        ["2026-11-20", { forward: 100.25, spotPrice: 100.1 }],
        ["2026-12-18", { forward: 100.6, spotPrice: 100 }],
      ]),
    );
    expect((await defaultLadderBandPlannerDependencies.loadForwardAnchors(tickerId, "2026-10-21")).size).toBe(0);
  });

  it("reads the previous open session's volumes (Friday's on a Monday)", async () => {
    await testDb("option_session_volumes").insert([
      { ticker_id: tickerId, session_date: "2026-10-16", expiry: "2026-11-20", strike: 90, option_right: "P", volume: 120 },
      { ticker_id: tickerId, session_date: "2026-10-19", expiry: "2026-11-20", strike: 90, option_right: "P", volume: 300 },
    ]);
    expect(await defaultLadderBandPlannerDependencies.loadPreviousSessionVolume(tickerId, "2026-10-19")).toEqual(new Map([["2026-11-20|90|P", 120]]));
    expect(await defaultLadderBandPlannerDependencies.loadPreviousSessionVolume(tickerId, todayIso)).toEqual(new Map([["2026-11-20|90|P", 300]]));
  });
});
