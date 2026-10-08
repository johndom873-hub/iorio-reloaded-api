import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// evaluateOrderLimits against real order_requests / positions / trading_settings rows in the test database; only the IBKR and
// market-data boundaries are mocked (account summary, exposure figures, the live stock price).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run order limit database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const fetchAccountSummaryMock = vi.fn();
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: (...args: unknown[]) => fetchAccountSummaryMock(...args) }));

const computeTickerExposureMock = vi.fn();
const computeCashLockedInCspsMock = vi.fn();
vi.mock("./positionExposure.js", () => ({
  computeTickerExposure: (...args: unknown[]) => computeTickerExposureMock(...args),
  computeCashLockedInCsps: (...args: unknown[]) => computeCashLockedInCspsMock(...args),
}));

const fetchPricesPoolFirstMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: (...args: unknown[]) => fetchPricesPoolFirstMock(...args) }));

const { db } = await import("../db/connection.js");
const { evaluateOrderLimits } = await import("./orderLimits.js");

const testDb: Knex = db;

let userId: string;
let originalSettings: Record<string, unknown>;
const createdTickerIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

const netLiquidationValue = 1_000_000;

function nextSymbol(): string {
  return `LM${(symbolCounter += 1)}`;
}

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = nextSymbol();
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Limits Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

async function setLimits(limits: { maxPosition?: number; maxConcentration?: number; minCash?: number }): Promise<void> {
  await testDb("trading_settings").update({
    max_position_pct_of_portfolio: limits.maxPosition ?? 100,
    max_concentration_per_ticker_pct: limits.maxConcentration ?? 100,
    min_cash_reserve_pct: limits.minCash ?? 0,
  });
}

function putOpenPayload(symbol: string, strike: number, contracts: number) {
  return { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: contracts, unitPrice: 1, strike, expiry: "20261120", right: "P" }] };
}

function buyWritePayload(symbol: string, shares: number, stockPrice: number, contracts: number) {
  return {
    symbol,
    strategyKey: "covered_call",
    legs: [
      { role: "stock", action: "BUY", symbol, quantity: shares, unitPrice: stockPrice },
      { role: "option", action: "SELL", symbol, quantity: contracts, unitPrice: 1, strike: stockPrice + 5, expiry: "20261120", right: "C" },
    ],
  };
}

async function insertOrder(requestType: string, status: string, payload: unknown): Promise<string> {
  const [row] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: requestType, status, payload: JSON.stringify(payload) })
    .returning("id");
  return row.id;
}

