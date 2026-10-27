import { describe, expect, it } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { longForecastWindowDays, selectModelVolatilityForecast } from "./volatilityForecast.js";

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

describe("selectModelVolatilityForecast (the valuation model's YZ21, model review P3)", () => {
  it("is the 21-day Yang-Zhang volatility, with its variance per session = volatility² ÷ 252, whatever longer history exists", () => {
    for (const count of [22, 200]) {
      const bars = makeBars(count);
      const expected = computeYangZhangVolatility(bars, 21);
      if (!expected.available) throw new Error("fixture must be fittable");
      const forecast = selectModelVolatilityForecast(bars)!;
      expect(forecast.annualizedVolatility).toBe(expected.annualizedVolatility);
      expect(forecast.perSessionVariance).toBeCloseTo(expected.annualizedVolatility ** 2 / 252, 15);
      expect(forecast.windowDays).toBe(21);
    }
  });

  it("needs 22 bars (21 returns and the prior close)", () => {
    expect(selectModelVolatilityForecast(makeBars(21))).toBeNull();
  });
});

describe("selectModelVolatilityForecast on the 63-day window (FV 63d, display only)", () => {
  it("is the 63-day Yang-Zhang volatility when asked for that window", () => {
    const bars = makeBars(200);
    const expected = computeYangZhangVolatility(bars, 63);
    if (!expected.available) throw new Error("fixture must be fittable");
    expect(longForecastWindowDays).toBe(63);
    expect(selectModelVolatilityForecast(bars, longForecastWindowDays)).toMatchObject({ annualizedVolatility: expected.annualizedVolatility, windowDays: 63 });
  });

  it("needs 64 bars (63 returns and the prior close), with no fallback to a shorter window", () => {
    expect(selectModelVolatilityForecast(makeBars(64), longForecastWindowDays)!.windowDays).toBe(63);
    expect(selectModelVolatilityForecast(makeBars(63), longForecastWindowDays)).toBeNull();
  });
});
