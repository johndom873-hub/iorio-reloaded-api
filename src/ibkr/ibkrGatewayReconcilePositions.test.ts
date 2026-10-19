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
const { createExecutionRecorder } = await import("./ibkrGatewayOrderTracking.js");
const { isOptionPastExpiry, optionPastExpirySql } = await import("../lib/optionExpiryClock.js");
// Pluto's book is tested here too: a reconciliation pass closes every open leg it is not given, so the
// Pluto-book scenarios live beside the other tests that run passes.
const { loadPlutoBook } = await import("../pluto/book.js");

const testDb: Knex = db;
const telegramMessages: string[] = [];
// A test sets this false to simulate an undelivered message.
let telegramDelivers = true;
// A test sets this to simulate the worker saving a buffered opening fill onto a leg right after the leg is created.
let drainPendingOpeningExecutionsHook: ((conId: string, newLegId: string) => Promise<void>) | undefined;
const dependencies = {
  notifyTelegram: async (message: string) => {
    telegramMessages.push(message);
    return telegramDelivers;
  },
  drainPendingOpeningExecutions: async (conId: string, newLegId: string) => {
    await drainPendingOpeningExecutionsHook?.(conId, newLegId);
  },
};

const createdTickerIds: string[] = [];
let nextConId = 900_000_000 + (Date.now() % 1_000_000);
let passCounter = 0;
let plutoTestUserId: string | null = null;
let plutoTestPassId: string | null = null;

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

function heldLongOption(symbol: string, conId: number, right: OptionType, strike: number, expiryIsoDate: string, avgCostPerContract: number, contracts = 1): IbkrHeldPosition {
  return { ...heldShortOption(symbol, conId, right, strike, expiryIsoDate, avgCostPerContract, contracts), quantity: contracts };
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

async function insertClosingTrade(legId: string, price: number, executedAt: Date, sourceOrderRequestId: string | null = null): Promise<void> {
  await testDb("trades").insert({
    source_order_request_id: sourceOrderRequestId,
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

async function shareSourcesOf(positionId: string): Promise<string[]> {
  return (await testDb("position_share_sources").where({ position_id: positionId }).select("source_position_id")).map((row) => row.source_position_id);
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
    if (plutoTestUserId) await testDb("order_requests").where({ requested_by_user_id: plutoTestUserId }).del();
    if (plutoTestPassId) await testDb("pluto_passes").where({ id: plutoTestPassId }).del();
    await testDb("position_legs").whereIn("position_id", positionIds).del();
    await testDb("positions").whereIn("id", positionIds).del();
    await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
    await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
    await testDb("tickers").whereIn("id", createdTickerIds).del();
  }
  if (plutoTestUserId) await testDb("users").where({ id: plutoTestUserId }).del();
  await testDb.destroy();
});

/** The requester of this file's order rows (deleted in afterAll with them). */
async function plutoTestUser(): Promise<string> {
  if (!plutoTestUserId) {
    const [user] = await testDb("users").insert({ username: `reconcile-pluto-${Date.now()}`, display_name: "Pluto book test", password_hash: "x" }).returning(["id"]);
    plutoTestUserId = user.id;
  }
  return plutoTestUserId!;
}

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
    expect(await shareSourcesOf(leftover.id)).toEqual([cspId]);
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
    expect(await shareSourcesOf(coveredCall.id)).toEqual([leftoverId]);

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
    expect(await shareSourcesOf(leftover.id)).toEqual([coveredCallId]);
    expect(telegramMessages).toHaveLength(1);
    expect(telegramMessages[0]!.toLowerCase()).not.toContain("assigned");
    // The expiry message is the close notice: delivered, so the trading-events catch-all will not repeat it.
    expect(coveredCall.telegram_closed_notified_at).not.toBeNull();
  });

  it("an undelivered expiry message leaves the close for the trading-events catch-all to tell", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 107.66);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 114, isoDateDaysFromToday(-1), 2.9956);
    telegramMessages.length = 0;
    telegramDelivers = false;
    try {
      await runPass([heldStock(ticker.symbol, stockConId, 100, 107.66)]);
    } finally {
      telegramDelivers = true;
    }
    const coveredCall = (await positionsFor(ticker.id)).find((position) => position.id === coveredCallId)!;
    expect(coveredCall.close_reason).toBe("expired_worthless");
    expect(telegramMessages).toHaveLength(1);
    expect(coveredCall.telegram_closed_notified_at).toBeNull();
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

  it("a whole covered call closed by an app order (call bought back, shares sold) is an app close, not an assignment", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    const stockLegId = await insertStockLeg(coveredCallId, stockConId, 100, 50);
    const callLegId = await insertShortOptionLeg(coveredCallId, callConId, "call", 55, isoDateDaysFromToday(20), 1.2);
    const [closeOrder] = await testDb("order_requests")
      .insert({ requested_by_user_id: await plutoTestUser(), request_type: "close_position", payload: JSON.stringify({ symbol: ticker.symbol, legs: [] }), status: "filled", related_position_id: coveredCallId })
      .returning(["id"]);
    await insertClosingTrade(callLegId, 0.4, new Date(Date.now() - 60_000), closeOrder.id);
    await testDb("trades").insert({
      source_order_request_id: closeOrder.id,
      position_leg_id: stockLegId,
      ibkr_exec_id: `reconcile-test-stock-sale-${stockLegId}`,
      side: "sell",
      quantity: 100,
      price: 53,
      executed_at: new Date(Date.now() - 60_000),
      is_closing_trade: true,
    });

    await runPass([]);

    const [coveredCall] = await positionsFor(ticker.id);
    expect(coveredCall.status).toBe("closed");
    expect(coveredCall.close_reason).toBe("closed_via_app");
    const stockLeg = (await legsFor(coveredCallId)).find((leg) => leg.leg_type === "stock")!;
    expect(Number(stockLeg.exit_price)).toBeCloseTo(53, 4);
  });

  it("shares that left by a fill while the call left with no trade of its own is still an assignment", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    const stockLegId = await insertStockLeg(coveredCallId, stockConId, 100, 50);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 55, isoDateDaysFromToday(-2), 1.2);
    await insertClosingFill(stockLegId, 100, 55, 0);

    await runPass([]);

    const [coveredCall] = await positionsFor(ticker.id);
    expect(coveredCall.status).toBe("closed");
    expect(coveredCall.close_reason).toBe("assigned");
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
    expect(await shareSourcesOf(newCoveredCall.id)).toEqual([oldCoveredCallId]);
  });

  it("a roll placed in the app closes the old position as an app close even before the roll order reads filled", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const oldCallConId = (nextConId += 1);
    const newCallConId = (nextConId += 1);
    const oldCoveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(oldCoveredCallId, stockConId, 100, 50);
    const oldCallLegId = await insertShortOptionLeg(oldCoveredCallId, oldCallConId, "call", 55, isoDateDaysFromToday(3), 1.2);
    const [rollOrder] = await testDb("order_requests")
      .insert({ requested_by_user_id: await plutoTestUser(), request_type: "roll_leg", payload: JSON.stringify({ symbol: ticker.symbol, legs: [] }), status: "partially_filled", related_position_id: oldCoveredCallId })
      .returning(["id"]);
    await insertClosingTrade(oldCallLegId, 0.4, new Date(Date.now() - 20 * 60_000), rollOrder.id);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50), heldShortOption(ticker.symbol, newCallConId, OptionType.Call, 60, isoDateDaysFromToday(30), 110)]);

    const oldCoveredCall = (await positionsFor(ticker.id)).find((position) => position.id === oldCoveredCallId)!;
    expect(oldCoveredCall.status).toBe("closed");
    expect(oldCoveredCall.close_reason).toBe("closed_via_app");
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

