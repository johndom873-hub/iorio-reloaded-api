import { describe, expect, it } from "vitest";
import { sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew, volatilityRatio, type SkewSlice } from "./tiltMeasures.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";

describe("computeMomentum", () => {
  it("is ln(close 21 days ago / close 252 days ago): the latest month is skipped", () => {
    const closes = Array.from({ length: 300 }, (_, index) => 100 + index); // index = value - 100
    const last = closes.length - 1;
    expect(computeMomentum(closes)).toBeCloseTo(Math.log(closes[last - 21]! / closes[last - 252]!), 12);
    expect(computeMomentum(closes)).toBeCloseTo(Math.log((100 + 278) / (100 + 47)), 12);
  });
  it("needs 253 closes: 252 gives null, 253 works", () => {
    expect(computeMomentum(Array.from({ length: 252 }, () => 100))).toBeNull();
    expect(computeMomentum(Array.from({ length: 253 }, () => 100))).toBe(0);
  });
  it("is negative for a falling stock and null for non-positive prices", () => {
    expect(computeMomentum(Array.from({ length: 300 }, (_, index) => 300 - index))!).toBeLessThan(0);
    const closes = Array.from({ length: 300 }, () => 100);
    closes[299 - 21] = 0;
    expect(computeMomentum(closes)).toBeNull();
  });
});

describe("computeSkew", () => {
  const smirk: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.5, m: 0, sigma: 0.15 };
  const slice = (days: number, overrides: Partial<SkewSlice> = {}): SkewSlice => ({ status: "ok", parameters: smirk, kMin: -0.4, kMax: 0.4, yearsToExpiry: days / 365, ...overrides });

  it("is the IV half an ATM standard deviation below the forward minus the ATM IV", () => {
    const measure = computeSkew([slice(30)])!;
    const years = 30 / 365;
    const atmVariance = sviTotalVariance(smirk, 0);
    const putK = -0.5 * Math.sqrt(atmVariance);
    const expected = Math.sqrt(sviTotalVariance(smirk, putK) / years) - Math.sqrt(atmVariance / years);
    expect(measure.skew).toBeCloseTo(expected, 12);
    expect(measure.skew).toBeGreaterThan(0); // negative rho: puts richer than ATM
    expect(measure.daysToExpiry).toBeCloseTo(30, 9);
  });

  it("is negative for a smile tilted the other way", () => {
    expect(computeSkew([slice(30, { parameters: { ...smirk, rho: 0.5 } })])!.skew).toBeLessThan(0);
  });

  it("picks the expiry closest to 30 days, ignoring anything under 14 days and any slice that is not ok", () => {
    const slices = [slice(10), slice(21), slice(45, { parameters: { ...smirk, b: 0.09 } }), slice(38), slice(29, { status: "poor_fit" })];
    expect(computeSkew(slices)!.daysToExpiry).toBeCloseTo(38, 9);
    expect(computeSkew([slice(13), slice(14)])!.daysToExpiry).toBeCloseTo(14, 9);
    expect(computeSkew([slice(13)])).toBeNull();
  });

  it("is null with no usable slice, missing parameters or range, or when the put point is outside the fitted range", () => {
    expect(computeSkew([])).toBeNull();
    expect(computeSkew([slice(30, { parameters: null })])).toBeNull();
    expect(computeSkew([slice(30, { kMin: null })])).toBeNull();
    expect(computeSkew([slice(30, { status: "butterfly_arbitrage" })])).toBeNull();
    const putK = -0.5 * Math.sqrt(sviTotalVariance(smirk, 0));
    expect(computeSkew([slice(30, { kMin: putK + 0.001 })])).toBeNull();
    expect(computeSkew([slice(30, { kMin: putK - 0.001 })])).not.toBeNull();
    expect(computeSkew([slice(30, { kMax: putK - 0.001 })])).toBeNull();
  });
});

// Seeded synthetic bars: calm random walk, optionally with a volatile stretch at the end.
function makeBars(count: number, volatileTail = 0, seed = 7): DailyOhlcvBar[] {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
  let close = 100;
  const start = Date.UTC(2020, 0, 2);
  return Array.from({ length: count }, (_, index) => {
    const move = index >= count - volatileTail ? 0.06 : 0.012;
    const open = close * (1 + random() * move * 0.5);
    close = open * (1 + random() * move * 2);
    return { tradingDate: new Date(start + index * 86_400_000).toISOString().slice(0, 10), open, high: Math.max(open, close) * (1 + Math.abs(random()) * move * 0.4), low: Math.min(open, close) * (1 - Math.abs(random()) * move * 0.4), close, volume: 1_000_000 };
  });
}

