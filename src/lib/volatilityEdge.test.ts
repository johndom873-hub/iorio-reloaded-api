import { describe, expect, it } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { computeVolatilityEdge, expirySpansEarnings, selectRealizedVolatilityForecast, type EdgeSlice } from "./volatilityEdge.js";

// Deterministic synthetic bars: a slow random walk with a fixed seed.
function makeBars(count: number, dailyMove = 0.02, seed = 42): DailyOhlcvBar[] {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
  let close = 100;
  const start = Date.UTC(2025, 0, 2);
  return Array.from({ length: count }, (_, index) => {
    const open = close * (1 + random() * dailyMove * 0.5);
    close = open * (1 + random() * dailyMove * 2);
    const high = Math.max(open, close) * (1 + Math.abs(random()) * dailyMove * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(random()) * dailyMove * 0.5);
    return { tradingDate: new Date(start + index * 86_400_000).toISOString().slice(0, 10), open, high, low, close, volume: 1_000_000 };
  });
}

describe("selectRealizedVolatilityForecast", () => {
  it("uses the 63-day Yang-Zhang volatility when there is enough history", () => {
    const bars = makeBars(200);
    const expected = computeYangZhangVolatility(bars, 63);
    if (!expected.available) throw new Error("fixture must be fittable");
    expect(selectRealizedVolatilityForecast(bars)).toEqual({ forecast: { volatility: expected.annualizedVolatility, windowDays: 63 }, suspectedSplitDateIso: null });
  });

  it("needs 64 bars for the 63-day window: with 63 bars it falls back to the 21-day window", () => {
    expect(selectRealizedVolatilityForecast(makeBars(64)).forecast!.windowDays).toBe(63);
    const fallback = selectRealizedVolatilityForecast(makeBars(63)).forecast!;
    expect(fallback.windowDays).toBe(21);
    const expected = computeYangZhangVolatility(makeBars(63), 21);
    if (!expected.available) throw new Error("fixture must be fittable");
    expect(fallback.volatility).toBe(expected.annualizedVolatility);
  });

  it("returns no forecast (no Edge) with fewer than 22 bars, without blaming a split", () => {
    expect(selectRealizedVolatilityForecast(makeBars(22)).forecast!.windowDays).toBe(21);
    expect(selectRealizedVolatilityForecast(makeBars(21))).toEqual({ forecast: null, suspectedSplitDateIso: null });
    expect(selectRealizedVolatilityForecast([])).toEqual({ forecast: null, suspectedSplitDateIso: null });
  });

  it("falls back when the 63-day window contains a suspected split, and records the split day if the 21-day one does too", () => {
    const bars = makeBars(100);
    const splitAt = 60; // inside the last 63 but outside the last 21
    for (let index = splitAt; index < bars.length; index++) bars[index] = { ...bars[index]!, open: bars[index]!.open / 10, high: bars[index]!.high / 10, low: bars[index]!.low / 10, close: bars[index]!.close / 10, volume: 12_000_000 };
    expect(selectRealizedVolatilityForecast(bars)).toMatchObject({ forecast: { windowDays: 21 }, suspectedSplitDateIso: null });
    const recentSplit = makeBars(100);
    for (let index = 95; index < recentSplit.length; index++) recentSplit[index] = { ...recentSplit[index]!, open: recentSplit[index]!.open / 10, high: recentSplit[index]!.high / 10, low: recentSplit[index]!.low / 10, close: recentSplit[index]!.close / 10, volume: 12_000_000 };
    expect(selectRealizedVolatilityForecast(recentSplit)).toEqual({ forecast: null, suspectedSplitDateIso: recentSplit[95]!.tradingDate });
  });
});

describe("computeVolatilityEdge", () => {
  const parameters: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
  const slice: EdgeSlice = { status: "ok", parameters, kMin: -0.2, kMax: 0.2, yearsToExpiry: 30 / 365, forwardPrice: 100 };
  const forecast = { volatility: 0.4, windowDays: 63 as const };

  it("is the SVI implied volatility minus the forecast, in annualized volatility", () => {
    const edge = computeVolatilityEdge(slice, 105, forecast)!;
    const expectedIv = Math.sqrt(sviTotalVariance(parameters, Math.log(105 / 100)) / (30 / 365));
    expect(edge.impliedVolatility).toBeCloseTo(expectedIv, 12);
    expect(edge.edge).toBeCloseTo(expectedIv - 0.4, 12);
    expect(edge).toMatchObject({ forecastVolatility: 0.4, forecastWindowDays: 63, insideFittedRange: true });
  });

  it("is negative when the surface sits below the forecast", () => {
    expect(computeVolatilityEdge(slice, 100, { volatility: 5, windowDays: 63 })!.edge).toBeLessThan(0);
  });

  it("marks strikes outside the fitted log-moneyness range (inclusive at the ends)", () => {
    expect(computeVolatilityEdge(slice, 100 * Math.exp(0.2), forecast)!.insideFittedRange).toBe(true);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(-0.2), forecast)!.insideFittedRange).toBe(true);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(0.2001), forecast)!.insideFittedRange).toBe(false);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(-0.2001), forecast)!.insideFittedRange).toBe(false);
  });

  it("is unscored (null) without a forecast, for a flagged slice, or for bad inputs", () => {
    expect(computeVolatilityEdge(slice, 105, null)).toBeNull();
    for (const status of ["insufficient_points", "fit_failed", "poor_fit", "butterfly_arbitrage"] as const) expect(computeVolatilityEdge({ ...slice, status }, 105, forecast)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, parameters: null }, 105, forecast)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, kMin: null }, 105, forecast)).toBeNull();
    expect(computeVolatilityEdge(slice, 0, forecast)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, forwardPrice: 0 }, 105, forecast)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, yearsToExpiry: 0 }, 105, forecast)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, parameters: { a: -1, b: 0, rho: 0, m: 0, sigma: 0.1 } }, 105, forecast)).toBeNull();
  });
});

describe("expirySpansEarnings", () => {
  it("is true only when an earnings date is after the snapshot date and on or before the expiry", () => {
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-05"])).toBe(true);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-20"])).toBe(true); // on the expiry date
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-21"])).toBe(false); // after
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-09-21"])).toBe(false); // today's is already priced in
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-08-01"])).toBe(false);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", [])).toBe(false);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2027-01-01", "2026-10-01"])).toBe(true);
  });
});