describe("reconcileHeldPositions — long options are hedges", () => {
  it("a long call alone becomes one hedge position with a long leg at the per-share cost, not an unstructured position", async () => {
    const ticker = await createTicker();
    const callConId = (nextConId += 1);
    await runPass([heldLongOption(ticker.symbol, callConId, OptionType.Call, 82, isoDateDaysFromToday(600), 391.8, 110)]);
    await runPass([heldLongOption(ticker.symbol, callConId, OptionType.Call, 82, isoDateDaysFromToday(600), 391.8, 110)]);

    const positions = await positionsFor(ticker.id);
    expect(positions.map((position) => position.strategy_key)).toEqual(["hedge"]);
    expect(positions[0]!.unstructured_reason).toBeNull();
    const legs = await legsFor(positions[0]!.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ leg_type: "option", side: "long", quantity: 110, option_type: "call" });
    expect(Number(legs[0]!.entry_price)).toBeCloseTo(3.918, 4);
    expect(await anomaliesFor(positions[0]!.id)).toHaveLength(0);
  });

  it("shares plus a long call (a CSP was assigned): the shares stay a leftover-stock position and the call stays its own hedge", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const held = [heldStock(ticker.symbol, stockConId, 100, 80), heldLongOption(ticker.symbol, callConId, OptionType.Call, 82, isoDateDaysFromToday(600), 400)];
    await runPass(held);
    await runPass(held);

    const positions = await positionsFor(ticker.id);
    expect(positions.map((position) => position.strategy_key).sort()).toEqual(["hedge", "unstructured"]);
    const hedge = positions.find((position) => position.strategy_key === "hedge")!;
    const unstructured = positions.find((position) => position.strategy_key === "unstructured")!;
    expect((await legsFor(hedge.id)).map((leg) => leg.leg_type)).toEqual(["option"]);
    expect((await legsFor(unstructured.id)).map((leg) => leg.leg_type)).toEqual(["stock"]);
  });

  it("shares, a covered call and a long call: the covered call pairs with the shares and the long call keeps its own leg", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const shortCallConId = (nextConId += 1);
    const longCallConId = (nextConId += 1);
    const held = [
      heldStock(ticker.symbol, stockConId, 100, 80),
      heldShortOption(ticker.symbol, shortCallConId, OptionType.Call, 85, isoDateDaysFromToday(20), 50),
      heldLongOption(ticker.symbol, longCallConId, OptionType.Call, 82, isoDateDaysFromToday(600), 400),
    ];
    await runPass(held);
    await runPass(held);

    const positions = await positionsFor(ticker.id);
    expect(positions.map((position) => position.strategy_key).sort()).toEqual(["covered_call", "hedge"]);
    const openLegConIds = (await testDb("position_legs").whereIn("position_id", positions.map((position) => position.id)).whereNull("exit_at")).map((leg) => leg.ibkr_contract_id);
    expect(openLegConIds).toContain(String(longCallConId));
  });

  it("a long call alongside a short put: both stay their own position", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const held = [
      heldShortOption(ticker.symbol, putConId, OptionType.Put, 81, isoDateDaysFromToday(30), 80),
      heldLongOption(ticker.symbol, callConId, OptionType.Call, 82, isoDateDaysFromToday(600), 400),
    ];
    await runPass(held);
    await runPass(held);

    const positions = await positionsFor(ticker.id);
    expect(positions.map((position) => position.strategy_key).sort()).toEqual(["cash_secured_put", "hedge"]);
  });

  it("a hedge sold at IBKR closes with its exit price from the closing fill", async () => {
    const ticker = await createTicker();
    const callConId = (nextConId += 1);
    await runPass([heldLongOption(ticker.symbol, callConId, OptionType.Call, 82, isoDateDaysFromToday(600), 400)]);
    const [position] = await positionsFor(ticker.id);
    const [leg] = await legsFor(position!.id);
    await insertClosingFill(leg!.id, 1, 5.5, 1, "sell");
    await runPass([]);

    const closed = (await legsFor(position!.id))[0]!;
    expect(closed.exit_at).not.toBeNull();
    expect(Number(closed.exit_price)).toBeCloseTo(5.5, 4);
    expect((await positionsFor(ticker.id))[0]!.status).toBe("closed");
  });

  it("a naked short call is still flagged, and only that", async () => {
    const ticker = await createTicker();
    const callConId = (nextConId += 1);
    await runPass([heldShortOption(ticker.symbol, callConId, OptionType.Call, 85, isoDateDaysFromToday(20), 50)]);
    const [position] = await positionsFor(ticker.id);
    expect(position!.strategy_key).toBe("unstructured");
    const anomalies = await testDb("platform_anomalies").where({ anomaly_type: "naked_call_detected" }).where("detail", "like", `${ticker.symbol}:%`);
    expect(anomalies).toHaveLength(1);
    await testDb("platform_anomalies").where({ anomaly_type: "naked_call_detected" }).where("detail", "like", `${ticker.symbol}:%`).del();
  });
});

