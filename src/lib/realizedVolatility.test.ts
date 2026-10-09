import { describe, expect, it } from "vitest";
import {
  computeYangZhangVolatility,
  computeYangZhangVolatilityAllWindows,
  yangZhangWindowDays,
  type DailyOhlcvBar,
} from "./realizedVolatility.js";

function makeBar(index: number, open: number, high: number, low: number, close: number, volume = 1_000_000): DailyOhlcvBar {
  return { tradingDate: `2026-01-${String(index + 1).padStart(2, "0")}`, open, high, low, close, volume };
}

// Deterministic, gently-moving series with normal volume — a clean baseline the
// split-guard tests then modify at specific bars.
function buildSteadyBars(count: number): DailyOhlcvBar[] {
  const bars: DailyOhlcvBar[] = [];
  let previousClose = 100;
  for (let index = 0; index < count; index++) {
    const open = previousClose * 1.0005;
    const close = 100 * (1 + 0.01 * Math.sin(index / 3));
    bars.push({
      tradingDate: `2026-day-${String(index).padStart(3, "0")}`,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1_000_000,
    });
    previousClose = close;
  }
  return bars;
}

// Replaces the last bar with one that opens at `ratio` × the previous close
// (a split or crash), scaling its whole price range with it.
function withLastBarGap(bars: DailyOhlcvBar[], ratio: number, volume: number): DailyOhlcvBar[] {
  const previousClose = bars[bars.length - 2]!.close;
  const open = previousClose * ratio;
  const close = open * 1.001;
  const gapBar: DailyOhlcvBar = {
    tradingDate: bars[bars.length - 1]!.tradingDate,
    open,
    high: close * 1.002,
    low: open * 0.998,
    close,
    volume,
  };
  return [...bars.slice(0, -1), gapBar];
}

describe("computeYangZhangVolatility — known values", () => {
  // Expected numbers come from an independent Python implementation of the
  // approved formula (not from this module), on this same 6-bar fixture.
  const fixtureBars = [
    makeBar(0, 100, 102, 99, 101),
    makeBar(1, 101.5, 103, 100.5, 102.2),
    makeBar(2, 102.0, 104.0, 101.0, 103.5),
    makeBar(3, 103.0, 103.8, 100.2, 100.9),
    makeBar(4, 101.1, 102.5, 100.4, 102.0),
    makeBar(5, 102.4, 104.6, 101.9, 104.1),
  ];

  it("matches the independent reference on every component and the annualized result", () => {
    const result = computeYangZhangVolatility(fixtureBars, 5);
    if (!result.available) throw new Error(`expected available, got ${result.reason}`);
    expect(result.components.overnightVariance).toBeCloseTo(1.6916241547186545e-5, 15);
    expect(result.components.openToCloseVariance).toBeCloseTo(0.00022426022017304584, 15);
    expect(result.components.rogersSatchellVariance).toBeCloseTo(0.0002819125719792097, 15);
    expect(result.components.weightK).toBeCloseTo(0.11971830985915495, 12);
    expect(result.components.combinedDailyVariance).toBeCloseTo(0.0002919267714087569, 15);
    expect(result.annualizedVolatility).toBeCloseTo(0.2712296930555479, 12);
  });

  it("uses only the last windowDays bars plus the one before for the first overnight return", () => {
    const prefixed = [makeBar(99, 500, 900, 400, 600), ...fixtureBars]; // an old, wild bar that must not leak in
    const withPrefix = computeYangZhangVolatility(prefixed, 5);
    const withoutPrefix = computeYangZhangVolatility(fixtureBars, 5);
    if (!withPrefix.available || !withoutPrefix.available) throw new Error("expected both available");
    expect(withPrefix.annualizedVolatility).toBeCloseTo(withoutPrefix.annualizedVolatility, 12);
  });
});

// Mulberry32: small seeded PRNG so the simulation tests are deterministic.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateBars(options: { days: number; overnightDailyVol: number; intradayDailyVol: number; annualDrift: number; stepsPerDay: number; seed: number }): DailyOhlcvBar[] {
  const { days, overnightDailyVol, intradayDailyVol, annualDrift, stepsPerDay, seed } = options;
  const random = seededRandom(seed);
  const spareNormals: number[] = [];
  const nextNormal = (): number => {
    if (spareNormals.length > 0) return spareNormals.pop()!;
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    spareNormals.push(radius * Math.sin(2 * Math.PI * u2));
    return radius * Math.cos(2 * Math.PI * u2);
  };
  const dailyDrift = annualDrift / 252;
  const bars: DailyOhlcvBar[] = [];
  let logPrice = Math.log(100);
  for (let day = 0; day < days; day++) {
    logPrice += 0.3 * dailyDrift + overnightDailyVol * nextNormal();
    const open = Math.exp(logPrice);
    let highLog = logPrice;
    let lowLog = logPrice;
    const stepDrift = (0.7 * dailyDrift) / stepsPerDay;
    const stepVol = intradayDailyVol / Math.sqrt(stepsPerDay);
    for (let step = 0; step < stepsPerDay; step++) {
      logPrice += stepDrift + stepVol * nextNormal();
      if (logPrice > highLog) highLog = logPrice;
      if (logPrice < lowLog) lowLog = logPrice;
    }
    bars.push({ tradingDate: `sim-${day}`, open, high: Math.exp(highLog), low: Math.exp(lowLog), close: Math.exp(logPrice), volume: 1_000_000 });
  }
  return bars;
}