beforeAll(async () => {
  originalSettings = await testDb("trading_settings").first();
  const [user] = await testDb("users").insert({ username: `limits-db-${Date.now()}`, display_name: "Limits DB Test", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const strayInFlight = await testDb("order_requests").whereIn("status", ["confirmed", "submitted", "partially_filled", "cancel_requested"]).count({ count: "*" }).first();
  if (Number(strayInFlight!.count) !== 0) throw new Error("The test database already holds in-flight orders; these tests need an empty in-flight set.");
});

beforeEach(async () => {
  fetchAccountSummaryMock.mockReset().mockResolvedValue({ netLiquidationValue, totalCashValue: 400_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null });
  computeTickerExposureMock.mockReset().mockResolvedValue(0);
  computeCashLockedInCspsMock.mockReset().mockResolvedValue(0);
  fetchPricesPoolFirstMock.mockReset().mockResolvedValue({ stock: 100 });
  await setLimits({});
});

afterEach(async () => {
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("id", positionIds).del();
});

afterAll(async () => {
  await testDb("trading_settings").update(originalSettings);
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

const cashSecuredPut = (symbol: string, strike: number, quantity: number, extra: Record<string, unknown> = {}) => ({
  strategyKey: "cash_secured_put" as const,
  symbol,
  tickerId: "unused-for-puts",
  quantity,
  strike,
  ...extra,
});

describe("max position size: exactly at the boundary", () => {
  it("a cash-secured put at exactly the limit passes, one cent of strike over blocks, one cent under passes", async () => {
    await setLimits({ maxPosition: 10 });
    const at = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 10));
    expect(at.blocked).toBe(false);
    expect(at.details?.orderNotional).toBe(100_000);
    expect(at.details?.positionSharePct).toBeCloseTo(0.1, 12);

    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 99.99, 10))).blocked).toBe(false);

    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 100.01, 10));
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["This order is 10.0% of portfolio value, above the 10% max position size."]);
    expect(over.details?.orderNotional).toBeCloseTo(100_010, 6);
  });

  it("the reason carries the configured limit value, not a default", async () => {
    await setLimits({ maxPosition: 7.5 });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 10));
    expect(result.reasons).toEqual(["This order is 10.0% of portfolio value, above the 7.5% max position size."]);
  });

  it("a covered-call buy-write is measured as the share shortfall times the spot price", async () => {
    await setLimits({ maxPosition: 10 });
    const ticker = await createTicker();
    const callOrder = (spotPrice: number) => ({ strategyKey: "covered_call" as const, symbol: ticker.symbol, tickerId: ticker.id, quantity: 10, strike: 120, spotPrice });
    const at = await evaluateOrderLimits(callOrder(100));
    expect(at.blocked).toBe(false);
    expect(at.details?.orderNotional).toBe(100_000);
    const over = await evaluateOrderLimits(callOrder(100.01));
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["This order is 10.0% of portfolio value, above the 10% max position size."]);
    expect((await evaluateOrderLimits(callOrder(99.99))).blocked).toBe(false);
  });

  it("a covered call with enough held shares adds no notional, so it passes even a 0% limit", async () => {
    await setLimits({ maxPosition: 0, maxConcentration: 100, minCash: 0 });
    const ticker = await createTicker();
    const [position] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "open" }).returning("id");
    await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 1000, multiplier: 1, entry_price: 100, entry_at: new Date(Date.now() - 86_400_000) });
    const result = await evaluateOrderLimits({ strategyKey: "covered_call", symbol: ticker.symbol, tickerId: ticker.id, quantity: 10, strike: 120, spotPrice: 100 });
    expect(result.blocked).toBe(false);
    expect(result.details?.orderNotional).toBe(0);
  });

  it("a covered call with only some shares held is charged the remaining shortfall at spot", async () => {
    await setLimits({ maxPosition: 100 });
    const ticker = await createTicker();
    const [position] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "open" }).returning("id");
    await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 300, multiplier: 1, entry_price: 100, entry_at: new Date(Date.now() - 86_400_000) });
    const result = await evaluateOrderLimits({ strategyKey: "covered_call", symbol: ticker.symbol, tickerId: ticker.id, quantity: 5, strike: 120, spotPrice: 50 });
    expect(result.details?.orderNotional).toBe(10_000); // (500 - 300) shares x $50
  });

  it("shares held in a closed position, or already sold, do not count as coverage", async () => {
    await setLimits({ maxPosition: 100 });
    const ticker = await createTicker();
    const [closedPosition] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
    await testDb("position_legs").insert({ position_id: closedPosition.id, leg_type: "stock", side: "long", quantity: 1000, multiplier: 1, entry_price: 100, entry_at: new Date(Date.now() - 86_400_000), exit_price: 101, exit_at: new Date() });
    const result = await evaluateOrderLimits({ strategyKey: "covered_call", symbol: ticker.symbol, tickerId: ticker.id, quantity: 1, strike: 120, spotPrice: 50 });
    expect(result.details?.orderNotional).toBe(5_000);
  });
});

