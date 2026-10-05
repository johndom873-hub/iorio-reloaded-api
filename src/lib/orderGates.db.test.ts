import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// evaluateOrderGates composed over the real tickers table. Every boundary the gate calls is mocked: the trading worker lookup, the
// limit evaluator (the figures are covered in orderLimits.db.test.ts), the close gate, and the pooled quote feed + band that the real
// delta gate reads.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run order gate database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const fetchTradingBlockedReasonMock = vi.fn();
vi.mock("./tradingGate.js", () => ({ fetchTradingBlockedReason: (...args: unknown[]) => fetchTradingBlockedReasonMock(...args) }));

const evaluateOrderLimitsMock = vi.fn();
vi.mock("./orderLimits.js", () => ({ evaluateOrderLimits: (...args: unknown[]) => evaluateOrderLimitsMock(...args) }));

const evaluateCloseGateForPositionMock = vi.fn();
vi.mock("./closeGate.js", () => ({ evaluateCloseGateForPosition: (...args: unknown[]) => evaluateCloseGateForPositionMock(...args) }));

const subscribeToPooledQuoteMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: (...args: unknown[]) => subscribeToPooledQuoteMock(...args),
  waitForFirstReading: (isComplete: () => boolean) => {
    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const timer = setTimeout(resolveSettled, 50);
    const check = () => {
      if (!isComplete()) return;
      clearTimeout(timer);
      resolveSettled();
    };
    return { settled, check };
  },
}));

const loadRecoveryTargetWindowMock = vi.fn();
vi.mock("./recoveryTargetWindow.js", () => ({ loadRecoveryTargetWindow: (...args: unknown[]) => loadRecoveryTargetWindowMock(...args) }));

const { db } = await import("../db/connection.js");
const { evaluateOrderGates } = await import("./orderGates.js");

