import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionType } from "@stoqey/ib";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// The pool boundary is mocked; waitForFirstReading is re-implemented here with the same contract as the real one
// (resolve when the caller says the reading is complete, or after the settle grace) so fake timers can drive the grace.
const settleGraceMs = 3_000;
const subscribeToPooledQuoteMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: (...args: unknown[]) => subscribeToPooledQuoteMock(...args),
  waitForFirstReading: (isComplete: () => boolean) => {
    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const timer = setTimeout(resolveSettled, 3_000);
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

const { evaluateDeltaBandForOrderRequest, isDeltaBandGated } = await import("./deltaBandGate.js");

type Quote = { delta: number | null };

const optionLeg = { role: "option", action: "SELL", symbol: "AAA", quantity: 1, unitPrice: 1.2, strike: 90, expiry: "20261120", right: "P" } as const;
const stockLeg = { role: "stock", action: "BUY", symbol: "AAA", quantity: 100, unitPrice: 95 } as const;

const putOpen = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [optionLeg] } as unknown as OrderRequestPayload;
const callOpen = { symbol: "AAA", strategyKey: "covered_call", legs: [stockLeg, { ...optionLeg, right: "C", strike: 110 }] } as unknown as OrderRequestPayload;

/** A pooled quote feed that emits the given quotes (synchronously inside subscribe when `synchronous`), and records the release. */
function installFeed(quotes: Quote[], options: { synchronous?: boolean } = {}) {
  const unsubscribe = vi.fn();
  subscribeToPooledQuoteMock.mockImplementation(async (_contract: unknown, onUpdate: (quote: Quote) => void) => {
    if (options.synchronous) quotes.forEach(onUpdate);
    else queueMicrotask(() => quotes.forEach(onUpdate));
    return unsubscribe;
  });
  return unsubscribe;
}

beforeEach(() => {
  vi.useFakeTimers();
  subscribeToPooledQuoteMock.mockReset();
  loadRecoveryTargetWindowMock.mockReset().mockResolvedValue({ deltaTargetMin: 0.2, deltaTargetMax: 0.3, dteTargetMin: 30, dteTargetMax: 45 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isDeltaBandGated", () => {
  it("gates the opening request types that have a strategy and a complete option leg", () => {
    expect(isDeltaBandGated({ request_type: "open_cash_secured_put", payload: putOpen })).toBe(true);
    expect(isDeltaBandGated({ request_type: "open_covered_call", payload: callOpen })).toBe(true);
  });

  it("does not gate a roll or a close, nor any request type that is not an open", () => {
    expect(isDeltaBandGated({ request_type: "roll_leg", payload: putOpen })).toBe(false);
    expect(isDeltaBandGated({ request_type: "close_position", payload: putOpen })).toBe(false);
    expect(isDeltaBandGated({ request_type: "recovery_path", payload: putOpen })).toBe(false);
    expect(isDeltaBandGated({ request_type: "", payload: putOpen })).toBe(false);
  });

  it("does not gate an order with no strategy key", () => {
    expect(isDeltaBandGated({ request_type: "open_cash_secured_put", payload: { ...putOpen, strategyKey: undefined } as unknown as OrderRequestPayload })).toBe(false);
    expect(isDeltaBandGated({ request_type: "open_cash_secured_put", payload: { ...putOpen, strategyKey: "" } })).toBe(false);
  });

  it("does not gate an order whose option leg is missing a strike, an expiry or a right, or that has no option leg", () => {
    const withLeg = (leg: Record<string, unknown>) => ({ request_type: "open_cash_secured_put", payload: { ...putOpen, legs: [leg] } as unknown as OrderRequestPayload });
    expect(isDeltaBandGated(withLeg({ ...optionLeg, strike: undefined }))).toBe(false);
    expect(isDeltaBandGated(withLeg({ ...optionLeg, strike: 0 }))).toBe(false);
    expect(isDeltaBandGated(withLeg({ ...optionLeg, expiry: undefined }))).toBe(false);
    expect(isDeltaBandGated(withLeg({ ...optionLeg, expiry: "" }))).toBe(false);
    expect(isDeltaBandGated(withLeg({ ...optionLeg, right: undefined }))).toBe(false);
    expect(isDeltaBandGated({ request_type: "open_covered_call", payload: { ...callOpen, legs: [stockLeg] } as unknown as OrderRequestPayload })).toBe(false);
    expect(isDeltaBandGated({ request_type: "open_covered_call", payload: { ...callOpen, legs: [] } as unknown as OrderRequestPayload })).toBe(false);
  });
});

describe("evaluateDeltaBandForOrderRequest: orders that are not gated", () => {
  it("returns null for a close and a roll without reading the band or subscribing", async () => {
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "close_position", payload: putOpen })).toBeNull();
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "roll_leg", payload: putOpen })).toBeNull();
    expect(subscribeToPooledQuoteMock).not.toHaveBeenCalled();
    expect(loadRecoveryTargetWindowMock).not.toHaveBeenCalled();
  });
});