// Limits are compared in dollars: fraction x 100 is not exact (0.07 * 100 === 7.000000000000001), which must not block an order sitting exactly AT a limit.
describe("exactly at the limit with values where fraction x 100 is not exact", () => {
  beforeEach(() => {
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 100_000, totalCashValue: 400_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null });
  });

  it("an order of exactly 7% of portfolio value passes a 7% max position size", async () => {
    await setLimits({ maxPosition: 7 });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 70, 1)); // 7,000 of 100,000
    expect(result.reasons).toEqual([]);
  });

  it("a ticker at exactly 14% of portfolio value passes a 14% max concentration", async () => {
    await setLimits({ maxConcentration: 14 });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 140, 1)); // 14,000 of 100,000
    expect(result.reasons).toEqual([]);
  });

  it("leaving exactly 29% of portfolio value as cash passes a 29% min cash reserve", async () => {
    await setLimits({ minCash: 29 });
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 100_000, totalCashValue: 60_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 310, 1)); // 60,000 - 31,000 = 29,000 of 100,000
    expect(result.reasons).toEqual([]);
  });

  it("the same orders one cent over are blocked, so the boundary is only wrong exactly at the limit", async () => {
    await setLimits({ maxPosition: 7 });
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 70.01, 1))).blocked).toBe(true);
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 69.99, 1))).blocked).toBe(false);
  });
});

describe("max position size for rolls", () => {
  it("a cash-secured put rolled UP adds only the strike difference: at the boundary passes, one cent more blocks", async () => {
    await setLimits({ maxPosition: 0.5 });
    const at = await evaluateOrderLimits(cashSecuredPut("AAA", 105, 10, { rollFromStrike: 100 }));
    expect(at.blocked).toBe(false);
    expect(at.details?.orderNotional).toBe(5_000);
    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 105.01, 10, { rollFromStrike: 100 }));
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["This order is 0.5% of portfolio value, above the 0.5% max position size."]);
  });

  it("a cash-secured put rolled DOWN, or to the same strike, adds nothing and passes a 0% limit", async () => {
    await setLimits({ maxPosition: 0 });
    for (const newStrike of [95, 100]) {
      const result = await evaluateOrderLimits(cashSecuredPut("AAA", newStrike, 10, { rollFromStrike: 100 }));
      expect(result.blocked).toBe(false);
      expect(result.details?.orderNotional).toBe(0);
    }
  });

  it("a covered-call roll adds nothing whatever the strikes, and never asks for a live stock price", async () => {
    await setLimits({ maxPosition: 0 });
    const result = await evaluateOrderLimits({ strategyKey: "covered_call", symbol: "AAA", tickerId: "unused", quantity: 10, strike: 150, rollFromStrike: 100 });
    expect(result.blocked).toBe(false);
    expect(result.details?.orderNotional).toBe(0);
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });

  it("a cash-secured put open never asks for a live stock price either", async () => {
    await evaluateOrderLimits(cashSecuredPut("AAA", 50, 1));
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });
});

describe("max concentration per ticker: exactly at the boundary", () => {
  it("existing exposure plus the order at exactly the limit passes, a cent of strike more blocks", async () => {
    await setLimits({ maxConcentration: 20 });
    computeTickerExposureMock.mockResolvedValue(100_000);
    const at = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 10));
    expect(at.blocked).toBe(false);
    expect(at.details?.concentrationAfterPct).toBeCloseTo(0.2, 12);
    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 100.01, 10));
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["AAA would be 20.0% of portfolio value, above the 20% max concentration per ticker."]);
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 99.99, 10))).blocked).toBe(false);
    expect(computeTickerExposureMock).toHaveBeenCalledWith("AAA");
  });

  it("a roll counts existing exposure plus only its strike difference", async () => {
    await setLimits({ maxConcentration: 20 });
    computeTickerExposureMock.mockResolvedValue(195_000);
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 105, 10, { rollFromStrike: 100 }))).blocked).toBe(false);
    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 105.01, 10, { rollFromStrike: 100 }));
    expect(over.blocked).toBe(true);
    expect(over.reasons[0]).toMatch(/^AAA would be 20\.0% of portfolio value, above the 20% max concentration per ticker\.$/);
  });
});

