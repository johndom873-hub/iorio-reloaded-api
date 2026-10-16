import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// The legs the nightly P&L snapshot values. Runs in a private copy of the test tables, so the open positions it reads
// are only the ones written here.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { fetchOpenLegsOfOpenPositions } = await import("./openPositionLegsForPnlSnapshot.js");
const testDb: Knex = db;

// An open Covered Call that sold 40 of its 100 shares (the sold 40 carved into a closed slice on the same position) and
// bought back one of its two calls (also a closed slice); a closed position on the same ticker.
const tickerId = randomUUID();
const ids = { openPosition: randomUUID(), closedPosition: randomUUID() };
const legIds = { openShares: randomUUID(), soldSlice: randomUUID(), openCall: randomUUID(), boughtBackSlice: randomUUID(), closedPositionShares: randomUUID() };
const openedAt = new Date("2026-10-05T14:00:00Z");
const partlyClosedAt = new Date("2026-10-08T15:00:00Z");

beforeAll(async () => {
  await testDb("tickers").insert({ id: tickerId, symbol: "SNAP1", company_name: "Snapshot Co", sector: "Technology" });
  await testDb("positions").insert([
    { id: ids.openPosition, strategy_key: "covered_call", ticker_id: tickerId, status: "open", opened_at: openedAt },
    { id: ids.closedPosition, strategy_key: "unstructured", ticker_id: tickerId, status: "closed", opened_at: openedAt, closed_at: partlyClosedAt, close_reason: "closed_via_app" },
  ]);
  const stockLeg = (id: string, positionId: string, quantity: number, exitAt: Date | null, parentLegId: string | null = null) => ({ id, position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, entry_price: 50, entry_at: openedAt, exit_price: exitAt === null ? null : 52, exit_at: exitAt, parent_leg_id: parentLegId });
  const callLeg = (id: string, quantity: number, exitAt: Date | null, parentLegId: string | null = null) => ({ id, position_id: ids.openPosition, leg_type: "option", side: "short", quantity, option_type: "call", strike_price: 55, expiry_date: "2026-10-16", multiplier: 100, entry_price: 1.2, entry_at: openedAt, exit_price: exitAt === null ? null : 0.4, exit_at: exitAt, parent_leg_id: parentLegId });
  await testDb("position_legs").insert([stockLeg(legIds.openShares, ids.openPosition, 60, null), callLeg(legIds.openCall, 1, null), stockLeg(legIds.closedPositionShares, ids.closedPosition, 100, partlyClosedAt)]);
  await testDb("position_legs").insert([stockLeg(legIds.soldSlice, ids.openPosition, 40, partlyClosedAt, legIds.openShares), callLeg(legIds.boughtBackSlice, 1, partlyClosedAt, legIds.openCall)]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("fetchOpenLegsOfOpenPositions", () => {
  it("values only the legs still open: a partial close's closed slices on the open position are left out", async () => {
    const legs = await fetchOpenLegsOfOpenPositions();
    expect(legs.map((leg) => leg.legId).sort()).toEqual([legIds.openShares, legIds.openCall].sort());
    const openCall = legs.find((leg) => leg.legId === legIds.openCall)!;
    expect(openCall).toMatchObject({ positionId: ids.openPosition, legType: "option", side: "short", quantity: 1, optionType: "call", expiryDate: "20261016", multiplier: 100, symbol: "SNAP1" });
    expect(Number(openCall.strikePrice)).toBe(55);
    expect(Number(openCall.entryPrice)).toBe(1.2);
  });
});