async function insertStockTrade(legId: string, side: "buy" | "sell", quantity: number, price: number, commission: number | null, executedAt: Date): Promise<void> {
  await testDb("trades").insert({
    position_leg_id: legId,
    ibkr_exec_id: `reconcile-test-ledger-${legId}-${side}-${quantity}-${executedAt.getTime()}`,
    side,
    quantity,
    price,
    commission,
    executed_at: executedAt,
    is_closing_trade: side === "sell",
  });
}

async function rowVersion(legId: string): Promise<string> {
  return (await testDb.raw("SELECT xmin::text AS version FROM position_legs WHERE id = ?", [legId])).rows[0].version;
}

/** A closed cash-secured-put position whose short put ended in the money with no closing trade (assigned). */
async function insertAssignedPutPosition(tickerId: string, strike: number, premiumPerShare: number, exitedAt: Date): Promise<void> {
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: tickerId, status: "closed", closed_at: exitedAt, close_reason: "assigned" }).returning(["id"]);
  const putLegId = await insertShortOptionLeg(position.id, (nextConId += 1), "put", strike, isoDateDaysFromToday(-3), premiumPerShare);
  await testDb("position_legs").where({ id: putLegId }).update({ exit_at: exitedAt, exit_price: 0 });
}

describe("reconcileHeldPositions — stock entry is the true cost when the trades ledger reproduces IBKR's holding", () => {
  it("assigned put with its fill saved: the new stock leg is at the strike on the first pass, and an unchanged leg is not rewritten on later passes", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const stockConId = (nextConId += 1);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 120, isoDateDaysFromToday(-1), 1.4026);
    drainPendingOpeningExecutionsHook = async (_conId, newLegId) => insertStockTrade(newLegId, "buy", 100, 120, null, new Date(Date.now() - 45_000));

    const held = [heldStock(ticker.symbol, stockConId, 100, 118.5974)];
    await runPass(held);
    drainPendingOpeningExecutionsHook = undefined;

    const leftover = (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!;
    const [stockLeg] = await legsFor(leftover.id);
    expect(Number(stockLeg!.entry_price)).toBe(120);

    const versionBefore = await rowVersion(stockLeg!.id);
    await runPass(held);
    expect(Number((await legsFor(leftover.id))[0]!.entry_price)).toBe(120);
    expect(await rowVersion(stockLeg!.id)).toBe(versionBefore);
  });

  it("no assignment fill recorded: IBKR's average cost is kept, rounded to eight decimals, and not rewritten every pass", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const stockConId = (nextConId += 1);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 120, isoDateDaysFromToday(-1), 1.4026);

    const held = [heldStock(ticker.symbol, stockConId, 100, 118.597391234)];
    await runPass(held);
    const leftover = (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!;
    const [stockLeg] = await legsFor(leftover.id);
    expect(Number(stockLeg!.entry_price)).toBe(118.59739123);

    const versionBefore = await rowVersion(stockLeg!.id);
    await runPass(held);
    expect(await rowVersion(stockLeg!.id)).toBe(versionBefore);
  });

  it("the fill is saved after the leg exists: the next pass corrects the entry", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const stockConId = (nextConId += 1);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 120, isoDateDaysFromToday(-1), 1.4026);

    const held = [heldStock(ticker.symbol, stockConId, 100, 118.5974)];
    await runPass(held);
    const leftover = (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!;
    const [stockLeg] = await legsFor(leftover.id);
    expect(Number(stockLeg!.entry_price)).toBe(118.5974);

    await insertStockTrade(stockLeg!.id, "buy", 100, 120, null, new Date(Date.now() - 30_000));
    await runPass(held);
    expect(Number((await legsFor(leftover.id))[0]!.entry_price)).toBe(120);
  });

  it("shares held before the assignment merge into IBKR's blended cost, and the true blended cost is stored (COHR)", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    await insertAssignedPutPosition(ticker.id, 317.5, 7.3471, new Date(Date.now() - 60_000));
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 318.8219);
    await insertStockTrade(legId, "buy", 100, 327.48, 1.0903, new Date(Date.now() - 86_400_000 * 5));
    await insertStockTrade(legId, "buy", 100, 317.5, null, new Date(Date.now() - 90_000));

    await runPass([heldStock(ticker.symbol, stockConId, 200, 318.8219)]);
    expect(Number((await legsFor(positionId))[0]!.entry_price)).toBeCloseTo(322.4955, 3);
  });
});

describe("reconcileHeldPositions — a partial sale of mixed lots is priced at the lot FIFO sold", () => {
  async function seedMixedLots(ticker: { id: string; symbol: string }, stockConId: number) {
    await insertAssignedPutPosition(ticker.id, 107, 2.3468, new Date("2026-09-26T01:45:30Z"));
    const positionId = await insertPosition(ticker.id, "unstructured", "leftover_stock");
    const legId = await insertStockLeg(positionId, stockConId, 200, 106.1571);
    await insertStockTrade(legId, "buy", 100, 107.65, 1.09, new Date("2026-09-20T15:10:46Z"));
    await insertStockTrade(legId, "buy", 100, 107, null, new Date("2026-09-26T01:44:46Z"));
    await insertClosingFill(legId, 100, 107.1, 0);
    return positionId;
  }

  it("100 of 200 shares sold when IBKR reports the remaining lot's own cost: the slice carries the older lot's cost, the remainder the true cost of the assigned lot", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await seedMixedLots(ticker, stockConId);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 104.6532)]);

    const legs = await legsFor(positionId);
    const slice = legs.find((leg) => leg.exit_at !== null)!;
    const remainder = legs.find((leg) => leg.exit_at === null)!;
    expect(Number(slice.entry_price)).toBeCloseTo(107.6609, 4);
    expect(Number(slice.exit_price)).toBeCloseTo(107.1, 4);
    expect(remainder.quantity).toBe(100);
    expect(Number(remainder.entry_price)).toBe(107);
  });

  it("IBKR keeps a flat average instead: the ledger is not verified, so the slice and remainder keep today's values", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const positionId = await seedMixedLots(ticker, stockConId);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 106.1571)]);

    const legs = await legsFor(positionId);
    expect(legs.map((leg) => Number(leg.entry_price))).toEqual([106.1571, 106.1571]);
  });
});