describe("min cash reserve: exactly at the boundary", () => {
  it("free cash left after the order at exactly the reserve passes, a cent of strike more blocks", async () => {
    await setLimits({ minCash: 5 });
    const at = await evaluateOrderLimits(cashSecuredPut("AAA", 350, 10)); // 400k - 350k = 50k = 5.0%
    expect(at.blocked).toBe(false);
    expect(at.details?.cashReserveAfterPct).toBeCloseTo(0.05, 12);
    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 350.01, 10));
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["Placing this order would leave only 5.0% of portfolio value as cash, below the 5% min cash reserve."]);
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 349.99, 10))).blocked).toBe(false);
  });

  it("cash locked in cash-secured puts is subtracted from free cash", async () => {
    await setLimits({ minCash: 5 });
    computeCashLockedInCspsMock.mockResolvedValue(100_000);
    // free cash 300k: a 250k order leaves exactly 5.0%
    expect((await evaluateOrderLimits(cashSecuredPut("AAA", 250, 10))).blocked).toBe(false);
    const over = await evaluateOrderLimits(cashSecuredPut("AAA", 250.01, 10));
    expect(over.blocked).toBe(true);
    expect(over.reasons[0]).toContain("below the 5% min cash reserve");
  });

  it("free cash never goes negative: locked collateral above cash reads as zero free cash", async () => {
    await setLimits({ minCash: 0 });
    computeCashLockedInCspsMock.mockResolvedValue(500_000);
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 1)); // 10k order against 0 free cash
    expect(result.blocked).toBe(true);
    expect(result.details?.cashReserveAfterPct).toBeCloseTo(-0.01, 12);
    expect(result.reasons).toEqual(["Placing this order would leave only -1.0% of portfolio value as cash, below the 0% min cash reserve."]);
  });

  it("a null total cash value counts as no cash at all", async () => {
    await setLimits({ minCash: 1 });
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue, totalCashValue: null });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 1));
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual(["Placing this order would leave only -1.0% of portfolio value as cash, below the 1% min cash reserve."]);
  });
});

describe("several limits breached at once", () => {
  it("reports every breached limit, in the order position, concentration, cash", async () => {
    await setLimits({ maxPosition: 5, maxConcentration: 6, minCash: 90 });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 10));
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual([
      "This order is 10.0% of portfolio value, above the 5% max position size.",
      "AAA would be 10.0% of portfolio value, above the 6% max concentration per ticker.",
      "Placing this order would leave only 30.0% of portfolio value as cash, below the 90% min cash reserve.",
    ]);
  });

  it("passes with no reasons and full details when nothing is breached", async () => {
    await setLimits({ maxPosition: 50, maxConcentration: 50, minCash: 5 });
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 1));
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.details).toEqual({
      orderNotional: 10_000,
      totalPortfolioValue: 1_000_000,
      positionSharePct: 0.01,
      concentrationAfterPct: 0.01,
      cashReserveAfterPct: 0.39,
      inFlightNotional: 0,
      limits: { maxPositionPctOfPortfolio: 50, maxConcentrationPerTickerPct: 50, minCashReservePct: 5 },
    });
  });
});

