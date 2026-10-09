import { describe, expect, it } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { computeVolatilityEdge, expirySpansEarnings, forecastOnOptionClock, tradingSessionsByExpiry, expirySpansMacroEvent, selectRealizedVolatilityForecast, type EdgeSlice } from "./volatilityEdge.js";

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
    expect(selectRealizedVolatilityForecast(bars)).toEqual({ volatility: expected.annualizedVolatility, windowDays: 63 });
  });

  it("needs 64 bars for the 63-day window: with 63 bars it falls back to the 21-day window", () => {
    expect(selectRealizedVolatilityForecast(makeBars(64))!.windowDays).toBe(63);
    const fallback = selectRealizedVolatilityForecast(makeBars(63))!;
    expect(fallback.windowDays).toBe(21);
    const expected = computeYangZhangVolatility(makeBars(63), 21);
    if (!expected.available) throw new Error("fixture must be fittable");
    expect(fallback.volatility).toBe(expected.annualizedVolatility);
  });

  it("returns no forecast (no Edge) with fewer than 22 bars", () => {
    expect(selectRealizedVolatilityForecast(makeBars(22))!.windowDays).toBe(21);
    expect(selectRealizedVolatilityForecast(makeBars(21))).toBeNull();
    expect(selectRealizedVolatilityForecast([])).toBeNull();
  });

  it("keeps a real 84% overnight jump in the 63-day window instead of falling back (MRNA, 2026-08-19)", () => {
    const bars = makeBars(100);
    for (let index = 60; index < bars.length; index++) bars[index] = { ...bars[index]!, open: bars[index]!.open * 1.84, high: bars[index]!.high * 1.84, low: bars[index]!.low * 1.84, close: bars[index]!.close * 1.84, volume: 12_000_000 };
    expect(selectRealizedVolatilityForecast(bars)!.windowDays).toBe(63);
  });
});

describe("forecastOnOptionClock (approved 2026-10-09)", () => {
  it("puts the 252-session forecast on the option's calendar clock: SMCI Thu → Fri, 76.6% → 92.2%", () => {
    expect(forecastOnOptionClock(0.766, 1, 1 / 365)).toBeCloseTo(0.766 * Math.sqrt(365 / 252), 12);
    expect(forecastOnOptionClock(0.766, 1, 1 / 365)! * 100).toBeCloseTo(92.19, 2);
  });
  it("lowers it across a weekend (Thu → Mon, 2 sessions in 4 days) and barely moves it at 30 days", () => {
    expect(forecastOnOptionClock(0.296, 2, 4 / 365)! * 100).toBeCloseTo(25.19, 2);
    expect(forecastOnOptionClock(0.296, 21, 29 / 365)! * 100).toBeCloseTo(30.31, 2);
  });
  it("is null without sessions", () => {
    expect(forecastOnOptionClock(0.5, undefined, 1 / 365)).toBeNull();
    expect(forecastOnOptionClock(0.5, 0, 1 / 365)).toBeNull();
    expect(forecastOnOptionClock(0.5, 3, 0)).toBeNull();
  });
});

describe("tradingSessionsByExpiry", () => {
  it("counts the open days after the scoring date up to and including each expiry", () => {
    // Thursday 2026-10-08 scoring; the list holds the scoring day itself (ignored) and Fri 9, Mon 12, Tue 13.
    const sessions = tradingSessionsByExpiry(["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-11"], ["2026-10-12", "2026-10-08", "2026-10-09", "2026-10-13"], "2026-10-08");
    expect([...sessions]).toEqual([["2026-10-09", 1], ["2026-10-12", 2], ["2026-10-13", 3], ["2026-10-11", 1]]);
  });
});