describe("reconcileHeldPositions — covered calls sharing one stock contract each keep their own cost", () => {
  // INTC 2026-10-15: 200 shares assigned at $100.00 under the $98 calls, then 100 bought at $92.43 + $1.0903 with the $94
  // call. IBKR holds 300 at one average, (20,000 + 9,243 + 1.0903) / 300 = 97.480301, which both stock legs used to show.
  async function seedIntcSiblings(fillOnThe94Leg: boolean) {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const the98CallConId = (nextConId += 1);
    const the94CallConId = (nextConId += 1);
    const the98Id = await insertPosition(ticker.id, "covered_call");
    const the98StockLegId = await insertStockLeg(the98Id, stockConId, 200, 97.480301);
    const the98CallLegId = await insertShortOptionLeg(the98Id, the98CallConId, "call", 98, isoDateDaysFromToday(1), 0.3553);
    await testDb("position_legs").where({ id: the98CallLegId }).update({ quantity: 2 });
    const the94Id = await insertPosition(ticker.id, "covered_call");
    const the94StockLegId = await insertStockLeg(the94Id, stockConId, 100, 97.480301);
    const the94CallLegId = await insertShortOptionLeg(the94Id, the94CallConId, "call", 94, isoDateDaysFromToday(1), 1.143);
    await insertStockTrade(fillOnThe94Leg ? the94StockLegId : the98StockLegId, "buy", 100, 92.43, 1.0903, new Date(Date.now() - 3_600_000));
    const held = [
      heldStock(ticker.symbol, stockConId, 300, 97.480301),
      heldShortOption(ticker.symbol, the98CallConId, OptionType.Call, 98, isoDateDaysFromToday(1), 35.53, 2),
      heldShortOption(ticker.symbol, the94CallConId, OptionType.Call, 94, isoDateDaysFromToday(1), 114.3),
    ];
    return { ticker, stockConId, the98CallConId, the94CallConId, the98Id, the98StockLegId, the98CallLegId, the94Id, the94StockLegId, the94CallLegId, held };
  }

  const stockLegOf = async (legId: string) => testDb("position_legs").where({ id: legId }).first();

  it("INTC: the $94 position's shares at their own fill, the $98 position's at what is left of IBKR's total, and a second pass rewrites nothing", async () => {
    const intc = await seedIntcSiblings(true);

    await runPass(intc.held);

    const the98Stock = await stockLegOf(intc.the98StockLegId);
    const the94Stock = await stockLegOf(intc.the94StockLegId);
    expect(Number(the98Stock.entry_price)).toBe(100);
    expect(Number(the94Stock.entry_price)).toBe(92.440903);
    expect([the98Stock.entry_price_from_position_split, the94Stock.entry_price_from_position_split]).toEqual([true, true]);
    expect([the98Stock.quantity, the94Stock.quantity]).toEqual([200, 100]);

    const versions = [await rowVersion(intc.the98StockLegId), await rowVersion(intc.the94StockLegId)];
    await runPass(intc.held);
    expect([await rowVersion(intc.the98StockLegId), await rowVersion(intc.the94StockLegId)]).toEqual(versions);
  });

  it("the buy still on the wrong position's leg: no leg has a cost of its own, both keep IBKR's average as before", async () => {
    const intc = await seedIntcSiblings(false);

    await runPass(intc.held);

    for (const legId of [intc.the98StockLegId, intc.the94StockLegId]) {
      const stockLeg = await stockLegOf(legId);
      expect(Number(stockLeg.entry_price)).toBe(97.480301);
      expect(stockLeg.entry_price_from_position_split).toBe(false);
    }
  });

  it("the $94 position closes (call bought back, shares sold): its shares exit at their sale fill, the $98 shares keep $100.00 though IBKR's average moved", async () => {
    const intc = await seedIntcSiblings(true);
    await runPass(intc.held);

    await insertClosingTrade(intc.the94CallLegId, 1.5, new Date(Date.now() - 60_000));
    await insertStockTrade(intc.the94StockLegId, "sell", 100, 93, 1, new Date(Date.now() - 60_000));
    // IBKR sold its oldest lot (the $100.00 shares): the 200 left average (100 x 100 + 100 x 92.440903) / 200.
    await runPass([heldStock(intc.ticker.symbol, intc.stockConId, 200, 96.2204515), intc.held[1]!]);

    const the94Stock = await stockLegOf(intc.the94StockLegId);
    expect(the94Stock.exit_at).not.toBeNull();
    expect(Number(the94Stock.entry_price)).toBe(92.440903);
    expect(Number(the94Stock.exit_price)).toBe(93);
    expect((await positionsFor(intc.ticker.id)).find((position) => position.id === intc.the94Id)!.status).toBe("closed");

    const the98Stock = await stockLegOf(intc.the98StockLegId);
    expect(the98Stock.exit_at).toBeNull();
    expect(the98Stock.quantity).toBe(200);
    expect(Number(the98Stock.entry_price)).toBe(100);
    expect(await shareSourcesOf(intc.the98Id)).toEqual([]);
  });

  it("the $94 call assigned at expiry: the recorder puts the $94 sale on the $94 position, which closes as assigned at $94; the $98 shares keep $100.00", async () => {
    const intc = await seedIntcSiblings(true);
    await runPass(intc.held);
    await testDb("position_legs").where({ id: intc.the94CallLegId }).update({ expiry_date: isoDateDaysFromToday(-1) });

    const recorder = createExecutionRecorder({ db: testDb, isAccountBindingMismatch: () => false, requestReconciliation: () => {} });
    const assignmentExecId = `reconcile-test-assignment-${intc.the94StockLegId}`;
    const ibkrNow = new Date().toISOString().replace(/\.\d{3}Z$/, "").replace(/-/g, "").replace("T", "-");
    await recorder.recordExecution({ conId: intc.stockConId, symbol: intc.ticker.symbol, secType: SecType.STK } as never, { execId: assignmentExecId, orderId: 0, side: "SLD", shares: 100, price: 94, time: ibkrNow } as never);
    expect((await testDb("trades").where({ ibkr_exec_id: assignmentExecId }).first()).position_leg_id).toBe(intc.the94StockLegId);

    // IBKR sold its oldest lot (the $100.00 shares): the 200 left average (100 x 100 + 100 x 92.440903) / 200.
    await runPass([heldStock(intc.ticker.symbol, intc.stockConId, 200, 96.2204515), intc.held[1]!]);

    const the94 = (await positionsFor(intc.ticker.id)).find((position) => position.id === intc.the94Id)!;
    expect(the94.status).toBe("closed");
    expect(the94.close_reason).toBe("assigned");
    const the94Stock = await stockLegOf(intc.the94StockLegId);
    expect(Number(the94Stock.entry_price)).toBe(92.440903);
    expect(Number(the94Stock.exit_price)).toBe(94);
    const the98Stock = await stockLegOf(intc.the98StockLegId);
    expect([the98Stock.exit_at, the98Stock.quantity, Number(the98Stock.entry_price)]).toEqual([null, 200, 100]);
  });

  it("the $98 position rolls while the $94 one stays open: its 200 shares move to the new call at $100.00, even when the $94 call is synced first", async () => {
    const intc = await seedIntcSiblings(true);
    await runPass(intc.held);

    await insertClosingTrade(intc.the98CallLegId, 0.2, new Date(Date.now() - 20 * 60_000));
    const newCallConId = (nextConId += 1);
    await runPass([intc.held[0]!, intc.held[2]!, heldShortOption(intc.ticker.symbol, newCallConId, OptionType.Call, 99, isoDateDaysFromToday(8), 80, 2)]);

    const positions = await positionsFor(intc.ticker.id);
    expect(positions.find((position) => position.id === intc.the98Id)!.status).toBe("closed");
    const rolled = positions.find((position) => position.id !== intc.the98Id && position.id !== intc.the94Id)!;
    const rolledStock = (await legsFor(rolled.id)).find((leg) => leg.leg_type === "stock")!;
    expect(rolledStock.quantity).toBe(200);
    expect(Number(rolledStock.entry_price)).toBe(100);
    expect(rolledStock.entry_price_from_position_split).toBe(true);
    expect(await shareSourcesOf(rolled.id)).toEqual([intc.the98Id]);
    expect((await testDb("position_share_sources").where({ position_id: rolled.id }).first()).shares_received).toBe(200);

    const the94Stock = await stockLegOf(intc.the94StockLegId);
    expect(the94Stock.exit_at).toBeNull();
    expect(the94Stock.quantity).toBe(100);
    expect(Number(the94Stock.entry_price)).toBe(92.440903);
    expect(await shareSourcesOf(intc.the94Id)).toEqual([]);
  });

  it("end to end with the worker's recorder: the buy-write's shares wait for their own call's position instead of joining the $98 position's leg", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const the98CallConId = (nextConId += 1);
    const the94CallConId = (nextConId += 1);
    const the98Id = await insertPosition(ticker.id, "covered_call");
    const the98StockLegId = await insertStockLeg(the98Id, stockConId, 200, 100);
    const the98CallLegId = await insertShortOptionLeg(the98Id, the98CallConId, "call", 98, isoDateDaysFromToday(1), 0.3553);
    await testDb("position_legs").where({ id: the98CallLegId }).update({ quantity: 2 });

    const permId = 1_000_000 + (nextConId % 1_000_000_000);
    await testDb("order_requests").insert({
      requested_by_user_id: await plutoTestUser(),
      request_type: "open_covered_call",
      payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "covered_call", legs: [] }),
      status: "filled",
      ibkr_perm_id: permId,
    });
    const recorder = createExecutionRecorder({ db: testDb, isAccountBindingMismatch: () => false, requestReconciliation: () => {} });
    const stockExecId = `reconcile-test-buy-write-stock-${permId}`;
    await recorder.recordExecution({ conId: stockConId, symbol: ticker.symbol, secType: SecType.STK } as never, { execId: stockExecId, orderId: 1, permId, side: "BOT", shares: 100, price: 92.43, time: "20261015 10:25:50 America/New_York" } as never);
    await recorder.recordCommission({ execId: stockExecId, commission: 1.0903 } as never);
    await recorder.recordExecution({ conId: the94CallConId, symbol: ticker.symbol, secType: SecType.OPT } as never, { execId: `reconcile-test-buy-write-call-${permId}`, orderId: 1, permId, side: "SLD", shares: 1, price: 1.15, time: "20261015 10:25:50 America/New_York" } as never);
    expect(await testDb("trades").where({ position_leg_id: the98StockLegId })).toHaveLength(0);

    drainPendingOpeningExecutionsHook = (conId, newLegId) => recorder.drainPendingOpeningExecutions(conId, newLegId);
    try {
      await runPass([
        heldStock(ticker.symbol, stockConId, 300, 97.480301),
        heldShortOption(ticker.symbol, the98CallConId, OptionType.Call, 98, isoDateDaysFromToday(1), 35.53, 2),
        heldShortOption(ticker.symbol, the94CallConId, OptionType.Call, 94, isoDateDaysFromToday(1), 114.3),
      ]);
    } finally {
      drainPendingOpeningExecutionsHook = undefined;
    }

    const the94 = (await positionsFor(ticker.id)).find((position) => position.id !== the98Id)!;
    const the94Legs = await legsFor(the94.id);
    const the94Stock = the94Legs.find((leg) => leg.leg_type === "stock")!;
    expect((await testDb("trades").where({ ibkr_exec_id: stockExecId }).first()).position_leg_id).toBe(the94Stock.id);
    expect(Number(the94Stock.entry_price)).toBe(92.440903);
    expect(Number((await testDb("position_legs").where({ id: the98StockLegId }).first()).entry_price)).toBe(100);
    expect(await testDb("trades").where({ position_leg_id: the98StockLegId })).toHaveLength(0);
  });
});