describe("evaluateDeltaBandForOrderRequest: the verdict against the band", () => {
  it("passes a put whose live delta magnitude is inside the band (negative put delta uses its magnitude)", async () => {
    const unsubscribe = installFeed([{ delta: -0.25 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({ compliant: true, reason: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("passes a call whose positive delta is inside the band", async () => {
    const unsubscribe = installFeed([{ delta: 0.25 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_covered_call", payload: callOpen })).toEqual({ compliant: true, reason: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("blocks a delta below the minimum and says the band", async () => {
    const unsubscribe = installFeed([{ delta: -0.19 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      compliant: false,
      reason: "Delta has drifted to 0.19, below the 0.2–0.3 delta band.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("blocks a delta above the maximum and says the band", async () => {
    const unsubscribe = installFeed([{ delta: -0.31 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      compliant: false,
      reason: "Delta has drifted to 0.31, above the 0.2–0.3 delta band.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("treats both bounds as inclusive, for puts and calls", async () => {
    for (const delta of [0.2, 0.3, -0.2, -0.3]) {
      installFeed([{ delta }]);
      const payload = delta < 0 ? putOpen : callOpen;
      const requestType = delta < 0 ? "open_cash_secured_put" : "open_covered_call";
      expect(await evaluateDeltaBandForOrderRequest({ request_type: requestType, payload })).toEqual({ compliant: true, reason: null });
    }
  });

  it("a band whose min equals its max passes exactly that delta and nothing else", async () => {
    loadRecoveryTargetWindowMock.mockResolvedValue({ deltaTargetMin: 0.25, deltaTargetMax: 0.25, dteTargetMin: 1, dteTargetMax: 2 });
    installFeed([{ delta: -0.25 }]);
    expect((await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen }))!.compliant).toBe(true);
    installFeed([{ delta: -0.2501 }]);
    expect((await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen }))!.compliant).toBe(false);
    installFeed([{ delta: -0.2499 }]);
    expect((await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen }))!.compliant).toBe(false);
  });

  it("a delta of exactly 0 is a real reading (not 'missing'): it is out of a 0.2 floor but inside a 0 floor", async () => {
    installFeed([{ delta: 0 }]);
    const outside = await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    expect(outside).toEqual({ compliant: false, reason: "Delta has drifted to 0.00, below the 0.2–0.3 delta band." });
    loadRecoveryTargetWindowMock.mockResolvedValue({ deltaTargetMin: 0, deltaTargetMax: 0.3, dteTargetMin: 1, dteTargetMax: 2 });
    installFeed([{ delta: 0 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({ compliant: true, reason: null });
  });

  it("reads the band from trading settings on every evaluation", async () => {
    installFeed([{ delta: -0.25 }]);
    expect((await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen }))!.compliant).toBe(true);
    loadRecoveryTargetWindowMock.mockResolvedValue({ deltaTargetMin: 0.3, deltaTargetMax: 0.4, dteTargetMin: 1, dteTargetMax: 2 });
    installFeed([{ delta: -0.25 }]);
    const tighter = await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    expect(tighter).toEqual({ compliant: false, reason: "Delta has drifted to 0.25, below the 0.3–0.4 delta band." });
    expect(loadRecoveryTargetWindowMock).toHaveBeenCalledTimes(2);
  });
});

describe("evaluateDeltaBandForOrderRequest: the live subscription", () => {
  it("subscribes the option leg itself: symbol, expiry, strike and the right as an IBKR option type", async () => {
    installFeed([{ delta: -0.25 }]);
    await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    expect(subscribeToPooledQuoteMock).toHaveBeenCalledTimes(1);
    expect(subscribeToPooledQuoteMock.mock.calls[0]![0]).toEqual({ key: "delta-band", legType: "option", symbol: "AAA", expiry: "20261120", strike: 90, right: OptionType.Put });

    installFeed([{ delta: 0.25 }]);
    await evaluateDeltaBandForOrderRequest({ request_type: "open_covered_call", payload: callOpen });
    expect(subscribeToPooledQuoteMock.mock.calls[1]![0]).toEqual({ key: "delta-band", legType: "option", symbol: "AAA", expiry: "20261120", strike: 110, right: OptionType.Call });
  });

  it("uses the first quote that carries a delta, and ignores a later null", async () => {
    const unsubscribe = installFeed([{ delta: null }, { delta: -0.25 }, { delta: null }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({ compliant: true, reason: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("with several quotes delivered inside subscribe, the last reading is the one judged", async () => {
    const unsubscribe = installFeed([{ delta: -0.25 }, { delta: -0.5 }], { synchronous: true });
    // Both quotes arrive inside subscribe(), before the verdict is read: the second (out of band) is the reading.
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      compliant: false,
      reason: "Delta has drifted to 0.50, above the 0.2–0.3 delta band.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("handles a pool that replays the last reading synchronously inside subscribe", async () => {
    const unsubscribe = installFeed([{ delta: -0.22 }], { synchronous: true });
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({ compliant: true, reason: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed, after the settle grace, when no delta ever arrives, and still releases the subscription", async () => {
    const unsubscribe = installFeed([{ delta: null }]);
    const pending = evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    await vi.advanceTimersByTimeAsync(settleGraceMs - 1);
    expect(unsubscribe).not.toHaveBeenCalled(); // still waiting inside the grace
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ compliant: false, reason: "Live delta isn't available yet — can't verify this trade against the delta band." });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the pool never emits anything at all", async () => {
    const unsubscribe = installFeed([]);
    const pending = evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    await vi.advanceTimersByTimeAsync(settleGraceMs);
    expect((await pending)!.compliant).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed with the error text when the subscription throws", async () => {
    subscribeToPooledQuoteMock.mockRejectedValue(new Error("no market data lines left"));
    const result = await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    expect(result).toEqual({ compliant: false, reason: "Live delta could not be read (no market data lines left) — can't verify this trade against the delta band." });
  });

  it("fails closed when the subscription throws something that is not an Error", async () => {
    subscribeToPooledQuoteMock.mockRejectedValue("pool offline");
    const result = await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen });
    expect(result!.reason).toBe("Live delta could not be read (pool offline) — can't verify this trade against the delta band.");
  });
});

describe("evaluateDeltaBandForOrderRequest: no usable band", () => {
  it("blocks with 'No delta band is configured' when trading settings have no row, and still releases the subscription", async () => {
    loadRecoveryTargetWindowMock.mockResolvedValue(null);
    const unsubscribe = installFeed([{ delta: -0.25 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      compliant: false,
      reason: "No delta band is configured in the trading settings.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("blocks the same way when reading the band throws", async () => {
    loadRecoveryTargetWindowMock.mockRejectedValue(new Error("db down"));
    const unsubscribe = installFeed([{ delta: -0.25 }]);
    expect(await evaluateDeltaBandForOrderRequest({ request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      compliant: false,
      reason: "No delta band is configured in the trading settings.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