describe("volatilityRatio and computeElevatedVolatilityFlag", () => {
  it("volatilityRatio is null without 127 bars and above 1 when recent volatility is up", () => {
    expect(volatilityRatio(makeBars(126))).toBeNull();
    expect(volatilityRatio(makeBars(127))).not.toBeNull();
    expect(volatilityRatio(makeBars(400, 15))!).toBeGreaterThan(1.5);
    expect(volatilityRatio(makeBars(400, 0))!).toBeLessThan(1.5);
  });

  it("uses the ticker's own 90th percentile once it has 250 earlier observations, and it sits at about the 90th percentile of them", () => {
    const bars = makeBars(500);
    const flag = computeElevatedVolatilityFlag(bars)!;
    expect(flag.thresholdSource).toBe("own_p90");
    const earlier: number[] = [];
    for (let end = 126; end < bars.length - 1; end++) earlier.push(volatilityRatio(bars.slice(0, end + 1))!);
    const shareAtOrAbove = earlier.filter((ratio) => ratio >= flag.threshold).length / earlier.length;
    expect(shareAtOrAbove).toBeGreaterThan(0.08);
    expect(shareAtOrAbove).toBeLessThanOrEqual(0.105); // discrete: floor(0.9·n) leaves 10.2% at n = 373
  });

  it("flags a volatile finish every time, and a calm series only about one time in ten (by construction of a 90th percentile)", () => {
    const seeds = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(seeds.every((seed) => computeElevatedVolatilityFlag(makeBars(500, 15, seed))!.elevated)).toBe(true);
    const calmFlagged = seeds.filter((seed) => computeElevatedVolatilityFlag(makeBars(500, 0, seed))!.elevated).length;
    expect(calmFlagged).toBeLessThanOrEqual(8); // expected ~3 of 30
  });

  it("falls back to a fixed 1.3 while the ticker has fewer than 250 earlier observations", () => {
    const flag = computeElevatedVolatilityFlag(makeBars(300, 10))!;
    expect(flag.thresholdSource).toBe("fixed_fallback");
    expect(flag.threshold).toBe(1.3); // the approved fallback, spelled out on purpose
    expect(computeElevatedVolatilityFlag(makeBars(126))).toBeNull();
  });

  it("switches from the fallback to the own threshold exactly at 250 earlier observations", () => {
    // observations exist for ends 126..len-2, i.e. len-127 of them
    expect(computeElevatedVolatilityFlag(makeBars(376))!.thresholdSource).toBe("fixed_fallback"); // 249
    expect(computeElevatedVolatilityFlag(makeBars(377))!.thresholdSource).toBe("own_p90"); // 250
  });

  it("never lets the present influence its own threshold (no lookahead)", () => {
    const calm = makeBars(500);
    const spiked = calm.map((bar, index) => (index === calm.length - 1 ? { ...bar, open: bar.open * 0.7, close: bar.close * 1.4, high: bar.high * 1.5, low: bar.low * 0.6 } : bar));
    const calmFlag = computeElevatedVolatilityFlag(calm)!;
    const spikedFlag = computeElevatedVolatilityFlag(spiked)!;
    expect(spikedFlag.threshold).toBe(calmFlag.threshold);
    expect(spikedFlag.ratio).toBeGreaterThan(calmFlag.ratio);
  });
});

describe("computeElevatedVolatilityFlag by index (2026-10-07)", () => {
  // The earlier implementation, kept as the reference: each earlier ratio read a copy of the history up to that day.
  function referenceFlag(bars: DailyOhlcvBar[]) {
    const ratio = volatilityRatio(bars);
    if (ratio === null) return null;
    const earlierRatios: number[] = [];
    for (let end = 126; end < bars.length - 1; end++) {
      const earlier = volatilityRatio(bars.slice(0, end + 1));
      if (earlier !== null) earlierRatios.push(earlier);
    }
    const useOwn = earlierRatios.length >= 250;
    const sorted = [...earlierRatios].sort((first, second) => first - second);
    const threshold = useOwn ? sorted[Math.floor(0.9 * sorted.length)]! : 1.3;
    return { ratio, threshold, thresholdSource: useOwn ? "own_p90" : "fixed_fallback", elevated: ratio >= threshold };
  }

  function randomWalkBars(count: number, seed: number): DailyOhlcvBar[] {
    let state = seed;
    const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const bars: DailyOhlcvBar[] = [];
    let close = 100;
    for (let index = 0; index < count; index++) {
      const open = close * Math.exp((random() - 0.5) * 0.02);
      close = open * Math.exp((random() - 0.5) * (index > count * 0.7 ? 0.08 : 0.03));
      const high = Math.max(open, close) * (1 + random() * 0.01);
      const low = Math.min(open, close) * (1 - random() * 0.01);
      bars.push({ tradingDate: new Date(Date.UTC(2021, 0, 1) + index * 86_400_000).toISOString().slice(0, 10), open, high, low, close, volume: 1_000_000 + Math.round(random() * 500_000) });
    }
    return bars;
  }

  it.each([
    ["a full five-year history", randomWalkBars(1263, 7)],
    ["a short history that uses the fixed fallback", randomWalkBars(300, 11)],
    ["a history with a 2:1 split in the middle", (() => { const bars = randomWalkBars(900, 3); for (let index = 450; index < bars.length; index++) { const bar = bars[index]!; bars[index] = { ...bar, open: bar.open / 2, high: bar.high / 2, low: bar.low / 2, close: bar.close / 2, volume: bar.volume * 3 }; } return bars; })()],
    ["a history with a bad bar", (() => { const bars = randomWalkBars(700, 5); bars[400] = { ...bars[400]!, high: -1 }; return bars; })()],
  ])("gives exactly the earlier result on %s", (_label, bars) => {
    expect(computeElevatedVolatilityFlag(bars)).toEqual(referenceFlag(bars));
  });
});