describe("reconcileHeldPositions — fixes from the 2026-10-16 P&L review", () => {
  it("a leftover-stock leg taking over a Covered Call's shares blends both costs (100 at $50.00 + 100 at $40.01 = $45.005)", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const leftoverId = await insertPosition(ticker.id, "unstructured", "csp_assigned_stock");
    const leftoverLegId = await insertStockLeg(leftoverId, stockConId, 100, 50);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    const coveredCallStockLegId = await insertStockLeg(coveredCallId, stockConId, 100, 40.01);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 45, isoDateDaysFromToday(-1), 0.5);
    await testDb("position_legs").whereIn("id", [leftoverLegId, coveredCallStockLegId]).update({ entry_price_from_position_split: true });

    await runPass([heldStock(ticker.symbol, stockConId, 200, 45.005)]);

    const leftoverLeg = await testDb("position_legs").where({ id: leftoverLegId }).first();
    expect([leftoverLeg.exit_at, leftoverLeg.quantity, Number(leftoverLeg.entry_price)]).toEqual([null, 200, 45.005]);
    expect((await testDb("position_share_sources").where({ position_id: leftoverId, source_position_id: coveredCallId }).first()).shares_received).toBe(100);
  });

  it("one of two puts bought back: the closed contract costs what IBKR's remaining average leaves (oldest first), the remainder IBKR's average", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const positionId = await insertPosition(ticker.id, "cash_secured_put");
    const legId = await insertShortOptionLeg(positionId, putConId, "put", 50, isoDateDaysFromToday(7), 1.4935);
    await testDb("position_legs").where({ id: legId }).update({ quantity: 2 });
    await insertClosingFill(legId, 1, 0.5, 0, "buy");

    // Sold at 1.00 then 2.00 (0.9935 and 1.9935 net); IBKR keeps the 1.9935 contract after selling the oldest.
    await runPass([heldShortOption(ticker.symbol, putConId, OptionType.Put, 50, isoDateDaysFromToday(7), 199.35, 1)]);

    const legs = await testDb("position_legs").where({ position_id: positionId }).orderBy("exit_at", "asc");
    expect(legs.map((leg) => [leg.quantity, Number(leg.entry_price), leg.exit_price === null ? null : Number(leg.exit_price)])).toEqual([
      [1, 0.9935, 0.5],
      [1, 1.9935, null],
    ]);
  });

  it("a call assigned early (expiry a week away) with its stock sale recorded: the call ends at 0 and the position closes as assigned", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    const stockLegId = await insertStockLeg(coveredCallId, stockConId, 100, 48.01);
    const callLegId = await insertShortOptionLeg(coveredCallId, callConId, "call", 50, isoDateDaysFromToday(7), 1.1935);
    await testDb("trades").insert({ position_leg_id: stockLegId, ibkr_exec_id: `reconcile-test-early-assignment-${stockLegId}`, side: "sell", quantity: 100, price: 50, executed_at: new Date(Date.now() - 600_000), is_closing_trade: true });

    await runPass([]);

    const callLeg = await testDb("position_legs").where({ id: callLegId }).first();
    expect(callLeg.exit_price === null ? null : Number(callLeg.exit_price)).toBe(0);
    expect(Number((await testDb("position_legs").where({ id: stockLegId }).first()).exit_price)).toBe(50);
    const coveredCall = (await positionsFor(ticker.id)).find((position) => position.id === coveredCallId)!;
    expect([coveredCall.status, coveredCall.close_reason]).toEqual(["closed", "assigned"]);
  });

  it("a put assigned while a Covered Call holds the stock: the new leftover-stock position records the put as its shares' source", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const putConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 92.4409);
    await insertShortOptionLeg(coveredCallId, callConId, "call", 94, isoDateDaysFromToday(7), 1.143);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 100, isoDateDaysFromToday(-1), 1.3358);

    await runPass([heldStock(ticker.symbol, stockConId, 200, 96.2205), heldShortOption(ticker.symbol, callConId, OptionType.Call, 94, isoDateDaysFromToday(7), 114.3)]);

    const csp = (await positionsFor(ticker.id)).find((position) => position.id === cspId)!;
    expect(csp.close_reason).toBe("assigned");
    const leftover = (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!;
    expect(await testDb("position_share_sources").where({ position_id: leftover.id }).select("source_position_id", "shares_received")).toEqual([{ source_position_id: cspId, shares_received: 100 }]);
  });
});

