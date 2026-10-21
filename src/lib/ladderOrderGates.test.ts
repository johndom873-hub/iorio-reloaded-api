import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { evaluateLadderDeltaForOrderRequest, ladderDeltaVerdict, type LadderOrderGateContext } from "./ladderOrderGates.js";

const context: LadderOrderGateContext = { potFraction: 0.25, book: { symbols: ["AAA"], budgetFraction: 0.5 }, isEntryPut: false, minAbsDelta: 0.05, maxAbsDelta: 0.3, forwardAnchor: { forward: 100.3, spotPrice: 100 }, riskFreeRate: 0.04, todayIso: "2026-10-20", closeMinutesEt: 16 * 60 };
const now = new Date("2026-10-20T15:00:00Z");
const expiryIso = "2026-11-20";
const years = yearsBetweenIsoDates(context.todayIso, expiryIso);

/** A contract quoted at 50% IV with the stock at 102: the forward is Pluto's 100.30 moved to 102 (102.306). */
function quoteOf(strike: number, isCall: boolean) {
  const forward = 100.3 * 1.02;
  const mid = blackScholesPriceOnForward(forward, strike, years, 0.04, 0.5, isCall);
  return { bid: mid - 0.01, ask: mid + 0.01, delta: Math.abs(blackScholesDelta(forward, strike, years, 0.04, 0.5, isCall)) };
}
const putQuote = (strike: number) => quoteOf(strike, false);
const callQuote = (strike: number) => quoteOf(strike, true);

