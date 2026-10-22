import { describe, expect, it } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { expirySpansEarnings, expirySpansMacroEvent, longForecastWindowDays, selectEarningsFreeVolatilityForecast, selectImpliedVolatilityForecast, selectModelVolatilityForecast } from "./volatilityEdge.js";

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

describe("selectEarningsFreeVolatilityForecast (backtest model setting, Edge Margin audit 2026-10-22)", () => {
  it("is the 21-session Yang-Zhang forecast when no earnings reaction falls in the window", () => {
    const bars = makeBars(120);
    const plain = selectModelVolatilityForecast(bars)!;
    for (const earnings of [[], ["2020-01-01"], [bars[10]!.tradingDate], ["2030-01-01"]]) {
      expect(selectEarningsFreeVolatilityForecast(bars, earnings)).toEqual(plain);
    }
  });

  it("leaves out the reaction session and the one after it, each kept session's overnight return from its own previous close", () => {
    const bars = makeBars(120);
    const earningsIndex = bars.length - 6;
    // A 15% gap on the reaction session (its close kept, so the next sessions' overnight returns do not change).
    const gapped = bars.map((bar, index) => (index === earningsIndex ? { ...bar, open: bars[index - 1]!.close * 1.15, high: Math.max(bar.high, bars[index - 1]!.close * 1.16), low: Math.min(bar.low, bar.close * 0.99) } : bar));
    const earnings = [bars[earningsIndex]!.tradingDate];
    expect(selectModelVolatilityForecast(gapped)!.annualizedVolatility).toBeGreaterThan(selectModelVolatilityForecast(bars)!.annualizedVolatility * 1.5);
    const earningsFree = selectEarningsFreeVolatilityForecast(gapped, earnings)!;
    expect(earningsFree.annualizedVolatility).toBe(selectEarningsFreeVolatilityForecast(bars, earnings)!.annualizedVolatility);
    // The same 21 sessions by hand: the last 23 bars but the reaction session and the next.
    const keptIndexes = Array.from({ length: 23 }, (_, offset) => bars.length - 23 + offset).filter((index) => index !== earningsIndex && index !== earningsIndex + 1);
    const byHand = keptIndexes.map((index) => ({ overnight: Math.log(bars[index]!.open / bars[index - 1]!.close), intraday: Math.log(bars[index]!.close / bars[index]!.open) }));
    expect(byHand).toHaveLength(21);
    const variance = (values: number[]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    };
    const rogersSatchell = keptIndexes.reduce((sum, index) => {
      const { open, high, low, close } = bars[index]!;
      return sum + Math.log(high / close) * Math.log(high / open) + Math.log(low / close) * Math.log(low / open);
    }, 0) / 21;
    const k = 0.34 / (1.34 + 22 / 20);
    const expected = variance(byHand.map((day) => day.overnight)) + k * variance(byHand.map((day) => day.intraday)) + (1 - k) * rogersSatchell;
    expect(earningsFree.perSessionVariance).toBeCloseTo(expected, 15);
  });

  it("is null when the bars hold fewer than 21 sessions outside earnings reactions", () => {
    const bars = makeBars(23);
    expect(selectEarningsFreeVolatilityForecast(bars, [])).not.toBeNull();
    expect(selectEarningsFreeVolatilityForecast(bars, [bars[15]!.tradingDate])).toBeNull();
  });
});

describe("selectImpliedVolatilityForecast (backtest model setting, Edge Margin audit 2026-10-22)", () => {
  it("is IBKR's 30-day implied volatility as variance per session = volatility² ÷ 252", () => {
    expect(selectImpliedVolatilityForecast(0.32)).toEqual({ perSessionVariance: (0.32 * 0.32) / 252, annualizedVolatility: 0.32, windowDays: 30 });
  });

  it("is null without a usable implied volatility", () => {
    for (const value of [null, 0, -0.1, Number.NaN]) expect(selectImpliedVolatilityForecast(value)).toBeNull();
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