describe("reconcileHeldPositions — what a leftover-stock position is blamed on", () => {
  async function leftoverReasonAfterPutClosed(minutesAgo: number): Promise<string> {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    await insertAssignedPutPosition(ticker.id, 50, 0.5, new Date(Date.now() - minutesAgo * 60_000));
    await runPass([heldStock(ticker.symbol, stockConId, 100, 49.5)]);
    await testDb("platform_anomalies").where({ anomaly_type: "unexplained_leftover_stock" }).where("detail", "like", `${ticker.symbol}:%`).del();
    return (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!.unstructured_reason;
  }

  it("shares appearing right after a put was assigned are blamed on the assignment", async () => {
    expect(await leftoverReasonAfterPutClosed(10)).toBe("csp_assigned_stock");
  });

  it("shares appearing hours after the last closed put are not blamed on it", async () => {
    expect(await leftoverReasonAfterPutClosed(120)).toBe("unknown");
  });
});

describe("option expiry clock", () => {
  it("the SQL rule and the TypeScript rule agree for yesterday, today and tomorrow (Eastern)", async () => {
    const eastern = (offsetDays: number) => {
      const date = new Date(Date.now() + offsetDays * 86_400_000);
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
    };
    for (const offsetDays of [-1, 0, 1]) {
      const expiry = eastern(offsetDays);
      const sqlResult = (await testDb.raw(`SELECT ${optionPastExpirySql("?::date")} AS past`, [expiry])).rows[0].past;
      expect(sqlResult, `expiry ${expiry}`).toBe(isOptionPastExpiry(expiry));
    }
  });
});

describe("Pluto's book: every open position on an enabled ticker (Marcelo, 2026-10-07)", () => {
  async function enablePluto(tickerId: string): Promise<void> {
    await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: await plutoTestUser(), signals_enabled: true, bot_enabled: true });
  }

  /** Marks a leg as opened by a Pluto order: an action, an order carrying its id, and the opening fill. */
  async function fillFromPlutoOrder(legId: string, symbol: string, price: number): Promise<void> {
    const userId = await plutoTestUser();
    if (!plutoTestPassId) {
      const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: "pluto-book" }), model_called: false }).returning(["id"]);
      plutoTestPassId = pass.id;
    }
    const [action] = await testDb("pluto_actions").insert({ pass_id: plutoTestPassId, kind: "open_cash_secured_put", symbol, outcome: "filled" }).returning(["id"]);
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_position", payload: JSON.stringify({ symbol, legs: [] }), status: "filled", pluto_action_id: action.id }).returning(["id"]);
    await testDb("trades").insert({ position_leg_id: legId, ibkr_exec_id: `pluto-book-${legId}`, side: "sell", quantity: 1, price, executed_at: new Date(Date.now() - 86_400_000), is_closing_trade: false, source_order_request_id: order.id });
  }

  async function plutoBookPositionIds(): Promise<string[]> {
    return (await loadPlutoBook()).openPositions.map((position) => position.positionId);
  }

  it("a person's covered call on an enabled ticker expires: the leftover shares and the call later written on them are in the book", async () => {
    const ticker = await createTicker();
    await enablePluto(ticker.id);
    const stockConId = (nextConId += 1);
    const coveredCallId = await insertPosition(ticker.id, "covered_call");
    await insertStockLeg(coveredCallId, stockConId, 100, 50);
    await insertShortOptionLeg(coveredCallId, (nextConId += 1), "call", 55, isoDateDaysFromToday(-1), 1.2);
    expect(await plutoBookPositionIds()).toContain(coveredCallId);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50)]);
    const leftover = (await positionsFor(ticker.id)).find((position) => position.status === "open")!;
    expect(leftover.id).not.toBe(coveredCallId);
    expect(await plutoBookPositionIds()).toContain(leftover.id);

    await runPass([heldStock(ticker.symbol, stockConId, 100, 50), heldShortOption(ticker.symbol, (nextConId += 1), OptionType.Call, 58, isoDateDaysFromToday(20), 90)]);
    const newCoveredCall = (await positionsFor(ticker.id)).find((position) => position.status === "open")!;
    expect(newCoveredCall.id).not.toBe(leftover.id);
    expect(await plutoBookPositionIds()).toContain(newCoveredCall.id);
  });

  it("a put on an enabled ticker assigned 200 shares, one call sold on them: the call and the 100 shares left over are both in the book", async () => {
    const ticker = await createTicker();
    await enablePluto(ticker.id);
    const stockConId = (nextConId += 1);
    const putId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(putId, (nextConId += 1), "put", 40, isoDateDaysFromToday(-1), 0.9);
    await runPass([heldStock(ticker.symbol, stockConId, 200, 39.1)]);
    const assigned = (await positionsFor(ticker.id)).find((position) => position.status === "open")!;
    expect(await plutoBookPositionIds()).toContain(assigned.id);

    await runPass([heldStock(ticker.symbol, stockConId, 200, 39.1), heldShortOption(ticker.symbol, (nextConId += 1), OptionType.Call, 45, isoDateDaysFromToday(20), 80)]);
    const open = (await positionsFor(ticker.id)).filter((position) => position.status === "open");
    const coveredCall = open.find((position) => position.strategy_key === "covered_call")!;
    const leftover = open.find((position) => position.strategy_key === "unstructured")!;
    expect(leftover.id).not.toBe(assigned.id);
    const bookIds = await plutoBookPositionIds();
    expect(bookIds).toContain(coveredCall.id);
    expect(bookIds).toContain(leftover.id);
  });

  it("a ticker Pluto is not enabled on is outside the book, even shares from a put Pluto sold; a person's put on an enabled ticker is inside", async () => {
    const disabledTicker = await createTicker();
    const plutoPutId = await insertPosition(disabledTicker.id, "cash_secured_put");
    const plutoPutLegId = await insertShortOptionLeg(plutoPutId, (nextConId += 1), "put", 40, isoDateDaysFromToday(-1), 0.9);
    await fillFromPlutoOrder(plutoPutLegId, disabledTicker.symbol, 0.9);
    const enabledTicker = await createTicker();
    await enablePluto(enabledTicker.id);
    const humanPutId = await insertPosition(enabledTicker.id, "cash_secured_put");
    await insertShortOptionLeg(humanPutId, (nextConId += 1), "put", 40, isoDateDaysFromToday(-1), 0.9);

    await runPass([heldStock(disabledTicker.symbol, (nextConId += 1), 100, 39.1), heldStock(enabledTicker.symbol, (nextConId += 1), 100, 39.1)]);

    const plutoShares = (await positionsFor(disabledTicker.id)).find((position) => position.status === "open")!;
    const humanShares = (await positionsFor(enabledTicker.id)).find((position) => position.status === "open")!;
    const bookIds = await plutoBookPositionIds();
    expect(bookIds).not.toContain(plutoShares.id);
    expect(bookIds).toContain(humanShares.id);
  });

  it("a hedge on an enabled ticker is never in the book", async () => {
    const ticker = await createTicker();
    await enablePluto(ticker.id);
    const hedgeId = await insertPosition(ticker.id, "hedge");
    const [leg] = await testDb("position_legs")
      .insert({ position_id: hedgeId, leg_type: "option", side: "long", quantity: 10, multiplier: 100, option_type: "call", strike_price: 82, expiry_date: isoDateDaysFromToday(400), ibkr_contract_id: String((nextConId += 1)), entry_price: 3.9, entry_at: new Date(Date.now() - 86_400_000) })
      .returning(["id"]);
    expect(leg.id).toBeTruthy();
    expect(await plutoBookPositionIds()).not.toContain(hedgeId);
  });
});