describe("orders still in flight", () => {
  const inFlightStatuses = ["confirmed", "submitted", "partially_filled", "cancel_requested"];
  const notInFlightStatuses = ["pending_confirmation", "filled", "cancelled", "error", "rejected", "cancelled_partially_filled"];

  for (const status of inFlightStatuses) {
    it(`an order in status ${status} counts toward the in-flight notional`, async () => {
      await insertOrder("open_cash_secured_put", status, putOpenPayload("INF", 100, 5));
      const result = await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1));
      expect(result.details?.inFlightNotional).toBe(50_000);
    });
  }

  for (const status of notInFlightStatuses) {
    it(`an order in status ${status} does not count`, async () => {
      const orderId = await insertOrder("open_cash_secured_put", status, putOpenPayload("INF", 100, 5));
      // Past the fill wait: a filled order with no recorded fills counts only right after its status changed (below).
      await testDb("order_requests").where({ id: orderId }).update({ updated_at: new Date(Date.now() - 10 * 60_000) });
      const result = await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1));
      expect(result.details?.inFlightNotional).toBe(0);
    });
  }

  for (const status of ["filled", "cancelled_partially_filled"]) {
    it(`an order IBKR reported ${status} moments ago whose fills are not recorded yet still counts (its position does not exist yet)`, async () => {
      await insertOrder("open_cash_secured_put", status, putOpenPayload("INF", 100, 5));
      const result = await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1));
      expect(result.details?.inFlightNotional).toBe(50_000);
    });
  }

  it("a just-filled order stops counting once all its fills are recorded", async () => {
    const orderId = await insertOrder("open_cash_secured_put", "filled", putOpenPayload("INF", 100, 5));
    const ticker = await createTicker();
    const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "open" }).returning("id");
    const [leg] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 5, multiplier: 100, option_type: "put", strike_price: 100, expiry_date: "2026-11-20", entry_price: 1, entry_at: new Date() }).returning("id");
    await testDb("trades").insert({ position_leg_id: leg.id, ibkr_order_id: "1", ibkr_exec_id: `limits-db-${Date.now()}-a`, side: "sell", quantity: 3, price: 1, executed_at: new Date(), is_closing_trade: false, source_order_request_id: orderId });
    try {
      expect((await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1))).details?.inFlightNotional).toBe(50_000); // 3 of 5 recorded
      await testDb("trades").insert({ position_leg_id: leg.id, ibkr_order_id: "1", ibkr_exec_id: `limits-db-${Date.now()}-b`, side: "sell", quantity: 2, price: 1, executed_at: new Date(), is_closing_trade: false, source_order_request_id: orderId });
      expect((await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1))).details?.inFlightNotional).toBe(0);
    } finally {
      await testDb("trades").where({ source_order_request_id: orderId }).del();
    }
  });

  it("sums every in-flight order across tickers and kinds: puts, buy-writes, put rolls, closes and held-share calls", async () => {
    await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("INF", 100, 5)); // 50,000
    await insertOrder("open_covered_call", "submitted", buyWritePayload("OTH", 200, 50, 2)); // 10,000
    await insertOrder("open_covered_call", "submitted", { ...buyWritePayload("OTH", 200, 50, 2), legs: [buyWritePayload("OTH", 200, 50, 2).legs[1]] }); // held shares: 0
    await insertOrder("close_position", "confirmed", putOpenPayload("INF", 100, 5)); // a close: 0
    await insertOrder("roll_leg", "partially_filled", {
      symbol: "INF",
      strategyKey: "cash_secured_put",
      legs: [
        { role: "option", action: "BUY", symbol: "INF", quantity: 2, unitPrice: 1, strike: 90, expiry: "20261009", right: "P", positionLegId: "leg-1" },
        { role: "option", action: "SELL", symbol: "INF", quantity: 2, unitPrice: 2, strike: 95, expiry: "20261120", right: "P" },
      ],
    }); // 1,000
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 10, 1));
    expect(result.details?.inFlightNotional).toBe(61_000);
  });

  it("the order being evaluated is left out of the in-flight total", async () => {
    const own = await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("AAA", 100, 5));
    const other = await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("INF", 100, 2));
    const withOwn = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 5));
    expect(withOwn.details?.inFlightNotional).toBe(70_000);
    const excluded = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 5, { excludeOrderRequestId: own }));
    expect(excluded.details?.inFlightNotional).toBe(20_000);
    const excludedOther = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 5, { excludeOrderRequestId: other }));
    expect(excludedOther.details?.inFlightNotional).toBe(50_000);
  });

  it("in-flight of the SAME ticker raises concentration (and lowers free cash)", async () => {
    await setLimits({ maxConcentration: 100, minCash: 0 });
    await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("SAMETK", 100, 5)); // 50,000
    computeTickerExposureMock.mockResolvedValue(30_000);
    const result = await evaluateOrderLimits(cashSecuredPut("SAMETK", 100, 2)); // order 20,000
    expect(result.details?.inFlightNotional).toBe(50_000);
    expect(result.details?.concentrationAfterPct).toBeCloseTo(0.1, 12); // 30k + 50k + 20k
    expect(result.details?.cashReserveAfterPct).toBeCloseTo(0.33, 12); // 400k - 50k - 20k
  });

  it("in-flight of OTHER tickers only lowers free cash, not this ticker's concentration", async () => {
    await setLimits({ maxConcentration: 100, minCash: 0 });
    await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("OTHERTK", 100, 5));
    computeTickerExposureMock.mockResolvedValue(30_000);
    const result = await evaluateOrderLimits(cashSecuredPut("SAMETK", 100, 2));
    expect(result.details?.inFlightNotional).toBe(50_000);
    expect(result.details?.concentrationAfterPct).toBeCloseTo(0.05, 12); // 30k + 20k only
    expect(result.details?.cashReserveAfterPct).toBeCloseTo(0.33, 12);
  });

  it("the 'orders still working' note appears in the concentration and cash reasons only when something is in flight", async () => {
    await setLimits({ maxPosition: 100, maxConcentration: 5, minCash: 60 });
    const without = await evaluateOrderLimits(cashSecuredPut("SAMETK", 100, 10));
    expect(without.reasons).toEqual([
      "SAMETK would be 10.0% of portfolio value, above the 5% max concentration per ticker.",
      "Placing this order would leave only 30.0% of portfolio value as cash, below the 60% min cash reserve.",
    ]);
    await insertOrder("open_cash_secured_put", "submitted", putOpenPayload("SAMETK", 100, 5));
    const withInFlight = await evaluateOrderLimits(cashSecuredPut("SAMETK", 100, 10));
    expect(withInFlight.reasons).toEqual([
      "SAMETK would be 15.0% of portfolio value, above the 5% max concentration per ticker (counting $50,000 of orders still working).",
      "Placing this order would leave only 25.0% of portfolio value as cash, below the 60% min cash reserve (counting $50,000 of orders still working).",
    ]);
  });

  it("the position-size reason never carries the working-orders note", async () => {
    await setLimits({ maxPosition: 1 });
    await insertOrder("open_cash_secured_put", "confirmed", putOpenPayload("INF", 100, 5));
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 100, 10));
    expect(result.reasons[0]).toBe("This order is 10.0% of portfolio value, above the 1% max position size.");
  });

  it("two orders confirmed back to back where only one fits: the second blocks once the first is in flight", async () => {
    await setLimits({ maxPosition: 100, maxConcentration: 100, minCash: 5 }); // room for 350k of orders
    const firstId = await insertOrder("open_cash_secured_put", "pending_confirmation", putOpenPayload("AAA", 200, 10)); // 200k
    const secondId = await insertOrder("open_cash_secured_put", "pending_confirmation", putOpenPayload("BBB", 200, 10)); // 200k
    const firstInput = cashSecuredPut("AAA", 200, 10, { excludeOrderRequestId: firstId });
    const secondInput = cashSecuredPut("BBB", 200, 10, { excludeOrderRequestId: secondId });

    // Both are only built: nothing is working, each fits on its own.
    expect((await evaluateOrderLimits(firstInput)).blocked).toBe(false);
    expect((await evaluateOrderLimits(secondInput)).blocked).toBe(false);

    // The first is confirmed: it now ties up 200k, so the second no longer fits.
    await testDb("order_requests").where({ id: firstId }).update({ status: "confirmed" });
    const secondAfter = await evaluateOrderLimits(secondInput);
    expect(secondAfter.blocked).toBe(true);
    expect(secondAfter.details?.inFlightNotional).toBe(200_000);
    expect(secondAfter.reasons).toEqual(["Placing this order would leave only 0.0% of portfolio value as cash, below the 5% min cash reserve (counting $200,000 of orders still working)."]);
    // The first, evaluated again, is not blocked by itself.
    expect((await evaluateOrderLimits(firstInput)).blocked).toBe(false);

    // Once the first is cancelled the second fits again.
    await testDb("order_requests").where({ id: firstId }).update({ status: "cancelled" });
    expect((await evaluateOrderLimits(secondInput)).blocked).toBe(false);
  });
});

