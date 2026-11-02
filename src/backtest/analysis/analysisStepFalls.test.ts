import { describe, expect, it } from "vitest";
import { accountDuringFall, fallsOfAStep, stepFactor, stepStatistics, stepsOfBars, type StepOnDay } from "./analysisStepFalls.js";
import { impliedVolatilityRange, marketFits, openingGaps, percentileInclusive, trendSplit, weeklySkew } from "./analysisPriceFigures.js";

const dayAfter = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const bar = (tradingDate: string, close: number, impliedVolatility: number | null = 0.3, open = close) => ({ tradingDate, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume: 1_000, impliedVolatility });

describe("F9: the Step on any day", () => {
  it("is IV × √(21 ÷ 252): XLE's 27.94% on 26 Oct 2026 gives 8.07%", () => {
    expect(stepsOfBars([bar("2026-10-26", 90, 0.2794)])[0]).toEqual({ step: 0.2794 * stepFactor, volatility: 0.2794, source: "implied" });
    expect(0.2794 * stepFactor).toBeCloseTo(0.0807, 4);
  });

  it("takes the 63-day Yang-Zhang ending that day on a bar without an IV, none before 63 bars", () => {
    const bars = Array.from({ length: 70 }, (_, index) => bar(dayAfter("2003-01-02", index), 100 + Math.sin(index) * 3, null));
    const steps = stepsOfBars(bars);
    expect(steps.slice(0, 62).every((step) => step === null)).toBe(true);
    expect(steps[69]).toMatchObject({ source: "realised" });
    expect(steps[69]!.step).toBeCloseTo(steps[69]!.volatility * stepFactor, 12);
  });

  it("gives PERCENTILE.INC's median, 10th and 90th percentile", () => {
    const steps: StepOnDay[] = [0.04, 0.05, 0.06, 0.07, 0.1].map((step) => ({ step, volatility: step / stepFactor, source: "implied" }));
    expect(stepStatistics([...steps, null])).toMatchObject({ median: 0.06, barsWithStep: 5, barsFromRealised: 0 });
    expect(stepStatistics(steps).tenth).toBeCloseTo(0.044, 12);
    expect(stepStatistics(steps).ninetieth).toBeCloseTo(0.088, 12);
    expect(percentileInclusive([], 0.5)).toBeNull();
  });
});

describe("F7: falls of a Step", () => {
  const closes = [100, 95, 80, 90, 101, 99, 98, 102, 70, 75];
  const bars = closes.map((close, index) => ({ tradingDate: dayAfter("2025-01-01", index), close }));
  const step = (value: number): StepOnDay => ({ step: value, volatility: value / stepFactor, source: "implied" });

  it("measures each fall from a peak to its lowest close before the first close back at or above it", () => {
    // Peaks 100 (low 80, back at 101) and 102 (low 70, not back); 101 → 98 is a 3% dip, under any Step here.
    const falls = fallsOfAStep(bars, closes.map(() => step(0.1)), 0.1);
    expect(falls.map((fall) => [fall.peakDate, fall.lowDate, fall.backDate])).toEqual([
      ["2025-01-01", "2025-01-03", "2025-01-05"],
      ["2025-01-08", "2025-01-09", null],
    ]);
    expect(falls[0]).toMatchObject({ yardstick: 0.1, yardstickFrom: "implied", daysDown: 2, daysBack: 2 });
    expect(falls[0]!.depth).toBeCloseTo(0.2, 12);
    expect(falls[0]!.steps).toBeCloseTo(2, 12);
    expect(falls[1]!.daysBack).toBeNull();
  });

  it("measures against the larger of the peak day's Step and the median Step", () => {
    // The peak's Step of 2% is under the 25% median: the first fall (20%) doesn't count, the second (31.4%) does.
    const falls = fallsOfAStep(bars, closes.map(() => step(0.02)), 0.25);
    expect(falls.map((fall) => [fall.peakDate, fall.yardstickFrom])).toEqual([["2025-01-08", "median"]]);
    expect(falls[0]!.steps).toBeCloseTo((1 - 70 / 102) / 0.25, 12);
  });
});

