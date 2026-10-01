import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { OptionType, SecType } from "@stoqey/ib";
import type { IbkrHeldPosition } from "./ibkrGatewayFetchHeldPositions.js";

// Runs the real reconciliation pass against the test database (same convention as
// src/db/schema.test.ts): every module that touches `db` is pointed at TEST_DATABASE_URL
// for this file only, so the pass writes and reads genuine positions/position_legs rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run reconciliation tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { reconcileHeldPositions, closeReasonStockRolledIntoCoveredCall } = await import("./ibkrGatewayReconcilePositions.js");

const testDb: Knex = db;
const telegramMessages: string[] = [];
const dependencies = {
  notifyTelegram: async (message: string) => {
    telegramMessages.push(message);
  },
  drainPendingOpeningExecutions: async () => {},
};

const createdTickerIds: string[] = [];
let nextConId = 900_000_000 + (Date.now() % 1_000_000);
let passCounter = 0;

function isoDateDaysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `RC${(nextConId += 1) % 100_000}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Reconcile Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

function heldStock(symbol: string, conId: number, quantity: number, avgCost: number): IbkrHeldPosition {
  return { contract: { conId, symbol, secType: SecType.STK, multiplier: "" as unknown as number, strike: 0, lastTradeDateOrContractMonth: "" }, quantity, avgCost };
}

function heldShortOption(symbol: string, conId: number, right: OptionType, strike: number, expiryIsoDate: string, avgCostPerContract: number, contracts = 1): IbkrHeldPosition {
  return {
    contract: { conId, symbol, secType: SecType.OPT, right, strike, lastTradeDateOrContractMonth: expiryIsoDate.replaceAll("-", ""), multiplier: 100 },
    quantity: -contracts,
    avgCost: avgCostPerContract,
  };
}

async function insertPosition(tickerId: string, strategyKey: string, unstructuredReason: string | null = null): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "open", unstructured_reason: unstructuredReason }).returning(["id"]);
  return position.id;
}

async function insertStockLeg(positionId: string, conId: number, quantity: number, entryPrice: number): Promise<string> {
  const [leg] = await testDb("position_legs")
    .insert({ position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, ibkr_contract_id: String(conId), entry_price: entryPrice, entry_at: new Date(Date.now() - 86_400_000) })
    .returning(["id"]);
  return leg.id;
}

async function insertShortOptionLeg(positionId: string, conId: number, optionType: "call" | "put", strike: number, expiryIsoDate: string, entryPrice: number): Promise<string> {
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: positionId,
      leg_type: "option",
      side: "short",
      quantity: 1,
      option_type: optionType,
      strike_price: strike,
      expiry_date: expiryIsoDate,
      multiplier: 100,
      ibkr_contract_id: String(conId),
      entry_price: entryPrice,
      entry_at: new Date(Date.now() - 86_400_000),
    })
    .returning(["id"]);
  return leg.id;
}

async function insertClosingTrade(legId: string, price: number, executedAt: Date): Promise<void> {
  await testDb("trades").insert({
    position_leg_id: legId,
    ibkr_exec_id: `reconcile-test-${legId}-${executedAt.getTime()}`,
    side: "buy",
    quantity: 1,
    price,
    executed_at: executedAt,
    is_closing_trade: true,
  });
}

async function insertClosingFill(legId: string, quantity: number, price: number, secondsFromBase: number, side: "buy" | "sell" = "sell"): Promise<void> {
  const executedAt = new Date(Date.UTC(2026, 8, 28, 14, 0, secondsFromBase));
  await testDb("trades").insert({
    position_leg_id: legId,
    ibkr_exec_id: `reconcile-test-fill-${legId}-${secondsFromBase}`,
    side,
    quantity,
    price,
    executed_at: executedAt,
    is_closing_trade: true,
  });
}

async function closedAndOpenQuantities(positionId: string): Promise<{ closed: number[]; open: number[] }> {
  const legs = await testDb("position_legs").where({ position_id: positionId }).orderBy("exit_at", "asc");
  return {
    closed: legs.filter((leg) => leg.exit_at !== null).map((leg) => leg.quantity),
    open: legs.filter((leg) => leg.exit_at === null).map((leg) => leg.quantity),
  };
}

function realizedStockPnl(legs: { quantity: number; entry_price: string; exit_price: string | null }[]): number {
  return legs.filter((leg) => leg.exit_price !== null).reduce((sum, leg) => sum + (Number(leg.exit_price) - Number(leg.entry_price)) * leg.quantity, 0);
}

async function runPass(held: IbkrHeldPosition[]): Promise<void> {
  passCounter += 1;
  await reconcileHeldPositions(held, passCounter, dependencies);
}

async function positionsFor(tickerId: string) {
  return testDb("positions").where({ ticker_id: tickerId }).orderBy("opened_at", "asc");
}

async function legsFor(positionId: string) {
  return testDb("position_legs").where({ position_id: positionId }).orderBy("entry_at", "asc");
}

async function anomaliesFor(positionId: string) {
  return testDb("platform_anomalies").where({ position_id: positionId });
}

beforeAll(async () => {
  process.env.EXPIRY_SETTLEMENT_MODE ??= "dry_run";
});

afterAll(async () => {
  if (createdTickerIds.length > 0) {
    const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
    await testDb("platform_anomalies").whereIn("position_id", positionIds).del();
    await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).del();
    await testDb("position_legs").whereIn("position_id", positionIds).del();
    await testDb("positions").whereIn("id", positionIds).del();
    await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
    await testDb("tickers").whereIn("id", createdTickerIds).del();
  }
  await testDb.destroy();
});

describe("reconcileHeldPositions — every structure change is its own position", () => {
  it("cash-secured put assigned: the put closes as assigned and the shares open a leftover-stock position", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const stockConId = (nextConId += 1);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 81, isoDateDaysFromToday(-1), 0.0887);
    telegramMessages.length = 0;

    await runPass([heldStock(ticker.symbol, stockConId, 100, 80.9113)]);

    const [csp, leftover] = await positionsFor(ticker.id);
    expect(csp.id).toBe(cspId);
    expect(csp.status).toBe("closed");
    expect(csp.close_reason).toBe("assigned");
    const [putLeg] = await legsFor(cspId);
    expect(Number(putLeg.exit_price)).toBe(0);

    expect(leftover.strategy_key).toBe("unstructured");
    expect(leftover.unstructured_reason).toBe("csp_assigned_stock");
    expect(leftover.status).toBe("open");
    const [stockLeg] = await legsFor(leftover.id);
    expect(stockLeg.leg_type).toBe("stock");
    expect(Number(stockLeg.quantity)).toBe(100);
    expect(Number(stockLeg.entry_price)).toBeCloseTo(80.9113, 4);
    expect(telegramMessages.some((message) => message.toLowerCase().includes("assigned"))).toBe(true);
  });

  it("leftover stock gets a call sold against it: a new covered call takes the shares at their carried cost, the leftover position closes as rolled", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const leftoverId = await insertPosition(ticker.id, "unstructured", "csp_assigned_stock");
    const leftoverStockLegId = await insertStockLeg(leftoverId, stockConId, 100, 80.9113);

    const held = [heldStock(ticker.symbol, stockConId, 100, 81.02), heldShortOption(ticker.symbol, callConId, OptionType.Call, 85, isoDateDaysFromToday(20), 150)];
    await runPass(held);

    const positions = await positionsFor(ticker.id);
    expect(positions).toHaveLength(2);
    const leftover = positions.find((position) => position.id === leftoverId)!;
    const coveredCall = positions.find((position) => position.id !== leftoverId)!;
    expect(leftover.status).toBe("closed");
    expect(leftover.close_reason).toBe(closeReasonStockRolledIntoCoveredCall);
    const [handedOffLeg] = await legsFor(leftoverId);
    expect(handedOffLeg.id).toBe(leftoverStockLegId);
    expect(handedOffLeg.exit_at).not.toBeNull();
    expect(Number(handedOffLeg.exit_price)).toBeCloseTo(Number(handedOffLeg.entry_price), 4);

    expect(coveredCall.strategy_key).toBe("covered_call");
    expect(coveredCall.status).toBe("open");
    const coveredCallLegs = await legsFor(coveredCall.id);
    const stockLeg = coveredCallLegs.find((leg) => leg.leg_type === "stock")!;
    const callLeg = coveredCallLegs.find((leg) => leg.leg_type === "option")!;
    expect(Number(stockLeg.quantity)).toBe(100);
    expect(Number(stockLeg.entry_price)).toBeCloseTo(80.9113, 4);
    expect(stockLeg.exit_at).toBeNull();
    expect(callLeg.option_type).toBe("call");
    expect(Number(callLeg.entry_price)).toBeCloseTo(1.5, 4);
    expect(await anomaliesFor(leftoverId)).toHaveLength(0);

    // Same holdings again: nothing changes.
    await runPass(held);
    expect(await positionsFor(ticker.id)).toHaveLength(2);
    expect(await legsFor(coveredCall.id)).toHaveLength(2);
    expect((await legsFor(coveredCall.id)).filter((leg) => leg.exit_at === null)).toHaveLength(2);
  });

  it("a multi-contract call filling one lot at a time: the leftover shares stay one position instead of being closed and recreated every pass", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const expiry = isoDateDaysFromToday(20);
    const holdings = (contractsFilled: number) => [
      heldStock(ticker.symbol, stockConId, 300, 101),
      heldShortOption(ticker.symbol, callConId, OptionType.Call, 103, expiry, 150, contractsFilled),
    ];
    const openLegs = async (positionId: string) => (await legsFor(positionId)).filter((leg) => leg.exit_at === null);

    await runPass(holdings(1));
    const afterFirstFill = await positionsFor(ticker.id);
    expect(afterFirstFill.map((position) => position.strategy_key).sort()).toEqual(["covered_call", "unstructured"]);
    const leftoverId = afterFirstFill.find((position) => position.strategy_key === "unstructured")!.id;
    const coveredCallId = afterFirstFill.find((position) => position.strategy_key === "covered_call")!.id;

    // Same holdings on later passes (the 60s loop while the order is still partly filled): no new positions.
    await runPass(holdings(1));
    await runPass(holdings(1));
    expect(await positionsFor(ticker.id)).toHaveLength(2);
    expect((await openLegs(leftoverId)).map((leg) => Number(leg.quantity))).toEqual([200]);

    await runPass(holdings(2));
    await runPass(holdings(2));
    expect(await positionsFor(ticker.id)).toHaveLength(2);
    expect((await openLegs(leftoverId)).map((leg) => Number(leg.quantity))).toEqual([100]);
    expect(Number((await legsFor(coveredCallId)).find((leg) => leg.leg_type === "stock")!.quantity)).toBe(200);

    await runPass(holdings(3));
    const finalPositions = await positionsFor(ticker.id);
    expect(finalPositions).toHaveLength(2);
    expect(finalPositions.find((position) => position.id === leftoverId)!.status).toBe("closed");
    expect(finalPositions.find((position) => position.id === coveredCallId)!.status).toBe("open");
    const finalStockLeg = (await openLegs(coveredCallId)).find((leg) => leg.leg_type === "stock")!;
    expect(Number(finalStockLeg.quantity)).toBe(300);
  });

  it("covered call expires with the shares retained: the covered call closes as expired and hands its shares to a leftover-stock position", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 107.66);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 114, isoDateDaysFromToday(-1), 2.9956);
    telegramMessages.length = 0;

    await runPass([heldStock(ticker.symbol, stockConId, 100, 107.66)]);

    const positions = await positionsFor(ticker.id);
    expect(positions).toHaveLength(2);
    const coveredCall = positions.find((position) => position.id === coveredCallId)!;
    const leftover = positions.find((position) => position.id !== coveredCallId)!;
    expect(coveredCall.status).toBe("closed");
    expect(coveredCall.close_reason).toBe("expired_worthless");
    const coveredCallLegs = await legsFor(coveredCallId);
    const oldStockLeg = coveredCallLegs.find((leg) => leg.leg_type === "stock")!;
    const oldCallLeg = coveredCallLegs.find((leg) => leg.leg_type === "option")!;
    expect(Number(oldCallLeg.exit_price)).toBe(0);
    expect(Number(oldStockLeg.exit_price)).toBeCloseTo(107.66, 4);

    expect(leftover.strategy_key).toBe("unstructured");
    expect(leftover.unstructured_reason).toBe("cc_expired_leftover_stock");
    const [newStockLeg] = await legsFor(leftover.id);
    expect(Number(newStockLeg.entry_price)).toBeCloseTo(107.66, 4);
    expect(newStockLeg.exit_at).toBeNull();
    expect(telegramMessages).toHaveLength(1);
    expect(telegramMessages[0]!.toLowerCase()).not.toContain("assigned");
  });

  it("covered call genuinely assigned at expiry: the notification reflects the correction instead of the same-pass default", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 100);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 105, isoDateDaysFromToday(-2), 2);
    await testDb("daily_price_bars").insert({ ticker_id: ticker.id, trading_date: isoDateDaysFromToday(-2), close_price: 110 });
    telegramMessages.length = 0;

    const previousMode = process.env.EXPIRY_SETTLEMENT_MODE;
    process.env.EXPIRY_SETTLEMENT_MODE = "apply";
    try {
      // IBKR no longer holds either leg — the shares were actually called away, not merely retained.
      await runPass([]);
    } finally {
      process.env.EXPIRY_SETTLEMENT_MODE = previousMode;
    }

    const [coveredCall] = await positionsFor(ticker.id);
    expect(coveredCall.status).toBe("closed");
    expect(coveredCall.close_reason).toBe("assigned");
    const stockLeg = (await legsFor(coveredCallId)).find((leg) => leg.leg_type === "stock")!;
    expect(Number(stockLeg.exit_price)).toBeCloseTo(105, 4);

    // Two messages this pass: the aggregate audit summary, and the per-position expiry notification.
    const expiryMessage = telegramMessages.find((message) => message.includes(ticker.symbol));
    expect(expiryMessage).toBeDefined();
    expect(expiryMessage!.toLowerCase()).toContain("assigned");
    expect(expiryMessage!.toLowerCase()).not.toContain("no assignment");
  });

  it("a call that vanishes before expiry with no trade (IBKR report gap) does not restructure anything", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 50);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 55, isoDateDaysFromToday(20), 1.2);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50)]);

    const positions = await positionsFor(ticker.id);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.status).toBe("open");
    expect(positions[0]!.strategy_key).toBe("covered_call");
    const legs = await legsFor(coveredCallId);
    const stockLeg = legs.find((leg) => leg.leg_type === "stock")!;
    const callLeg = legs.find((leg) => leg.leg_type === "option")!;
    expect(stockLeg.exit_at).toBeNull();
    expect(callLeg.exit_at).not.toBeNull();
    expect(callLeg.exit_price).toBeNull();
  });

  it("a call bought back moments ago with no new call reported yet is a roll in progress: shares stay put", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 50);
    const callLegId = await insertShortOptionLeg(coveredCallId, callConId, "call", 55, isoDateDaysFromToday(20), 1.2);
    await insertClosingTrade(callLegId, 0.4, new Date());

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50)]);

    const positions = await positionsFor(ticker.id);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.status).toBe("open");
    const stockLeg = (await legsFor(coveredCallId)).find((leg) => leg.leg_type === "stock")!;
    expect(stockLeg.exit_at).toBeNull();
  });

  it("covered call rolled to a new strike: the old position closes with its stock handed off, the new one owns the shares at the carried cost", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const oldCallConId = (nextConId += 1);
    const newCallConId = (nextConId += 1);
    const oldCoveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(oldCoveredCallId, stockConId, 100, 50);
    const oldCallLegId = await insertShortOptionLeg(oldCoveredCallId, oldCallConId, "call", 55, isoDateDaysFromToday(3), 1.2);
    await insertClosingTrade(oldCallLegId, 0.4, new Date(Date.now() - 20 * 60_000));

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50.3), heldShortOption(ticker.symbol, newCallConId, OptionType.Call, 60, isoDateDaysFromToday(30), 110)]);

    const positions = await positionsFor(ticker.id);
    expect(positions).toHaveLength(2);
    const oldCoveredCall = positions.find((position) => position.id === oldCoveredCallId)!;
    const newCoveredCall = positions.find((position) => position.id !== oldCoveredCallId)!;
    expect(oldCoveredCall.status).toBe("closed");
    expect(oldCoveredCall.close_reason).toBe("closed_via_external_trade");
    const oldLegs = await legsFor(oldCoveredCallId);
    expect(Number(oldLegs.find((leg) => leg.leg_type === "option")!.exit_price)).toBeCloseTo(0.4, 4);
    const oldStockLeg = oldLegs.find((leg) => leg.leg_type === "stock")!;
    expect(Number(oldStockLeg.exit_price)).toBeCloseTo(50, 4);

    expect(newCoveredCall.strategy_key).toBe("covered_call");
    const newLegs = await legsFor(newCoveredCall.id);
    expect(newLegs.filter((leg) => leg.exit_at === null)).toHaveLength(2);
    expect(Number(newLegs.find((leg) => leg.leg_type === "stock")!.entry_price)).toBeCloseTo(50, 4);
    expect(Number(newLegs.find((leg) => leg.leg_type === "option")!.strike_price)).toBe(60);
  });

  it("never rewrites a position's strategy_key in place", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 30);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 35, isoDateDaysFromToday(-2), 0.8);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 30)]);
    await runPass([heldStock(ticker.symbol, stockConId, 100, 30)]);

    const positions = await positionsFor(ticker.id);
    expect(positions.map((position) => position.strategy_key).sort()).toEqual(["covered_call", "unstructured"]);
    expect(positions.find((position) => position.id === coveredCallId)!.strategy_key).toBe("covered_call");
    expect(positions.filter((position) => position.status === "open")).toHaveLength(1);
  });
});

describe("reconcileHeldPositions — shares sold in several fills keep their quantity in realized P&L", () => {
  it("COHR: 200 shares sold as 80 / 80 / 40 become three closed legs whose quantities add back to 200", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 318.8219);

    await insertClosingFill(legId, 80, 279.8, 0);
    await runPass([heldStock(ticker.symbol, stockConId, 120, 318.8219)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [80], open: [120] });

    await insertClosingFill(legId, 80, 279.95, 5);
    await runPass([heldStock(ticker.symbol, stockConId, 40, 318.8219)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [80, 80], open: [40] });

    await insertClosingFill(legId, 40, 279.82, 15);
    await runPass([]);
    const legs = await legsFor(positionId);
    expect(legs.map((leg) => leg.quantity).sort((a, b) => a - b)).toEqual([40, 80, 80]);
    expect(legs.every((leg) => leg.exit_at !== null)).toBe(true);
    expect(legs.every((leg) => Number(leg.entry_price) === 318.8219)).toBe(true);
    expect(realizedStockPnl(legs)).toBeCloseTo(80 * (279.8 - 318.8219) + 80 * (279.95 - 318.8219) + 40 * (279.82 - 318.8219), 2);
    // Each closing trade now belongs to the leg it closed, so per-leg commissions follow their own shares.
    const tradeCountsPerLeg = await Promise.all(legs.map((leg) => testDb("trades").where({ position_leg_id: leg.id, is_closing_trade: true }).count({ total: "id" }).first()));
    expect(tradeCountsPerLeg.map((row) => Number(row!.total))).toEqual([1, 1, 1]);
  });

  it("HOOD: 200 shares sold as 100 + 100 across two passes close as 100 + 100", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 118.5974);

    await insertClosingFill(legId, 100, 118.75, 0);
    await runPass([heldStock(ticker.symbol, stockConId, 100, 118.5974)]);
    await insertClosingFill(legId, 100, 118.75, 3);
    await runPass([]);

    const legs = await legsFor(positionId);
    expect(legs.map((leg) => leg.quantity)).toEqual([100, 100]);
    expect(realizedStockPnl(legs)).toBeCloseTo(200 * (118.75 - 118.5974), 2);
  });

  it("all fills landing between two passes: one leg keeps the full quantity and exits at the fills' weighted average", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 318.8219);

    await insertClosingFill(legId, 80, 279.8, 0);
    await insertClosingFill(legId, 80, 279.95, 5);
    await insertClosingFill(legId, 40, 279.82, 15);
    await runPass([]);

    const legs = await legsFor(positionId);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.quantity).toBe(200);
    expect(Number(legs[0]!.exit_price)).toBe(279.864);
  });

  it("a closing fill the held report does not confirm yet is not attributed to any shares", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 118.5974);

    await insertClosingFill(legId, 100, 118.75, 0);
    await runPass([heldStock(ticker.symbol, stockConId, 200, 118.5974)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [], open: [200] });

    await runPass([heldStock(ticker.symbol, stockConId, 100, 118.5974)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [100], open: [100] });
  });

  it("a drop in the held quantity with no closing fill is only synced, never carved", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    await insertStockLeg(positionId, stockConId, 200, 118.5974);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 118.5974)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [], open: [100] });
  });

  it("the same pass run again carves nothing twice", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 118.5974);

    await insertClosingFill(legId, 100, 118.75, 0);
    await runPass([heldStock(ticker.symbol, stockConId, 100, 118.5974)]);
    await runPass([heldStock(ticker.symbol, stockConId, 100, 118.5974)]);
    expect(await closedAndOpenQuantities(positionId)).toEqual({ closed: [100], open: [100] });
  });

  it("a short put bought back 2 contracts at a time out of 5: the closed contracts carry their own quantity and exit price", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "cash_secured_put");
    const legId = await insertShortOptionLeg(positionId, putConId, "put", 100, isoDateDaysFromToday(7), 2.0);
    await testDb("position_legs").where({ id: legId }).update({ quantity: 5 });

    await insertClosingFill(legId, 2, 0.8, 0, "buy");
    await runPass([heldShortOption(ticker.symbol, putConId, OptionType.Put, 100, isoDateDaysFromToday(7), 200, 3)]);

    const legs = await testDb("position_legs").where({ position_id: positionId }).orderBy("exit_at", "asc");
    expect(legs.map((leg) => [leg.quantity, leg.exit_at !== null, leg.exit_price === null ? null : Number(leg.exit_price)])).toEqual([
      [2, true, 0.8],
      [3, false, null],
    ]);
  });
});