describe("computeVolatilityEdge", () => {
  const parameters: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
  const slice: EdgeSlice = { status: "ok", parameters, kMin: -0.2, kMax: 0.2, yearsToExpiry: 30 / 365, forwardPrice: 100 };
  const forecast = { volatility: 0.4, windowDays: 63 as const };
  // Sessions that put the forecast on the same clock as 30 calendar days (factor 1), so these cases test the surface side.
  const sameClockSessions = (30 * 252) / 365;

  it("is the SVI implied volatility minus the forecast, in annualized volatility", () => {
    const edge = computeVolatilityEdge(slice, 105, forecast, sameClockSessions)!;
    const expectedIv = Math.sqrt(sviTotalVariance(parameters, Math.log(105 / 100)) / (30 / 365));
    expect(edge.impliedVolatility).toBeCloseTo(expectedIv, 12);
    expect(edge.edge).toBeCloseTo(expectedIv - 0.4, 12);
    expect(edge).toMatchObject({ forecastVolatility: 0.4, forecastWindowDays: 63, insideFittedRange: true });
  });

  it("is negative when the surface sits below the forecast", () => {
    expect(computeVolatilityEdge(slice, 100, { volatility: 5, windowDays: 63 }, sameClockSessions)!.edge).toBeLessThan(0);
  });

  it("marks strikes outside the fitted log-moneyness range (inclusive at the ends)", () => {
    expect(computeVolatilityEdge(slice, 100 * Math.exp(0.2), forecast, sameClockSessions)!.insideFittedRange).toBe(true);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(-0.2), forecast, sameClockSessions)!.insideFittedRange).toBe(true);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(0.2001), forecast, sameClockSessions)!.insideFittedRange).toBe(false);
    expect(computeVolatilityEdge(slice, 100 * Math.exp(-0.2001), forecast, sameClockSessions)!.insideFittedRange).toBe(false);
  });

  it("is unscored (null) without a forecast, for a flagged slice, or for bad inputs", () => {
    expect(computeVolatilityEdge(slice, 105, null, sameClockSessions)).toBeNull();
    for (const status of ["insufficient_points", "fit_failed", "poor_fit", "butterfly_arbitrage"] as const) expect(computeVolatilityEdge({ ...slice, status }, 105, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, parameters: null }, 105, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, kMin: null }, 105, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge(slice, 0, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, forwardPrice: 0 }, 105, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, yearsToExpiry: 0 }, 105, forecast, sameClockSessions)).toBeNull();
    expect(computeVolatilityEdge({ ...slice, parameters: { a: -1, b: 0, rho: 0, m: 0, sigma: 0.1 } }, 105, forecast, sameClockSessions)).toBeNull();
  });
});

describe("expirySpansEarnings", () => {
  it("is true only when an earnings date is from today through the expiry", () => {
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-05"])).toBe(true);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-20"])).toBe(true); // on the expiry date
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-11-21"])).toBe(false); // after
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-09-21"])).toBe(true); // today's, not before the open (the loader drops those)
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2026-08-01"])).toBe(false);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", [])).toBe(false);
    expect(expirySpansEarnings("2026-09-21", "2026-11-20", ["2027-01-01", "2026-10-01"])).toBe(true);
  });
});

describe("expirySpansMacroEvent", () => {
  const scoredAtMs = Date.parse("2026-10-30T14:30:00Z"); // 10:30 EDT
  const at = (iso: string) => [{ eventAtMs: Date.parse(iso) }];

  it("counts an event still ahead and before 16:00 ET on the expiry date", () => {
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-06", at("2026-11-06T13:30:00Z"))).toBe(true); // 08:30 EST on expiry day
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-06", at("2026-11-06T20:59:00Z"))).toBe(true); // 15:59 EST
  });

  it("does not count an event at or after the close, using the expiry date's own UTC offset", () => {
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-06", at("2026-11-06T21:00:00Z"))).toBe(false); // 16:00 EST
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-03", at("2026-11-04T00:00:00Z"))).toBe(false); // election, 19:00 EST
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-04", at("2026-11-04T00:00:00Z"))).toBe(true); // the next day's expiry
  });

  it("does not count an event already out", () => {
    expect(expirySpansMacroEvent(scoredAtMs, "2026-11-06", at("2026-10-30T12:30:00Z"))).toBe(false); // 08:30 today
  });
});