describe("ladderDeltaVerdict", () => {
  it("checks a Call's own delta (the mid's IV on Pluto's forward moved to the live price) against the ladder's range", () => {
    const inRange = callQuote(115);
    expect(inRange.delta).toBeGreaterThan(0.05);
    expect(inRange.delta).toBeLessThan(0.3);
    const verdict = ladderDeltaVerdict({ bid: inRange.bid, ask: inRange.ask, stockPrice: 102, strike: 115, expiryIso, isCall: true, now, context });
    expect(verdict.compliant).toBe(true);
    expect(Math.abs(verdict.delta!)).toBeCloseTo(inRange.delta, 3);
  });

  it("refuses a Call outside the range with no tolerance: 0.305 against 0.30 is out", () => {
    const atTheMoney = callQuote(104);
    expect(atTheMoney.delta).toBeGreaterThan(0.3);
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 104, expiryIso, isCall: true, now, context }).reason).toMatch(/above the ladder's 0.05–0.3 delta range/);
    // The same contract with the range's top set 0.005 under its delta is refused; set at its delta, accepted.
    const ownDelta = ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 104, expiryIso, isCall: true, now, context: { ...context, maxAbsDelta: 1 } }).delta!;
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 104, expiryIso, isCall: true, now, context: { ...context, maxAbsDelta: Math.abs(ownDelta) - 0.005 } }).compliant).toBe(false);
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 104, expiryIso, isCall: true, now, context: { ...context, maxAbsDelta: Math.abs(ownDelta) + 1e-9 } }).compliant).toBe(true);
    const farOut = callQuote(135);
    expect(farOut.delta).toBeLessThan(0.05);
    expect(farOut.bid).toBeGreaterThan(0);
    expect(ladderDeltaVerdict({ bid: farOut.bid, ask: farOut.ask, stockPrice: 102, strike: 135, expiryIso, isCall: true, now, context }).reason).toMatch(/below the ladder's/);
  });

  it("passes the ladder's Puts at any |delta|, recording it (the |delta| range is the Calls')", () => {
    const atTheMoney = putQuote(100);
    const farOut = putQuote(75);
    expect(atTheMoney.delta).toBeGreaterThan(0.3);
    expect(farOut.delta).toBeLessThan(0.05);
    for (const [strike, quote] of [[100, atTheMoney], [75, farOut]] as const) {
      const verdict = ladderDeltaVerdict({ bid: quote.bid, ask: quote.ask, stockPrice: 102, strike, expiryIso, isCall: false, now, context });
      expect(verdict).toMatchObject({ compliant: true, reason: null });
      expect(Math.abs(verdict.delta!)).toBeCloseTo(quote.delta, 3);
    }
    // Without a quote or a stock price a Put still passes, its delta unknown.
    expect(ladderDeltaVerdict({ bid: null, ask: 1, stockPrice: 102, strike: 90, expiryIso, isCall: false, now, context })).toEqual({ compliant: true, delta: null, reason: null });
    expect(ladderDeltaVerdict({ bid: 1, ask: 1.1, stockPrice: null, strike: 90, expiryIso, isCall: false, now, context })).toEqual({ compliant: true, delta: null, reason: null });
  });

  it("holds a Cash-Secured Put entry to the range like a Call", () => {
    const atTheMoney = putQuote(100);
    const inRange = putQuote(90);
    expect(inRange.delta).toBeGreaterThan(0.05);
    expect(inRange.delta).toBeLessThan(0.3);
    expect(ladderDeltaVerdict({ bid: atTheMoney.bid, ask: atTheMoney.ask, stockPrice: 102, strike: 100, expiryIso, isCall: false, putHeldToRange: true, now, context }).reason).toMatch(/above the ladder's 0.05–0.3 delta range/);
    expect(ladderDeltaVerdict({ bid: inRange.bid, ask: inRange.ask, stockPrice: 102, strike: 90, expiryIso, isCall: false, putHeldToRange: true, now, context }).compliant).toBe(true);
    expect(ladderDeltaVerdict({ bid: 1, ask: 1.1, stockPrice: null, strike: 90, expiryIso, isCall: false, putHeldToRange: true, now, context })).toMatchObject({ compliant: false, reason: expect.stringMatching(/No live stock price/) });
  });

  it("fails closed for a Call without a two-sided quote or a stock price", () => {
    expect(ladderDeltaVerdict({ bid: null, ask: 1, stockPrice: 102, strike: 115, expiryIso, isCall: true, now, context })).toMatchObject({ compliant: false, reason: expect.stringMatching(/can't be worked out from its live quote/) });
    expect(ladderDeltaVerdict({ bid: 1, ask: 1.1, stockPrice: null, strike: 115, expiryIso, isCall: true, now, context })).toMatchObject({ compliant: false, reason: expect.stringMatching(/No live stock price/) });
  });
});

describe("evaluateLadderDeltaForOrderRequest", () => {
  const quote = callQuote(115);
  const reader = { optionQuote: async () => ({ bid: quote.bid, ask: quote.ask }), stockPrice: async () => 102, now: () => now };
  const failing = { ...reader, optionQuote: async () => Promise.reject(new Error("no market data line")) };
  const callOrder = (requestType: string) => ({ request_type: requestType, payload: { symbol: "LADR", strategyKey: "covered_call", legs: [{ role: "option", action: "SELL", symbol: "LADR", quantity: 2, unitPrice: 1.2, strike: 115, expiry: "20261120", right: "C" }] } as OrderRequestPayload });
  const putOrder = { request_type: "open_cash_secured_put", payload: { symbol: "LADR", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "LADR", quantity: 2, unitPrice: 1.2, strike: 75, expiry: "20261120", right: "P" }] } as OrderRequestPayload };

  it("judges an opening Call's leg on its live quote; a close or roll is not delta-checked", async () => {
    expect(await evaluateLadderDeltaForOrderRequest(callOrder("open_covered_call"), context, reader)).toEqual({ compliant: true, reason: null });
    expect(await evaluateLadderDeltaForOrderRequest(callOrder("close_position"), context, reader)).toBeNull();
  });

  it("passes an opening Put without reading a quote: the ladder's Puts have no |delta| range", async () => {
    expect(await evaluateLadderDeltaForOrderRequest(putOrder, context, failing)).toEqual({ compliant: true, reason: null });
  });

  it("reads the live quote of an entry Put and holds it to the range", async () => {
    const atTheMoney = putQuote(100);
    const entryPut = { ...putOrder, payload: { ...putOrder.payload, legs: [{ ...putOrder.payload.legs[0]!, strike: 100 }] } as OrderRequestPayload };
    const putReader = { ...reader, optionQuote: async () => ({ bid: atTheMoney.bid, ask: atTheMoney.ask }) };
    expect(await evaluateLadderDeltaForOrderRequest(entryPut, { ...context, isEntryPut: true }, putReader)).toMatchObject({ compliant: false, reason: expect.stringMatching(/above the ladder's 0.05–0.3 delta range/) });
    expect(await evaluateLadderDeltaForOrderRequest(entryPut, { ...context, isEntryPut: true }, failing)).toMatchObject({ compliant: false });
  });

  it("fails closed when a Call's live quote cannot be read", async () => {
    expect(await evaluateLadderDeltaForOrderRequest(callOrder("open_covered_call"), context, failing)).toEqual({ compliant: false, reason: "The live quote could not be read (no market data line), so the ladder's 0.05–0.3 delta range can't be verified." });
  });
});