describe("stock split: detected in the holdings, frozen, rewritten, unfrozen", () => {
  it("a 2-for-1 freezes the ticker without touching its records, then the rewrite moves them to IBKR's new holdings", async () => {
    const { loadSplitRecordRewritePlan, applySplitRecordRewrite, undoSplitRecordRewrite } = await import("../lib/stockSplitRewrite.js");
    const { unfreezeTicker } = await import("../lib/tickerFreeze.js");
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const oldPutConId = (nextConId += 1);
    const newPutConId = (nextConId += 1);
    const expiry = isoDateDaysFromToday(30);
    const stockPositionId = await insertPosition(ticker.id, "unstructured", "assigned_put");
    const stockLegId = await insertStockLeg(stockPositionId, stockConId, 300, 100);
    await testDb("trades").insert({ position_leg_id: stockLegId, ibkr_exec_id: `split-test-${stockLegId}`, side: "buy", quantity: 300, price: 100, executed_at: new Date(Date.now() - 86_400_000), is_closing_trade: false });
    const putPositionId = await insertPosition(ticker.id, "cash_secured_put");
    const putLegId = await insertShortOptionLeg(putPositionId, oldPutConId, "put", 90, expiry, 2);
    await testDb("position_legs").where({ id: putLegId }).update({ quantity: 3 });
    const userId = await plutoTestUser();
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_position", payload: JSON.stringify({ symbol: ticker.symbol, legs: [] }), status: "submitted" }).returning(["id"]);
    // The split's first day is today (the holdings detector records today's Eastern date), so the records above, dated
    // yesterday, are on the old basis.
    const afterSplit = [heldStock(ticker.symbol, stockConId, 600, 50), heldShortOption(ticker.symbol, newPutConId, OptionType.Put, 45, expiry, 100, 6)];

    process.env.APP_ENVIRONMENT ??= "development";
    const messagesBefore = telegramMessages.length;
    await reconcileHeldPositions(afterSplit, ++passCounter, dependencies);
    const alert = telegramMessages.slice(messagesBefore).find((message) => message.includes(`${ticker.symbol} FROZEN`));
    expect(alert).toContain("npm run split:rewrite -- --env");

    const frozen = await testDb("tickers").where({ id: ticker.id }).first("trading_frozen_at", "trading_frozen_reason");
    expect(frozen.trading_frozen_reason).toMatch(/^2-for-1 stock split effective \d{4}-\d{2}-\d{2}$/);
    expect(await testDb("order_requests").where({ id: order.id }).first("status", "cancellation_reason")).toEqual({ status: "cancel_requested", cancellation_reason: "ticker_frozen" });
    const legsWhileFrozen = await testDb("position_legs").whereIn("id", [stockLegId, putLegId]).orderBy("leg_type", "desc");
    expect(legsWhileFrozen.map((leg) => [leg.quantity, Number(leg.entry_price), leg.exit_at])).toEqual([[300, 100, null], [3, 2, null]]);
    const split = await testDb("stock_splits").where({ ticker_id: ticker.id }).first("id", "ratio", "ibkr_holdings");
    expect(Number(split.ratio)).toBe(2);
    expect(split.ibkr_holdings).toHaveLength(2);

    const plan = await loadSplitRecordRewritePlan(split.id);
    expect(plan.problems).toEqual([]);
    await applySplitRecordRewrite(plan, { acceptProblems: false });
    const rewritten = async () => (await testDb("position_legs").whereIn("id", [stockLegId, putLegId]).orderBy("leg_type", "desc")).map((leg) => [leg.quantity, Number(leg.entry_price), leg.strike_price === null ? null : Number(leg.strike_price), leg.ibkr_contract_id]);
    expect(await rewritten()).toEqual([[600, 50, null, String(stockConId)], [6, 1, 45, String(newPutConId)]]);
    expect(await testDb("trades").where({ position_leg_id: stockLegId }).first("quantity", "price")).toEqual({ quantity: 600, price: "50.0000" });

    expect(await undoSplitRecordRewrite(split.id)).toBeGreaterThan(0);
    expect((await testDb("position_legs").where({ id: putLegId }).first("quantity", "strike_price", "ibkr_contract_id"))).toEqual({ quantity: 3, strike_price: "90.0000", ibkr_contract_id: String(oldPutConId) });
    await applySplitRecordRewrite(await loadSplitRecordRewritePlan(split.id), { acceptProblems: false });
    expect((await testDb("tickers").where({ id: ticker.id }).first("trading_frozen_at")).trading_frozen_at).not.toBeNull();

    await unfreezeTicker(ticker.id);
    await reconcileHeldPositions(afterSplit, ++passCounter, dependencies);
    expect(await rewritten()).toEqual([[600, 50, null, String(stockConId)], [6, 1, 45, String(newPutConId)]]);
    expect(await testDb("position_legs").whereIn("position_id", [stockPositionId, putPositionId]).whereNotNull("exit_at")).toHaveLength(0);
    await testDb("alert_state").where({ alert_key: `ticker_frozen:${ticker.id}` }).del();
  });
});

