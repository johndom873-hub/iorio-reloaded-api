import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { newVolFarmerV2SymbolState } from "../backtest/engine/volFarmerV2Steps.js";

// Vol Farmer v2's live reads against a private copy of the test tables: its memory, how the orders it sent ended (still
// working, filled in part, never built) and the status of the legs its memory refers to (a Call assigned at its expiry,
// one expired worthless, one bought back), and IBKR's IV for the Step.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadVolFarmerV2LegStatuses, loadVolFarmerV2Memory, loadVolFarmerV2OrderOutcomes, loadVolFarmerV2StepImpliedVolatility, saveVolFarmerV2Memory } = await import("./volFarmerV2LookLoader.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const userId = randomUUID();

async function action(): Promise<string> {
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}", model_called: false }).returning("id");
  const [row] = await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "open_covered_call", symbol: "VFL", outcome: "confirmed", execution_strategy: "vol_farmer_v2" }).returning("id");
  return row.id as string;
}

async function orderFor(actionId: string, status: string, payload: Record<string, unknown>): Promise<string> {
  const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_covered_call", payload: JSON.stringify(payload), status, pluto_action_id: actionId, updated_at: new Date("2026-10-20T15:00:00Z") }).returning("id");
  await testDb("pluto_actions").where({ id: actionId }).update({ order_request_id: order.id });
  return order.id as string;
}

async function leg(positionId: string, fields: Record<string, unknown>): Promise<string> {
  const [row] = await testDb("position_legs").insert({ position_id: positionId, leg_type: "option", side: "short", quantity: 2, option_type: "call", strike_price: 55, expiry_date: "2026-10-16", multiplier: 100, entry_price: 1.2, entry_at: new Date("2026-10-12T14:00:00Z"), ...fields }).returning("id");
  return row.id as string;
}

