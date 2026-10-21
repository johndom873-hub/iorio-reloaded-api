import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// What the ladder's look book reads for a ticker, against a private copy of the test tables: its open positions with every
// leg (closed legs included), oldest first; a closed position and another ticker's are left out.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadOpenPositionFigures } = await import("./ladderLookSnapshot.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const otherTickerId = randomUUID();

async function position(ticker: string, strategyKey: string, status: string, openedAt: string, legs: Record<string, unknown>[]): Promise<void> {
  const [row] = await testDb("positions").insert({ ticker_id: ticker, strategy_key: strategyKey, status, opened_at: openedAt }).returning("id");
  for (const leg of legs) await testDb("position_legs").insert({ position_id: row.id, ...leg });
}

beforeAll(async () => {
  await testDb("tickers").insert([{ id: tickerId, symbol: "SNAP1", company_name: "Snap Co" }, { id: otherTickerId, symbol: "SNAP2", company_name: "Other Co" }]);
  await position(tickerId, "covered_call", "open", "2026-10-01T14:00:00Z", [
    { leg_type: "stock", side: "long", quantity: 200, multiplier: 1, entry_price: 50.25, entry_at: "2026-10-01T14:00:00Z" },
    { leg_type: "option", side: "short", quantity: 2, option_type: "call", strike_price: 52, expiry_date: "2026-10-09", multiplier: 100, entry_price: 0.9, entry_at: "2026-10-01T14:00:00Z", exit_price: 0, exit_at: "2026-10-09T20:00:00Z" },
    { leg_type: "option", side: "short", quantity: 2, option_type: "call", strike_price: 53, expiry_date: "2026-10-23", multiplier: 100, entry_price: 0.7, entry_at: "2026-10-12T14:00:00Z" },
  ]);
  await position(tickerId, "cash_secured_put", "open", "2026-10-15T14:00:00Z", [{ leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: 45, expiry_date: "2026-11-20", multiplier: 100, entry_price: 0.8, entry_at: "2026-10-15T14:00:00Z" }]);
  await position(tickerId, "cash_secured_put", "closed", "2026-09-01T14:00:00Z", [{ leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: 40, expiry_date: "2026-09-18", multiplier: 100, entry_price: 0.5, entry_at: "2026-09-01T14:00:00Z", exit_price: 0, exit_at: "2026-09-18T20:00:00Z" }]);
  await position(otherTickerId, "cash_secured_put", "open", "2026-10-15T14:00:00Z", [{ leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: 30, expiry_date: "2026-11-20", multiplier: 100, entry_price: 0.4, entry_at: "2026-10-15T14:00:00Z" }]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("loadOpenPositionFigures", () => {
  it("reads the ticker's open positions, oldest first, each with every leg in entry order and numbers parsed", async () => {
    const positions = await loadOpenPositionFigures(tickerId);
    expect(positions.map((entry) => [entry.strategyKey, entry.status, entry.legs.length])).toEqual([["covered_call", "open", 3], ["cash_secured_put", "open", 1]]);
    const [coveredCall, put] = positions;
    expect(coveredCall!.legs.map((leg) => [leg.legType, leg.strikePrice, leg.expiryDate, leg.exitAt === null])).toEqual([["stock", null, null, true], ["option", 52, "2026-10-09", false], ["option", 53, "2026-10-23", true]]);
    expect(coveredCall!.legs[0]).toMatchObject({ side: "long", quantity: 200, multiplier: 1, entryPrice: 50.25, optionType: null, exitPrice: null });
    expect(coveredCall!.legs[1]).toMatchObject({ exitPrice: 0, exitAt: new Date("2026-10-09T20:00:00Z") });
    expect(put!.legs[0]).toMatchObject({ legType: "option", side: "short", quantity: 1, optionType: "put", strikePrice: 45, expiryDate: "2026-11-20", multiplier: 100, entryPrice: 0.8, entryAt: new Date("2026-10-15T14:00:00Z") });
  });

  it("reads nothing for a ticker with no open position", async () => {
    expect(await loadOpenPositionFigures(randomUUID())).toEqual([]);
  });
});
