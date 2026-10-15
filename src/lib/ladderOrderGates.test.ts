import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { evaluateLadderDeltaForOrderRequest, ladderDeltaVerdict, type LadderOrderGateContext } from "./ladderOrderGates.js";

const context: LadderOrderGateContext = { potFraction: 0.25, minAbsDelta: 0.05, maxAbsDelta: 0.3, forwardAnchor: { forward: 100.3, spotPrice: 100 }, riskFreeRate: 0.04, todayIso: "2026-10-20", closeMinutesEt: 16 * 60 };
const now = new Date("2026-10-20T15:00:00Z");
const expiryIso = "2026-11-20";
const years = yearsBetweenIsoDates(context.todayIso, expiryIso);

/** A Put quoted at 50% IV with the stock at 102: the forward is Pluto's 100.30 moved to 102 (102.306). */
function putQuote(strike: number) {
  const forward = 100.3 * 1.02;
  const mid = blackScholesPriceOnForward(forward, strike, years, 0.04, 0.5, false);
  return { bid: mid - 0.01, ask: mid + 0.01, delta: Math.abs(blackScholesDelta(forward, strike, years, 0.04, 0.5, false)) };
}

describe("ladderDeltaVerdict", () => {
  it("checks the contract's own delta (the mid's IV on Pluto's forward moved to the live price) against the ladder's range", () => {
    const inRange = putQuote(90);
    const verdict = ladderDeltaVerdict({ bid: inRange.bid, ask: inRange.ask, stockPrice: 102, strike: 90, expiryIso, isCall: false, now, context });
    expect(verdict.compliant).toBe(true);
    expect(Math.abs(verdict.delta!)).toBeCloseTo(inRange.delta, 3);
  });

  it("refuses outside the range with no tolerance: 0.305 against 0.30 is out", () => {
    const tight = { ...context, maxAbsDelta: 0.3 };
    const atTheMoney = putQuote(100);
    expect(atTheMoney.delta).toBeGreaterThan(0.3);
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 100, expiryIso, isCall: false, now, context: tight }).reason).toMatch(/above the ladder's 0.05–0.3 delta range/);
    // The same contract with the range's top set 0.005 under its delta is refused; set at its delta, accepted.
    const ownDelta = ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 100, expiryIso, isCall: false, now, context: { ...context, maxAbsDelta: 1 } }).delta!;
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 100, expiryIso, isCall: false, now, context: { ...context, maxAbsDelta: Math.abs(ownDelta) - 0.005 } }).compliant).toBe(false);
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 100, expiryIso, isCall: false, now, context: { ...context, maxAbsDelta: Math.abs(ownDelta) + 1e-9 } }).compliant).toBe(true);
    const farOut = putQuote(75);
    expect(farOut.delta).toBeLessThan(0.05);
    expect(farOut.bid).toBeGreaterThan(0);
    expect(ladderDeltaVerdict({ bid: farOut.bid, ask: farOut.ask, stockPrice: 102, strike: 75, expiryIso, isCall: false, now, context }).reason).toMatch(/below the ladder's/);
  });

  it("fails closed without a two-sided quote or a stock price", () => {
    expect(ladderDeltaVerdict({ bid: null, ask: 1, stockPrice: 102, strike: 90, expiryIso, isCall: false, now, context })).toMatchObject({ compliant: false, reason: expect.stringMatching(/can't be worked out from its live quote/) });
    expect(ladderDeltaVerdict({ bid: 1, ask: 1.1, stockPrice: null, strike: 90, expiryIso, isCall: false, now, context })).toMatchObject({ compliant: false, reason: expect.stringMatching(/No live stock price/) });
  });
});

describe("evaluateLadderDeltaForOrderRequest", () => {
  const quote = putQuote(90);
  const reader = { optionQuote: async () => ({ bid: quote.bid, ask: quote.ask }), stockPrice: async () => 102, now: () => now };
  const order = (requestType: string) => ({ request_type: requestType, payload: { symbol: "LADR", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "LADR", quantity: 2, unitPrice: 1.2, strike: 90, expiry: "20261120", right: "P" }] } as OrderRequestPayload });

  it("judges an opening order's option leg on its live quote; a close or roll is not delta-checked", async () => {
    expect(await evaluateLadderDeltaForOrderRequest(order("open_cash_secured_put"), context, reader)).toEqual({ compliant: true, reason: null });
    expect(await evaluateLadderDeltaForOrderRequest(order("close_position"), context, reader)).toBeNull();
  });

  it("fails closed when the live quote cannot be read", async () => {
    const failing = { ...reader, optionQuote: async () => Promise.reject(new Error("no market data line")) };
    expect(await evaluateLadderDeltaForOrderRequest(order("open_cash_secured_put"), context, failing)).toEqual({ compliant: false, reason: "The live quote could not be read (no market data line), so the ladder's 0.05–0.3 delta range can't be verified." });
  });
});
