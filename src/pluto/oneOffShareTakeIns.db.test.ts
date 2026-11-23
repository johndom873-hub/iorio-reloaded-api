import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { newVolFarmerV4SymbolState, volFarmerV4BreakEven } from "../backtest/engine/volFarmerV4Steps.js";

// The one-off catch-up of IBIT's 200 shares (Marcelo 2026-11-23), against a private copy of the test tables: prod's order
// as it was recorded (16 Calls at $0.14–0.15 and 200 shares at $35.56–35.57 with their commissions), taken into the first
// position once, with its marker event, and never again.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: vi.fn(async () => {}) }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { oneOffShareTakeIns, takeInOneOffShares } = await import("./oneOffShareTakeIns.js");
const { loadVolFarmerV4Memory } = await import("./volFarmerV4LookLoader.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const userId = randomUUID();
const actionId = oneOffShareTakeIns[0]!.actionId;

/** IBIT's memory after the order settled: 1,600 shares at $41.08545, the 16 Calls on them. */
function memoryOf1600() {
  const state = newVolFarmerV4SymbolState();
  state.first = { shares: 1_600, costPerShare: 41.08545325, premiums: [{ legId: "call-leg", dollars: 214.2456, shares: 1_600 }], calls: [{ legId: "call-leg", shares: 1_600 }], puts: [] };
  return { state, pending: [] };
}

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "one-off", display_name: "One Off", password_hash: "x" });
  await testDb("tickers").insert({ id: tickerId, symbol: "IBIT", company_name: "iShares Bitcoin Trust" });
  const [pass] = await testDb("pluto_passes").insert({ trigger: "order_ended", trigger_detail: "{}", model_called: false }).returning("id");
  await testDb("pluto_actions").insert({ id: actionId, pass_id: pass.id, kind: "open_covered_call", symbol: "IBIT", outcome: "filled", execution_strategy: "vol_farmer_v4" });
  const payload = { symbol: "IBIT", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY", symbol: "IBIT", quantity: 200, unitPrice: 35.59 }, { role: "option", action: "SELL", symbol: "IBIT", quantity: 16, unitPrice: 0.15, strike: 36, expiry: "20261123", right: "C" }] };
  const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_covered_call", payload: JSON.stringify(payload), status: "filled", pluto_action_id: actionId, updated_at: new Date("2026-11-23T15:01:05Z") }).returning("id");
  await testDb("pluto_actions").where({ id: actionId }).update({ order_request_id: order.id });
  const [position] = await testDb("positions").insert({ ticker_id: tickerId, strategy_key: "covered_call", status: "open" }).returning("id");
  const [stockLeg] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 1_600, multiplier: 1, entry_price: 40.47, entry_at: new Date("2026-11-23T15:01:15Z") }).returning("id");
  const [callLeg] = await testDb("position_legs").insert({ id: randomUUID(), position_id: position.id, leg_type: "option", side: "short", quantity: 16, option_type: "call", strike_price: 36, expiry_date: "2026-11-23", multiplier: 100, entry_price: 0.1339, entry_at: new Date("2026-11-23T15:01:14Z") }).returning("id");
  const fill = (legId: string, side: string, quantity: number, price: number, commission: number) => ({ position_leg_id: legId, ibkr_exec_id: randomUUID(), side, quantity, price, commission, executed_at: new Date("2026-11-23T15:01:05Z"), source_order_request_id: order.id });
  await testDb("trades").insert([
    fill(stockLeg.id, "buy", 25, 35.56, 0.0001),
    fill(stockLeg.id, "buy", 50, 35.56, 0.0002),
    fill(stockLeg.id, "buy", 75, 35.57, 0.0002),
    fill(stockLeg.id, "buy", 50, 35.57, 1.0902),
    fill(callLeg.id, "sell", 10, 0.14, 10.4962),
    fill(callLeg.id, "sell", 6, 0.15, 2.2582),
  ]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("takeInOneOffShares", () => {
  it("does nothing while an order of the ticker is still to settle, or for a ticker not listed", async () => {
    const pending = { ...memoryOf1600(), pending: [{ ref: "action:x", actionId: "x", kind: "covered_call" as const, expiry: "2026-11-24", strike: 36, contracts: 16, startsCycle: false, contractsByPosition: { first: 16, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null }] };
    expect(await takeInOneOffShares({ tickerId, symbol: "IBIT", memory: pending, passId: "p1" })).toBeNull();
    expect(await takeInOneOffShares({ tickerId, symbol: "SLV", memory: memoryOf1600(), passId: "p1" })).toBeNull();
    expect(await testDb("pluto_events").where({ type: "holdings_adopted" })).toEqual([]);
  });

  it("takes the order's 200 shares into the first position at their cost with commission, saves the memory and marks it done", async () => {
    const memory = memoryOf1600();
    expect(await takeInOneOffShares({ tickerId, symbol: "IBIT", memory, passId: "p1" })).toBe(`200 shares its Call order of ${actionId.slice(0, 8)} bought were taken into the first position (1800 shares now)`);
    // 75 × 35.56 + 125 × 35.57 = 7,113.25, plus 1.0907 commission.
    const cost = 7_113.25 + 1.0907;
    const saved = await loadVolFarmerV4Memory(tickerId);
    expect(saved!.state.first!.shares).toBe(1_800);
    expect(saved!.state.first!.costPerShare).toBeCloseTo((1_600 * 41.08545325 + cost) / 1_800, 8);
    expect(saved!.state.first!.calls).toEqual([{ legId: "call-leg", shares: 1_600 }]);
    const [event] = await testDb("pluto_events").where({ type: "holdings_adopted" });
    expect(event.payload).toMatchObject({ symbol: "IBIT", strategy: "vol_farmer_v4", shares: 1_800, callContracts: 16, putContracts: 0, sharesTakenIn: 200, sharesTakenInFromActionId: actionId });
    expect(event.payload.breakEvenPerShare).toBeCloseTo(volFarmerV4BreakEven(saved!.state.first!)!, 8);
  });

  it("never takes them in twice", async () => {
    expect(await takeInOneOffShares({ tickerId, symbol: "IBIT", memory: (await loadVolFarmerV4Memory(tickerId))!, passId: "p2" })).toBeNull();
    expect((await loadVolFarmerV4Memory(tickerId))!.state.first!.shares).toBe(1_800);
    expect(await testDb("pluto_events").where({ type: "holdings_adopted" })).toHaveLength(1);
  });
});
