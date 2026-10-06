import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeLegSuccessProbabilities, type SuccessProbabilityLeg } from "./positionSuccessProbability.js";
import { computeSuccessProbability } from "./blackScholesPop.js";

const shortPut: SuccessProbabilityLeg = { side: "short", optionType: "put", strike: 100, expiryIsoDate: "2026-10-16", stockCostBasisPerShare: null };
const shortCall: SuccessProbabilityLeg = { side: "short", optionType: "call", strike: 100, expiryIsoDate: "2026-10-16", stockCostBasisPerShare: null };

const fullGreeks = { delta: -0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 105 };

describe("computeLegSuccessProbabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-10-06 15:00 UTC is 11:00 Eastern: 10 whole days before 2026-10-16.
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns no probability for a long leg", () => {
    expect(computeLegSuccessProbabilities({ ...shortPut, side: "long" }, fullGreeks, 0.04)).toEqual({ probabilityByDelta: null, probabilityByD2: null });
  });

  it("uses 1 - |delta| for a short put and |delta| for a short call", () => {
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, delta: -0.3 }, null).probabilityByDelta).toBeCloseTo(0.7, 10);
    expect(computeLegSuccessProbabilities(shortCall, { ...fullGreeks, delta: 0.3 }, null).probabilityByDelta).toBeCloseTo(0.3, 10);
  });

  it("treats the sign of the delta as irrelevant", () => {
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, delta: 0.3 }, null).probabilityByDelta).toBeCloseTo(0.7, 10);
    expect(computeLegSuccessProbabilities(shortCall, { ...fullGreeks, delta: -0.3 }, null).probabilityByDelta).toBeCloseTo(0.3, 10);
  });

  it("has a null delta probability when the delta is null, and a zero delta is a real value", () => {
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, delta: null }, 0.04).probabilityByDelta).toBeNull();
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, delta: 0 }, 0.04).probabilityByDelta).toBe(1);
  });

  it("computes P(d2) for a put against the strike with whole Eastern days to expiry", () => {
    const expected = computeSuccessProbability({ spotPrice: 105, thresholdPrice: 100, impliedVolatility: 0.4, daysToExpiry: 10, riskFreeRate: 0.04 });
    expect(expected).not.toBeNull();
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, 0.04).probabilityByD2).toBe(expected);
  });

  it("uses the higher of strike and stock cost basis as the call threshold", () => {
    const aboveStrike = computeLegSuccessProbabilities({ ...shortCall, stockCostBasisPerShare: 110 }, fullGreeks, 0.04).probabilityByD2;
    expect(aboveStrike).toBe(computeSuccessProbability({ spotPrice: 105, thresholdPrice: 110, impliedVolatility: 0.4, daysToExpiry: 10, riskFreeRate: 0.04 }));

    const belowStrike = computeLegSuccessProbabilities({ ...shortCall, stockCostBasisPerShare: 90 }, fullGreeks, 0.04).probabilityByD2;
    expect(belowStrike).toBe(computeSuccessProbability({ spotPrice: 105, thresholdPrice: 100, impliedVolatility: 0.4, daysToExpiry: 10, riskFreeRate: 0.04 }));

    const noCostBasis = computeLegSuccessProbabilities(shortCall, fullGreeks, 0.04).probabilityByD2;
    expect(noCostBasis).toBe(belowStrike);
  });

  it("ignores the stock cost basis for a put", () => {
    const withCostBasis = computeLegSuccessProbabilities({ ...shortPut, stockCostBasisPerShare: 150 }, fullGreeks, 0.04).probabilityByD2;
    expect(withCostBasis).toBe(computeLegSuccessProbabilities(shortPut, fullGreeks, 0.04).probabilityByD2);
  });

  it("has no P(d2) without a risk-free rate, implied volatility or underlying price, but keeps P(delta)", () => {
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, null)).toMatchObject({ probabilityByDelta: 0.7, probabilityByD2: null });
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, impliedVolatility: null }, 0.04).probabilityByD2).toBeNull();
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, impliedVolatility: undefined }, 0.04).probabilityByD2).toBeNull();
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, underlyingPrice: null }, 0.04).probabilityByD2).toBeNull();
    expect(computeLegSuccessProbabilities(shortPut, { ...fullGreeks, underlyingPrice: 0 }, 0.04).probabilityByD2).toBeNull();
  });

  it("accepts a zero risk-free rate", () => {
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, 0).probabilityByD2).not.toBeNull();
  });

  it("has no P(d2) on or after the expiry date, and counts the expiry day itself as zero days", () => {
    vi.setSystemTime(new Date("2026-10-16T15:00:00Z"));
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, 0.04).probabilityByD2).toBeNull();
    vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, 0.04).probabilityByD2).toBeNull();
  });

  it("takes today from the Eastern calendar, not UTC", () => {
    // 2026-10-16 02:00 UTC is still 2026-10-15 22:00 Eastern: one day to expiry, not zero.
    vi.setSystemTime(new Date("2026-10-16T02:00:00Z"));
    const expected = computeSuccessProbability({ spotPrice: 105, thresholdPrice: 100, impliedVolatility: 0.4, daysToExpiry: 1, riskFreeRate: 0.04 });
    expect(computeLegSuccessProbabilities(shortPut, fullGreeks, 0.04).probabilityByD2).toBe(expected);
  });
});
