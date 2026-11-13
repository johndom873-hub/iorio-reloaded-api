import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The books' provisional cash: an assignment counts once, through the worker's stock fill at the strike when the app
// holds it, and through the assigned leg's own movement only when it doesn't. Against a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadProvisionalCashMovements } = await import("./bookLedger.js");

const since = new Date("2026-11-09T00:00:00Z");
const assignedAt = new Date("2026-11-10T02:46:49Z");
const legExitAt = new Date("2026-11-10T02:47:40Z");

async function seedAssignedPosition(symbol: string, optionType: "call" | "put", strike: number, contracts: number) {
  const tickerId = randomUUID();
  const positionId = randomUUID();
  const optionLegId = randomUUID();
  await db("tickers").insert({ id: tickerId, symbol, company_name: symbol, sector: "Technology" });
  await db("positions").insert({ id: positionId, strategy_key: optionType === "call" ? "covered_call" : "cash_secured_put", ticker_id: tickerId, status: "closed", close_reason: "assigned", opened_at: new Date("2026-11-03T15:00:00Z"), closed_at: legExitAt });
  await db("position_legs").insert({ id: optionLegId, position_id: positionId, leg_type: "option", side: "short", quantity: contracts, option_type: optionType, strike_price: strike, expiry_date: "2026-11-09", multiplier: 100, entry_price: 0.5, entry_at: new Date("2026-11-03T15:00:00Z"), exit_price: 0, exit_at: legExitAt });
  // IBKR's $0 settlement record of the assigned option.
  await db("trades").insert({ position_leg_id: optionLegId, side: "buy", quantity: contracts, price: 0, executed_at: assignedAt, ibkr_order_id: "0", is_closing_trade: true });
  return { tickerId, positionId };
}

beforeAll(async () => {
  // A Call called away, with the worker's stock fill on the Covered Call's own shares.
  const call = await seedAssignedPosition("ASGC", "call", 41.5, 11);
  const stockLegId = randomUUID();
  await db("position_legs").insert({ id: stockLegId, position_id: call.positionId, leg_type: "stock", side: "long", quantity: 1100, multiplier: 1, entry_price: 40, entry_at: new Date("2026-11-03T15:00:00Z"), exit_price: 41.5, exit_at: legExitAt });
  await db("trades").insert({ position_leg_id: stockLegId, side: "sell", quantity: 1100, price: 41.5, executed_at: assignedAt, ibkr_order_id: "0", is_closing_trade: true });
  // A Put assigned whose shares' fill the app never saved.
  await seedAssignedPosition("ASGP", "put", 50, 2);
});
afterAll(async () => {
  await dropIsolatedTestDatabase(db);
});

describe("provisional cash movements of an assignment", () => {
  it("counts a called-away Call once, through its stock fill, and a Put with no stock fill through its assignment", async () => {
    const movements = await loadProvisionalCashMovements(since, []);
    expect(movements.map((movement) => ({ kind: movement.kind, amount: Math.round(movement.amount * 100) / 100 + 0 })).sort((first, second) => first.amount - second.amount)).toEqual([
      { kind: "assignment", amount: -10_000 },
      { kind: "fill", amount: 0 },
      { kind: "fill", amount: 0 },
      { kind: "fill", amount: 45_650 },
    ]);
  });
});