describe("computeYangZhangVolatility — recovers a known true volatility", () => {
  // True daily variance = overnight² + intraday²; annualized with 252 days.
  const overnightDailyVol = 0.01;
  const intradayDailyVol = 0.015;
  const trueAnnualizedVolatility = Math.sqrt(252 * (overnightDailyVol ** 2 + intradayDailyVol ** 2));
  // 300 steps/day samples the high/low discretely, which shortens the measured
  // range slightly (a known small downward bias of any range estimator), so the
  // tolerance is 6% of the true volatility rather than exact.
  const tolerance = 0.06;

  it("with no drift", () => {
    const bars = simulateBars({ days: 6000, overnightDailyVol, intradayDailyVol, annualDrift: 0, stepsPerDay: 300, seed: 12345 });
    const result = computeYangZhangVolatility(bars, 5000);
    if (!result.available) throw new Error(`expected available, got ${result.reason}`);
    expect(Math.abs(result.annualizedVolatility / trueAnnualizedVolatility - 1)).toBeLessThan(tolerance);
  });

  it("with a very strong drift (drift-independence, the reason Yang-Zhang is used)", () => {
    const bars = simulateBars({ days: 6000, overnightDailyVol, intradayDailyVol, annualDrift: 1.5, stepsPerDay: 300, seed: 987 });
    const result = computeYangZhangVolatility(bars, 5000);
    if (!result.available) throw new Error(`expected available, got ${result.reason}`);
    expect(Math.abs(result.annualizedVolatility / trueAnnualizedVolatility - 1)).toBeLessThan(tolerance);
  });
});

describe("computeYangZhangVolatility — availability", () => {
  it("is unavailable (insufficient_history) without windowDays + 1 bars", () => {
    const result = computeYangZhangVolatility(buildSteadyBars(21), 21);
    expect(result).toMatchObject({ available: false, reason: "insufficient_history" });
    expect(computeYangZhangVolatility(buildSteadyBars(22), 21).available).toBe(true);
  });

  it("is unavailable (invalid_bar) when a bar in the window has high below low", () => {
    const bars = buildSteadyBars(40);
    bars[35] = { ...bars[35]!, high: 90, low: 110 };
    expect(computeYangZhangVolatility(bars, 21)).toMatchObject({ available: false, reason: "invalid_bar" });
  });

  it("ignores an invalid bar that sits outside the window", () => {
    const bars = buildSteadyBars(60);
    bars[3] = { ...bars[3]!, high: 90, low: 110 };
    expect(computeYangZhangVolatility(bars, 21).available).toBe(true);
  });

  it("throws on a nonsensical window", () => {
    expect(() => computeYangZhangVolatility(buildSteadyBars(10), 1)).toThrow(RangeError);
    expect(() => computeYangZhangVolatility(buildSteadyBars(10), 2.5)).toThrow(RangeError);
  });

  it("computes all four approved windows at once", () => {
    const results = computeYangZhangVolatilityAllWindows(buildSteadyBars(130));
    for (const windowDays of yangZhangWindowDays) expect(results[windowDays].available).toBe(true);
    expect(computeYangZhangVolatilityAllWindows(buildSteadyBars(50))[126]).toMatchObject({ available: false, reason: "insufficient_history" });
  });
});

describe("large overnight moves", () => {
  const baseBars = buildSteadyBars(40);

  it("count as real moves: splits are handled when bars are stored (dailyBarSplitCheck.ts), not guessed here", () => {
    const steady = computeYangZhangVolatility(baseBars, 21);
    if (!steady.available) throw new Error("fixture must be fittable");
    for (const [ratio, volume] of [[0.5, 2_000_000], [0.5, 6_000_000], [0.1, 12_000_000], [1.84, 8_000_000], [2, 500_000]] as const) {
      const withGap = computeYangZhangVolatility(withLastBarGap(baseBars, ratio, volume), 21);
      if (!withGap.available) throw new Error(`a ${ratio}× overnight move was refused`);
      expect(withGap.annualizedVolatility).toBeGreaterThan(steady.annualizedVolatility);
    }
  });
});

describe("computeYangZhangVolatility endIndex (2026-10-07)", () => {
  it("equals the result on a copy cut at endIndex, for every end", () => {
    const bars = Array.from({ length: 160 }, (_, index) => {
      const close = 100 + Math.sin(index / 5) * 4 + index * 0.1;
      return { tradingDate: new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10), open: close * 0.995, high: close * 1.01, low: close * 0.985, close, volume: 1_000_000 };
    });
    for (let end = 0; end <= bars.length; end++) {
      expect(computeYangZhangVolatility(bars, 21, end)).toEqual(computeYangZhangVolatility(bars.slice(0, end), 21));
    }
  });
});