describe("reconcileHeldPositions — positions_changed tells screens to re-fetch once a pass has finished writing", () => {
  // Every notification published while `run` executes, read off the real channel. Other test files share the test
  // database and publish too, so each assertion looks only at this test's own ticker.
  async function notificationsDuring(run: () => Promise<void>): Promise<{ type: string; symbols?: string[] }[]> {
    const { Client: PgClient } = await import("pg");
    const { appNotificationsChannel } = await import("../lib/notificationChannel.js");
    const listener = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    const received: { type: string; symbols?: string[] }[] = [];
    await listener.connect();
    try {
      listener.on("notification", (message) => received.push(JSON.parse(message.payload ?? "{}")));
      await listener.query(`LISTEN ${appNotificationsChannel}`);
      await run();
      // NOTIFY is delivered on commit; one round trip on the listener's own connection lets it arrive.
      await listener.query("SELECT 1");
    } finally {
      await listener.end();
    }
    return received;
  }

  it("leftover stock rolled into a covered call: one positions_changed for the ticker, published after the leftover position closed", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const leftoverId = await insertPosition(ticker.id, "unstructured", "csp_assigned_stock");
    await insertStockLeg(leftoverId, stockConId, 100, 80.9113);
    const held = [heldStock(ticker.symbol, stockConId, 100, 81.02), heldShortOption(ticker.symbol, callConId, OptionType.Call, 85, isoDateDaysFromToday(20), 150)];

    let leftoverStatusWhenPublished: string | null = null;
    const received = await notificationsDuring(async () => {
      await runPass(held);
      leftoverStatusWhenPublished = (await testDb("positions").where({ id: leftoverId }).first("status")).status;
    });

    const forTicker = received.filter((notification) => notification.type === "positions_changed" && notification.symbols!.includes(ticker.symbol));
    expect(forTicker).toHaveLength(1);
    // The opening notification still goes out (Pulse's Latest Events and Today's Orders use it), and it comes first.
    const openedIndex = received.findIndex((notification) => notification.type === "position_opened" && (notification as { symbol?: string }).symbol === ticker.symbol);
    expect(openedIndex).toBeGreaterThanOrEqual(0);
    expect(received.indexOf(forTicker[0]!)).toBeGreaterThan(openedIndex);
    expect(leftoverStatusWhenPublished).toBe("closed");
    expect(await testDb("notification_events").whereRaw("payload::jsonb->>'type' = 'positions_changed'")).toHaveLength(0);
  });

  it("a pass that changes nothing for a ticker does not name it", async () => {
    const ticker = await createTicker();
    const stockConId = (nextConId += 1);
    const callConId = (nextConId += 1);
    const held = [heldStock(ticker.symbol, stockConId, 100, 81.02), heldShortOption(ticker.symbol, callConId, OptionType.Call, 85, isoDateDaysFromToday(20), 150)];
    await runPass(held);

    const received = await notificationsDuring(() => runPass(held));

    expect(received.some((notification) => notification.type === "positions_changed" && notification.symbols!.includes(ticker.symbol))).toBe(false);
  });
});