const coveredCallPayload = { symbol: "VFL", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY", symbol: "VFL", quantity: 300, unitPrice: 50 }, { role: "option", action: "SELL", symbol: "VFL", quantity: 3, unitPrice: 1.1, strike: 55, expiry: "20261120", right: "C" }] };

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "vf2-loader", display_name: "VF2 Loader", password_hash: "x" });
  await testDb("tickers").insert({ id: tickerId, symbol: "VFL", company_name: "Vol Farmer Loader Co" });
  await testDb("daily_price_bars").insert([
    { ticker_id: tickerId, trading_date: "2026-10-15", close_price: 54, implied_volatility: 0.42 },
    { ticker_id: tickerId, trading_date: "2026-10-16", close_price: 57, implied_volatility: null },
  ]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("Vol Farmer v2's live reads", () => {
  it("saves and reads back a ticker's memory, without the backtest's cash check", async () => {
    expect(await loadVolFarmerV2Memory(tickerId)).toBeNull();
    const state = newVolFarmerV2SymbolState();
    state.first = { shares: 300, costPerShare: 50.01, premiums: [{ legId: "action:a1", dollars: 328, shares: 300 }], calls: [{ legId: "action:a1", shares: 300 }], puts: [] };
    state.cash.cycles = 4;
    await saveVolFarmerV2Memory(tickerId, { state, pending: [] }, true);
    const memory = await loadVolFarmerV2Memory(tickerId);
    expect(memory!.state.first).toEqual(state.first);
    expect(memory!.state.cash.cycles).toBe(0);
    expect((await testDb("pluto_vol_farmer_v2_cycles").where({ ticker_id: tickerId }).first("adopted_at")).adopted_at).not.toBeNull();

    // A memory saved with a premium total (before 2026-10-28) reads as one premium counted in full.
    const savedWithTotal = { ...memory!, state: { ...memory!.state, first: { shares: 300, costPerShare: 50.01, premiumDollars: 328, calls: [], puts: [] } } };
    await testDb("pluto_vol_farmer_v2_cycles").where({ ticker_id: tickerId }).update({ memory: JSON.stringify(savedWithTotal) });
    expect((await loadVolFarmerV2Memory(tickerId))!.state.first).toEqual({ shares: 300, costPerShare: 50.01, premiums: [{ legId: "", dollars: 328, shares: 0 }], calls: [], puts: [] });
  });

  it("tells a working order from a done one, and reads a done order's fills: contracts, legs, premium and shares", async () => {
    const working = await action();
    await orderFor(working, "submitted", coveredCallPayload);
    const partial = await action();
    const partialOrder = await orderFor(partial, "cancelled_partially_filled", coveredCallPayload);
    const [position] = await testDb("positions").insert({ ticker_id: tickerId, strategy_key: "covered_call", status: "open" }).returning("id");
    const stockLeg = await leg(position.id, { leg_type: "stock", side: "long", quantity: 200, option_type: null, strike_price: null, expiry_date: null, multiplier: 1, entry_price: 50.02 });
    const callLeg = await leg(position.id, { expiry_date: "2026-11-20" });
    await testDb("trades").insert([
      { position_leg_id: stockLeg, side: "buy", quantity: 200, price: 50.02, commission: 1, source_order_request_id: partialOrder, executed_at: new Date() },
      { position_leg_id: callLeg, side: "sell", quantity: 2, price: 1.1, commission: 1.3, source_order_request_id: partialOrder, executed_at: new Date() },
    ]);
    const neverBuilt = await action();
    const outcomes = await loadVolFarmerV2OrderOutcomes([working, partial, neverBuilt]);
    expect(outcomes.get(working)).toMatchObject({ working: true });
    // 2 of 3 lots: 200 shares for 10,004 + 1 commission; the Calls brought 220 less 1.30.
    expect(outcomes.get(partial)).toEqual({ working: false, filledContracts: 2, optionLegIds: [callLeg], optionNetDollars: expect.closeTo(218.7, 6), sharesBought: 200, sharesCostDollars: expect.closeTo(10_005, 6) });
    expect(outcomes.get(neverBuilt)).toMatchObject({ working: false, filledContracts: 0, optionLegIds: [] });
  });

  it("reads each leg's status: open, assigned in the money at its expiry's close, expired worthless, bought back", async () => {
    const [position] = await testDb("positions").insert({ ticker_id: tickerId, strategy_key: "covered_call", status: "closed" }).returning("id");
    const settled = { exit_price: 0, exit_at: new Date("2026-10-16T20:00:00Z") };
    // The 16 Oct close was 57: the $55 Call is in the money (assigned), the $60 one is not (worthless).
    const assigned = await leg(position.id, { ...settled, strike_price: 55 });
    const worthless = await leg(position.id, { ...settled, strike_price: 60 });
    const boughtBack = await leg(position.id, { strike_price: 50, exit_price: 7.5, exit_at: new Date("2026-10-15T15:00:00Z") });
    await testDb("trades").insert({ position_leg_id: boughtBack, side: "buy", quantity: 2, price: 7.5, commission: 1.3, is_closing_trade: true, executed_at: new Date("2026-10-15T15:00:00Z") });
    const open = await leg(position.id, { expiry_date: "2026-11-20" });
    const statuses = await loadVolFarmerV2LegStatuses([assigned, worthless, boughtBack, open]);
    expect(statuses.get(assigned)).toEqual({ closed: true, assigned: true, strike: 55, contracts: 2 });
    expect(statuses.get(worthless)).toEqual({ closed: true, assigned: false, strike: 60, contracts: 2 });
    expect(statuses.get(boughtBack)).toEqual({ closed: true, assigned: false, strike: 50, contracts: 2 });
    expect(statuses.get(open)).toEqual({ closed: false, assigned: false, strike: 55, contracts: 2 });
  });

  it("takes the Step's IV from the latest daily bar before today that has one", async () => {
    expect(await loadVolFarmerV2StepImpliedVolatility(tickerId, "2026-10-20")).toBe(0.42);
    expect(await loadVolFarmerV2StepImpliedVolatility(tickerId, "2026-10-15")).toBeNull();
  });
});
