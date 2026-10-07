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

    const held = [heldStock(ticker.symbol, stockConId, 100, 118.59739)];
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

  it("no assignment fill recorded: IBKR's average cost is kept, rounded to four decimals, and not rewritten every pass", async () => {
    const ticker = await createTicker();
    const putConId = (nextConId += 1);
    const stockConId = (nextConId += 1);
    const cspId = await insertPosition(ticker.id, "cash_secured_put");
    await insertShortOptionLeg(cspId, putConId, "put", 120, isoDateDaysFromToday(-1), 1.4026);

    const held = [heldStock(ticker.symbol, stockConId, 100, 118.59739)];
    await runPass(held);
    const leftover = (await positionsFor(ticker.id)).find((position) => position.strategy_key === "unstructured")!;
    const [stockLeg] = await legsFor(leftover.id);
    expect(Number(stockLeg!.entry_price)).toBe(118.5974);

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
  async function plutoTestUser(): Promise<string> {
    if (!plutoTestUserId) {
      const [user] = await testDb("users").insert({ username: `reconcile-pluto-${Date.now()}`, display_name: "Pluto book test", password_hash: "x" }).returning(["id"]);
      plutoTestUserId = user.id;
    }
    return plutoTestUserId!;
  }

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