describe("F11: v4's account during a fall", () => {
  const days = [100, 90, 70, 85, 100, 110].map((accountValue, index) => ({ tradingDate: dayAfter("2025-01-06", index), accountValue }));

  it("from the later of the peak and the backtest's first day to the stock's back day", () => {
    const during = accountDuringFall({ peakDate: "2024-12-01", backDate: "2025-01-09" }, days);
    expect(during).toMatchObject({ fromDate: "2025-01-06", toDate: "2025-01-09", startValue: 100, lowestValue: 70, lowestOn: "2025-01-08", backOn: "2025-01-10" });
    expect(during!.fall).toBeCloseTo(-0.3, 12);
  });

  it("is null for a fall that ended before the backtest", () => {
    expect(accountDuringFall({ peakDate: "2024-10-01", backDate: "2024-11-01" }, days)).toBeNull();
  });
});

describe("the v4 profile (F12–F16)", () => {
  it("F12 splits the days from the 220th bar into uptrend, downtrend and neither", () => {
    const rising = Array.from({ length: 300 }, (_, index) => 100 + index);
    expect(trendSplit(rising)).toEqual({ days: 81, uptrend: 81, downtrend: 0, neither: 0 });
    const falling = Array.from({ length: 300 }, (_, index) => 400 - index);
    expect(trendSplit(falling)).toEqual({ days: 81, uptrend: 0, downtrend: 81, neither: 0 });
    expect(trendSplit(rising.slice(0, 219)).days).toBe(0);
  });

  it("F13 gives beta and correlation on the shared days, and on SPY's down days", () => {
    const spy = Array.from({ length: 50 }, (_, index) => ({ tradingDate: dayAfter("2025-01-01", index), close: 100 * Math.exp(0.01 * Math.sin(index)) }));
    // The ticker moves twice SPY's log return each day: beta 2, correlation 1.
    const ticker = spy.map((entry) => ({ tradingDate: entry.tradingDate, close: 50 * (entry.close / 100) ** 2 }));
    const fits = marketFits(ticker, spy, "2025-01-20");
    expect(fits.all.beta).toBeCloseTo(2, 9);
    expect(fits.all.correlation).toBeCloseTo(1, 9);
    expect(fits.spyDownDays.beta).toBeCloseTo(2, 9);
    expect(fits.sinceBacktest!.days).toBeLessThan(fits.all.days);
  });

  it("F14 counts an opening gap beyond 2 × the 63-day Yang-Zhang ÷ √252", () => {
    const quiet = Array.from({ length: 80 }, (_, index) => bar(dayAfter("2025-01-01", index), 100 + (index % 2) * 0.5));
    const gapped = quiet.map((entry, index) => (index === 70 ? { ...entry, open: 110 } : entry));
    const gaps = openingGaps(gapped);
    expect(gaps).toMatchObject({ gaps: 1, up: 1, down: 0 });
    expect(gaps.largest!.date).toBe(gapped[70]!.tradingDate);
    expect(openingGaps(quiet).gaps).toBe(0);
  });

  it("F15 gives the weekly log returns' skew and the worst week", () => {
    const closes = [100, 101, 102, 103, 104, 80, 81, 82, 83, 84, 85, 86, 87];
    // One close a week (each Friday), so every week has one return.
    const weekly = closes.map((close, index) => ({ tradingDate: dayAfter("2025-01-03", index * 7), close }));
    const skew = weeklySkew(weekly);
    expect(skew.weeks).toBe(12);
    expect(skew.skew).toBeLessThan(0);
    expect(skew.worstWeek!.endDate).toBe(weekly[5]!.tradingDate);
    expect(skew.worstWeek!.move).toBeCloseTo(80 / 104 - 1, 12);
  });

  it("F16 gives every daily IV's median, 10th and 90th percentile", () => {
    const bars = [0.2, 0.3, null, 0.4, 0.5, 0.6].map((iv, index) => ({ tradingDate: dayAfter("2025-01-01", index), impliedVolatility: iv }));
    expect(impliedVolatilityRange(bars)).toMatchObject({ days: 5, firstDate: "2025-01-01", median: 0.4 });
    expect(impliedVolatilityRange(bars).tenth).toBeCloseTo(0.24, 12);
  });
});