const testDb: Knex = db;
const createdTickerIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `OG${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Order Gate Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

afterAll(async () => {
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

const clearLimits = { blocked: false, reasons: [] as string[] };

beforeEach(() => {
  fetchTradingBlockedReasonMock.mockReset().mockResolvedValue(null);
  evaluateOrderLimitsMock.mockReset().mockResolvedValue(clearLimits);
  evaluateCloseGateForPositionMock.mockReset().mockResolvedValue({ blocked: false, reason: null, cycleTotal: 12.5 });
  subscribeToPooledQuoteMock.mockReset().mockImplementation(async (_contract: unknown, onUpdate: (quote: { delta: number | null }) => void) => {
    onUpdate({ delta: -0.25 });
    return () => {};
  });
  loadRecoveryTargetWindowMock.mockReset().mockResolvedValue({ deltaTargetMin: 0.2, deltaTargetMax: 0.3, dteTargetMin: 30, dteTargetMax: 45 });
});

function putOpenPayload(symbol: string): OrderRequestPayload {
  return { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] } as OrderRequestPayload;
}

function putRollPayload(symbol: string): OrderRequestPayload {
  return {
    symbol,
    strategyKey: "cash_secured_put",
    legs: [
      { role: "option", action: "BUY", symbol, quantity: 2, unitPrice: 1, strike: 85, expiry: "20261030", right: "P", positionLegId: "leg-1" },
      { role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 2, strike: 90, expiry: "20261120", right: "P" },
    ],
  } as OrderRequestPayload;
}

describe("evaluateOrderGates: what runs for each kind of order", () => {
  it("limit-checks and delta-checks an open from any origin, a Signals-built one (signal_snapshot) and a plain one alike", async () => {
    const ticker = await createTicker();
    const plain = { id: "order-plain", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) };
    const fromSignals = { id: "order-signals", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol), signal_snapshot: { grade: "A", netEdge: 12 } };

    const plainResult = await evaluateOrderGates(plain);
    const signalsResult = await evaluateOrderGates(fromSignals);

    expect(evaluateOrderLimitsMock).toHaveBeenCalledTimes(2);
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).toEqual({ strategyKey: "cash_secured_put", symbol: ticker.symbol, tickerId: ticker.id, quantity: 2, strike: 90, rollFromStrike: undefined, excludeOrderRequestId: "order-plain", spotPrice: undefined });
    expect(evaluateOrderLimitsMock.mock.calls[1]![0]).toEqual({ strategyKey: "cash_secured_put", symbol: ticker.symbol, tickerId: ticker.id, quantity: 2, strike: 90, rollFromStrike: undefined, excludeOrderRequestId: "order-signals", spotPrice: undefined });
    expect(subscribeToPooledQuoteMock).toHaveBeenCalledTimes(2);
    for (const result of [plainResult, signalsResult]) {
      expect(result.limits).toEqual(clearLimits);
      expect(result.deltaBand).toEqual({ compliant: true, reason: null });
      expect(result.closeGate).toBeNull();
      expect(result.blocks).toEqual([]);
    }
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });

  it("looks the ticker up by trimmed, upper-cased symbol and hands the canonical symbol to the limit check", async () => {
    const ticker = await createTicker();
    const sloppy = putOpenPayload(` ${ticker.symbol.toLowerCase()} `);
    await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: sloppy });
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).toMatchObject({ symbol: ticker.symbol, tickerId: ticker.id });
  });

  it("a close with a related position runs the close gate and NOT the limits or the delta band", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "close-1", request_type: "close_position", payload: putOpenPayload(ticker.symbol), related_position_id: "position-9" });
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledTimes(1);
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledWith("position-9");
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
    expect(subscribeToPooledQuoteMock).not.toHaveBeenCalled();
    expect(result.limits).toBeNull();
    expect(result.deltaBand).toBeNull();
    expect(result.closeGate).toEqual({ blocked: false, reason: null, cycleTotal: 12.5 });
    expect(result.blocks).toEqual([]);
  });

  it("a blocked close gate refuses the close with its reason", async () => {
    evaluateCloseGateForPositionMock.mockResolvedValue({ blocked: true, reason: "Closing is blocked: the market is closed.", cycleTotal: null });
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "close-2", request_type: "close_position", payload: putOpenPayload(ticker.symbol), related_position_id: "position-9" });
    expect(result.blocks).toEqual(["Closing is blocked: the market is closed."]);
  });

  it("a close without a related position runs nothing but the trading gate", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "close-3", request_type: "close_position", payload: putOpenPayload(ticker.symbol), related_position_id: null });
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
    expect(result.closeGate).toBeNull();
    expect(result.blocks).toEqual([]);
  });

  it("an open does not run the close gate even when it carries a related position", async () => {
    const ticker = await createTicker();
    await evaluateOrderGates({ id: "open-1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol), related_position_id: "position-9" });
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });

  it("a roll runs the limits (with the strike it closes) but not the delta band", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "roll-1", request_type: "roll_leg", payload: putRollPayload(ticker.symbol), related_position_id: "position-3" });
    expect(evaluateOrderLimitsMock).toHaveBeenCalledTimes(1);
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).toMatchObject({ symbol: ticker.symbol, strike: 90, rollFromStrike: 85, quantity: 2, excludeOrderRequestId: "roll-1" });
    expect(subscribeToPooledQuoteMock).not.toHaveBeenCalled();
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
    expect(result.deltaBand).toBeNull();
    expect(result.limits).toEqual(clearLimits);
  });
});

describe("evaluateOrderGates: verdicts become blocks", () => {
  it("fails closed on a ticker the platform does not know, without calling the limit evaluator", async () => {
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload("NOSUCHTICKERZZ") });
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
    expect(result.limits).toEqual({ blocked: true, reasons: ["Could not verify position limits: NOSUCHTICKERZZ is not a known ticker."] });
    expect(result.blocks).toEqual(["Could not verify position limits: NOSUCHTICKERZZ is not a known ticker."]);
  });

  it("puts the trading-gate reason first, then the limit reasons, then the delta band", async () => {
    const ticker = await createTicker();
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: the trading worker is offline.");
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big", "too concentrated"] });
    subscribeToPooledQuoteMock.mockImplementation(async (_contract: unknown, onUpdate: (quote: { delta: number | null }) => void) => {
      onUpdate({ delta: -0.5 });
      return () => {};
    });
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(result.tradingBlockedReason).toBe("Trading is blocked: the trading worker is offline.");
    expect(result.blocks).toEqual([
      "Trading is blocked: the trading worker is offline.",
      "too big",
      "too concentrated",
      "Delta has drifted to 0.50, above the 0.2–0.3 delta band.",
    ]);
  });

  it("a delta that cannot be read blocks an open (fail closed)", async () => {
    const ticker = await createTicker();
    subscribeToPooledQuoteMock.mockRejectedValue(new Error("no lines"));
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(result.blocks).toEqual(["Live delta could not be read (no lines) — can't verify this trade against the delta band."]);
  });

  it("only the trading gate blocking still refuses a close that its own gate allows", async () => {
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: wrong account.");
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "c1", request_type: "close_position", payload: putOpenPayload(ticker.symbol), related_position_id: "p1" });
    expect(result.blocks).toEqual(["Trading is blocked: wrong account."]);
    expect(result.closeGate?.blocked).toBe(false);
  });

  it("limits that pass, a clear trading gate and an in-band delta produce no blocks", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(result.blocks).toEqual([]);
    expect(result.tradingBlockedReason).toBeNull();
  });
});

describe("evaluateOrderGates: warnings", () => {
  it("carries the calendar events as a warning and never as a block", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({
      id: "o1",
      request_type: "open_cash_secured_put",
      payload: putOpenPayload(ticker.symbol),
      calendar_warning_events: [{ title: "FOMC Rate Decision", eventDate: "2026-11-04" }],
    });
    expect(result.warnings).toEqual(["1 economic event before expiry: 2026-11-04 FOMC Rate Decision."]);
    expect(result.blocks).toEqual([]);
  });

  it("falls back to the one-line stored warning, and has no warnings without either", async () => {
    const ticker = await createTicker();
    const withText = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol), calendar_warning: "Earnings on 2026-11-05." });
    expect(withText.warnings).toEqual(["Earnings on 2026-11-05."]);
    const none = await evaluateOrderGates({ id: "o2", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(none.warnings).toEqual([]);
  });

  it("keeps the warnings next to the blocks when the order is also blocked", async () => {
    const ticker = await createTicker();
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] });
    const result = await evaluateOrderGates({
      id: "o1",
      request_type: "open_cash_secured_put",
      payload: putOpenPayload(ticker.symbol),
      calendar_warning_events: [{ title: "CPI", eventDate: "2026-11-12" }, { title: "NFP", eventDate: "2026-11-06" }],
    });
    expect(result.blocks).toEqual(["too big"]);
    expect(result.warnings).toEqual(["2 economic events before expiry: 2026-11-12 CPI; 2026-11-06 NFP."]);
  });
});

describe("evaluateOrderGates: concurrency and result shape", () => {
  const delayed = <T>(value: T, delayMs: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));

  it("loses no verdict when the four evaluations finish in the opposite order they started", async () => {
    const ticker = await createTicker();
    fetchTradingBlockedReasonMock.mockImplementation(() => delayed("Trading is blocked: slow.", 40));
    evaluateOrderLimitsMock.mockImplementation(() => delayed({ blocked: true, reasons: ["limit reason"] }, 5));
    subscribeToPooledQuoteMock.mockImplementation(async (_contract: unknown, onUpdate: (quote: { delta: number | null }) => void) => {
      setTimeout(() => onUpdate({ delta: -0.9 }), 15);
      return () => {};
    });
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(result.blocks).toEqual(["Trading is blocked: slow.", "limit reason", "Delta has drifted to 0.90, above the 0.2–0.3 delta band."]);

    evaluateCloseGateForPositionMock.mockImplementation(() => delayed({ blocked: true, reason: "close reason", cycleTotal: null }, 25));
    const close = await evaluateOrderGates({ id: "c1", request_type: "close_position", payload: putOpenPayload(ticker.symbol), related_position_id: "p1" });
    expect(close.blocks).toEqual(["Trading is blocked: slow.", "close reason"]);
  });

  it("starts every evaluation at once rather than one after the other", async () => {
    const ticker = await createTicker();
    const started: string[] = [];
    fetchTradingBlockedReasonMock.mockImplementation(async () => {
      started.push("trading");
      return delayed(null, 20);
    });
    evaluateOrderLimitsMock.mockImplementation(async () => {
      started.push("limits");
      return delayed(clearLimits, 20);
    });
    subscribeToPooledQuoteMock.mockImplementation(async (_contract: unknown, onUpdate: (quote: { delta: number | null }) => void) => {
      started.push("delta");
      onUpdate({ delta: -0.25 });
      return () => {};
    });
    const startedAt = Date.now();
    await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    expect(started.sort()).toEqual(["delta", "limits", "trading"]);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("two orders evaluated at the same time each get their own verdict", async () => {
    const first = await createTicker();
    const second = await createTicker();
    evaluateOrderLimitsMock.mockImplementation(async (input: { symbol: string }) => delayed(input.symbol === first.symbol ? { blocked: true, reasons: [`${input.symbol} blocked`] } : clearLimits, input.symbol === first.symbol ? 20 : 2));
    const [firstResult, secondResult] = await Promise.all([
      evaluateOrderGates({ id: "o-first", request_type: "open_cash_secured_put", payload: putOpenPayload(first.symbol) }),
      evaluateOrderGates({ id: "o-second", request_type: "open_cash_secured_put", payload: putOpenPayload(second.symbol) }),
    ]);
    expect(firstResult.blocks).toEqual([`${first.symbol} blocked`]);
    expect(secondResult.blocks).toEqual([]);
  });

  it("returns evaluatedAt as the ISO time of the evaluation", async () => {
    const ticker = await createTicker();
    const before = Date.now();
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    const after = Date.now();
    expect(result.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(result.evaluatedAt).toISOString()).toBe(result.evaluatedAt);
    expect(new Date(result.evaluatedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(result.evaluatedAt).getTime()).toBeLessThanOrEqual(after);
  });

  it("the result is JSON-serialisable with every verdict (this is what is stored as gate_evaluation)", async () => {
    const ticker = await createTicker();
    const result = await evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) });
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(Object.keys(roundTripped).sort()).toEqual(["blocks", "closeGate", "deltaBand", "evaluatedAt", "limits", "tradingBlockedReason", "warnings"]);
  });

  it("propagates a failure of the trading-gate lookup instead of returning a verdict, so nothing can be confirmed on it", async () => {
    const ticker = await createTicker();
    fetchTradingBlockedReasonMock.mockRejectedValue(new Error("worker_health unreadable"));
    await expect(evaluateOrderGates({ id: "o1", request_type: "open_cash_secured_put", payload: putOpenPayload(ticker.symbol) })).rejects.toThrow("worker_health unreadable");
  });
});
