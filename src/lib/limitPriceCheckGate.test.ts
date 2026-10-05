import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// The confirm-time limit-price check with the quote pool and the settings replaced: which contracts it subscribes, what it makes of
// the quotes that arrive, and that it always lets go of its lines.
const subscribeToPooledQuoteMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: (...args: unknown[]) => subscribeToPooledQuoteMock(...args),
  waitForFirstReading: (isComplete: () => boolean) => {
    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const timer = setTimeout(resolveSettled, 30);
    const check = () => {
      if (!isComplete()) return;
      clearTimeout(timer);
      resolveSettled();
    };
    return { settled, check };
  },
}));
const loadPriceCheckToleranceMock = vi.fn();
vi.mock("./tradingSettingsStore.js", () => ({ loadPriceCheckTolerance: (...args: unknown[]) => loadPriceCheckToleranceMock(...args) }));

const { evaluateLimitPriceCheckForOrderRequest } = await import("./limitPriceCheckGate.js");

const putOpen = { symbol: "AAOI", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "AAOI", quantity: 2, unitPrice: 1.35, strike: 50, expiry: "20261016", right: "P" }] } as OrderRequestPayload;
const buyWrite = {
  symbol: "AAOI",
  strategyKey: "covered_call",
  legs: [
    { role: "stock", action: "BUY", symbol: "AAOI", quantity: 200, unitPrice: 48.2 },
    { role: "option", action: "SELL", symbol: "AAOI", quantity: 2, unitPrice: 1.1, strike: 55, expiry: "20261016", right: "C" },
  ],
} as OrderRequestPayload;

/** Feeds each subscribed contract a quote chosen by its leg type. */
function feedQuotes(quoteFor: (contract: { legType: string }) => { bid: number | null; ask: number | null } | null, unsubscribe = vi.fn()) {
  subscribeToPooledQuoteMock.mockImplementation(async (contract: { legType: string }, onUpdate: (quote: unknown) => void) => {
    const quote = quoteFor(contract);
    if (quote) onUpdate({ ...quote, last: null, delta: null });
    return unsubscribe;
  });
  return unsubscribe;
}

beforeEach(() => {
  subscribeToPooledQuoteMock.mockReset();
  loadPriceCheckToleranceMock.mockReset().mockResolvedValue({ maxDeviationPct: 10, minToleranceDollars: 0.05 });
});

describe("evaluateLimitPriceCheckForOrderRequest", () => {
  it("passes a limit near the live mid and records the quote it saw", async () => {
    feedQuotes(() => ({ bid: 1.3, ask: 1.4 }));
    const result = await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen });
    expect(result).toMatchObject({ blocked: false, reasons: [] });
    expect(result!.legs[0]).toMatchObject({ bid: 1.3, ask: 1.4, ok: true });
  });

  it("refuses a limit far below the mid and names the leg", async () => {
    feedQuotes(() => ({ bid: 3.9, ask: 4.1 }));
    const result = await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen });
    expect(result!.blocked).toBe(true);
    expect(result!.reasons[0]).toContain("SELL 2 AAOI 2026-10-16 $50 put");
    expect(result!.reasons[0]).toContain("below the live mid 4.00");
  });

  it("subscribes one pooled contract per leg: stock as stock, option with its strike, expiry and right", async () => {
    feedQuotes(() => ({ bid: 1, ask: 1.1 }));
    await evaluateLimitPriceCheckForOrderRequest({ payload: buyWrite });
    const contracts = subscribeToPooledQuoteMock.mock.calls.map((call) => call[0]);
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toMatchObject({ legType: "stock", symbol: "AAOI" });
    expect(contracts[1]).toMatchObject({ legType: "option", symbol: "AAOI", expiry: "20261016", strike: 55 });
    expect(contracts[0].key).not.toBe(contracts[1].key);
  });

  it("judges each leg of a buy-write on its own quote", async () => {
    feedQuotes((contract) => (contract.legType === "stock" ? { bid: 48.15, ask: 48.25 } : { bid: 4.9, ask: 5.1 }));
    const result = await evaluateLimitPriceCheckForOrderRequest({ payload: buyWrite });
    expect(result!.legs.map((leg) => leg.ok)).toEqual([true, false]);
    expect(result!.blocked).toBe(true);
  });

  it("refuses when a quote never arrives (fail closed), and when only one side does", async () => {
    feedQuotes(() => null);
    const none = await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen });
    expect(none!.blocked).toBe(true);
    expect(none!.reasons[0]).toContain("No live two-sided quote");
    feedQuotes(() => ({ bid: 1.3, ask: null }));
    expect((await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen }))!.reasons[0]).toContain("No live two-sided quote");
  });

  it("uses the tolerance from the settings", async () => {
    feedQuotes(() => ({ bid: 1.95, ask: 2.05 }));
    const order = { payload: { ...putOpen, legs: [{ ...putOpen.legs[0]!, unitPrice: 1.5 }] } as OrderRequestPayload };
    expect((await evaluateLimitPriceCheckForOrderRequest(order))!.blocked).toBe(true); // 0.50 below a 2.00 mid, 10% allows 0.20
    loadPriceCheckToleranceMock.mockResolvedValue({ maxDeviationPct: 30, minToleranceDollars: 0.05 });
    expect((await evaluateLimitPriceCheckForOrderRequest(order))!.blocked).toBe(false); // 30% allows 0.60
  });

  it("fails closed when the pool or the settings throw, saying the prices could not be checked", async () => {
    subscribeToPooledQuoteMock.mockRejectedValue(new Error("market data lines are disabled"));
    const poolDown = await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen });
    expect(poolDown).toEqual({ blocked: true, reasons: ["The limit prices could not be checked against live quotes (market data lines are disabled)."], legs: [] });
    loadPriceCheckToleranceMock.mockRejectedValue(new Error("No trading_settings row found."));
    expect((await evaluateLimitPriceCheckForOrderRequest({ payload: putOpen }))!.reasons[0]).toContain("No trading_settings row found.");
  });

  it("lets go of every line it took, also when a later subscription fails", async () => {
    const unsubscribe = vi.fn();
    subscribeToPooledQuoteMock.mockResolvedValueOnce(unsubscribe).mockRejectedValueOnce(new Error("no more lines"));
    const result = await evaluateLimitPriceCheckForOrderRequest({ payload: buyWrite });
    expect(result!.blocked).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const released = feedQuotes(() => ({ bid: 1.3, ask: 1.4 }));
    await evaluateLimitPriceCheckForOrderRequest({ payload: buyWrite });
    expect(released).toHaveBeenCalledTimes(2);
  });

  it("has nothing to check for an order without legs", async () => {
    expect(await evaluateLimitPriceCheckForOrderRequest({ payload: { ...putOpen, legs: [] } as OrderRequestPayload })).toBeNull();
    expect(subscribeToPooledQuoteMock).not.toHaveBeenCalled();
  });
});