describe("fail closed", () => {
  it("blocks with the error text when the account summary cannot be read, and gives no details", async () => {
    fetchAccountSummaryMock.mockRejectedValue(new Error("IBKR timed out"));
    const result = await evaluateOrderLimits(cashSecuredPut("AAA", 1, 1));
    expect(result).toEqual({ blocked: true, reasons: ["Could not verify position limits: IBKR timed out"] });
  });

  it("blocks when the exposure figures cannot be computed", async () => {
    computeTickerExposureMock.mockRejectedValue(new Error("exposure failed"));
    expect(await evaluateOrderLimits(cashSecuredPut("AAA", 1, 1))).toEqual({ blocked: true, reasons: ["Could not verify position limits: exposure failed"] });
    computeTickerExposureMock.mockResolvedValue(0);
    computeCashLockedInCspsMock.mockRejectedValue(new Error("collateral failed"));
    expect(await evaluateOrderLimits(cashSecuredPut("AAA", 1, 1))).toEqual({ blocked: true, reasons: ["Could not verify position limits: collateral failed"] });
  });

  it("blocks when the trading settings row is missing", async () => {
    const original = await testDb("trading_settings").first();
    await testDb("trading_settings").del();
    try {
      expect(await evaluateOrderLimits(cashSecuredPut("AAA", 1, 1))).toEqual({ blocked: true, reasons: ["Could not verify position limits: No trading_settings row found."] });
    } finally {
      await testDb("trading_settings").insert(original);
    }
  });

  for (const [label, netLiquidation] of [["null", null], ["zero", 0], ["negative", -5]] as const) {
    it(`blocks when net liquidation value is ${label}`, async () => {
      fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: netLiquidation, totalCashValue: 400_000 });
      expect(await evaluateOrderLimits(cashSecuredPut("AAA", 1, 1))).toEqual({ blocked: true, reasons: ["Could not verify position limits: total portfolio value is unavailable."] });
    });
  }

  it("blocks a covered-call open when no spot price can be fetched, and when the price fetch throws", async () => {
    const ticker = await createTicker();
    const input = { strategyKey: "covered_call" as const, symbol: ticker.symbol, tickerId: ticker.id, quantity: 1, strike: 120 };
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: null });
    expect(await evaluateOrderLimits(input)).toEqual({ blocked: true, reasons: ["Could not fetch a live stock price to verify position limits."] });
    fetchPricesPoolFirstMock.mockResolvedValue({});
    expect((await evaluateOrderLimits(input)).reasons).toEqual(["Could not fetch a live stock price to verify position limits."]);
    fetchPricesPoolFirstMock.mockRejectedValue(new Error("pool down"));
    expect(await evaluateOrderLimits(input)).toEqual({ blocked: true, reasons: ["Could not verify position limits: pool down"] });
  });

  it("reads the live stock price from the pool for a covered-call open that does not pass one", async () => {
    await setLimits({ maxPosition: 100 });
    const ticker = await createTicker();
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 42 });
    const result = await evaluateOrderLimits({ strategyKey: "covered_call", symbol: ticker.symbol, tickerId: ticker.id, quantity: 2, strike: 50 });
    expect(fetchPricesPoolFirstMock).toHaveBeenCalledWith([{ key: "stock", legType: "stock", symbol: ticker.symbol }]);
    expect(result.details?.orderNotional).toBe(8_400); // 200 shares x $42
  });

  it("does not ask the pool for a price when the caller passes one", async () => {
    const ticker = await createTicker();
    await evaluateOrderLimits({ strategyKey: "covered_call", symbol: ticker.symbol, tickerId: ticker.id, quantity: 1, strike: 50, spotPrice: 10 });
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });
});
