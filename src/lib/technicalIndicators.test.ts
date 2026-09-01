import { describe, expect, it } from "vitest";
import { computeAtrSeries, computeMacd, computeMovingAverages, computeRsi, computeSupportResistance, type OhlcvBar } from "./technicalIndicators.js";

describe("computeMovingAverages", () => {
  it("returns null for a window without enough closes", () => {
    const closes = [1, 2, 3, 4, 5, 6];
    expect(computeMovingAverages(closes)).toEqual({ ma7: null, ma25: null, ma99: null });
  });

  it("computes the arithmetic mean of the latest N closes", () => {
    const closes = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99
    const { ma7, ma25, ma99 } = computeMovingAverages(closes);
    expect(ma7).toBeCloseTo((93 + 99) / 2, 5); // mean of 93..99
    expect(ma25).toBeCloseTo((75 + 99) / 2, 5); // mean of 75..99
    expect(ma99).toBeCloseTo((1 + 99) / 2, 5); // mean of 1..99
  });
});

describe("computeRsi", () => {
  it("returns 50 (neutral) with fewer than 15 closes", () => {
    expect(computeRsi([1, 2, 3])).toBe(50);
  });

  it("returns 100 when every change is a gain", () => {
    const closes = Array.from({ length: 15 }, (_, i) => 100 + i); // strictly increasing
    expect(computeRsi(closes)).toBe(100);
  });

  it("returns 0 when every change is a loss", () => {
    const closes = Array.from({ length: 15 }, (_, i) => 100 - i); // strictly decreasing
    expect(computeRsi(closes)).toBe(0);
  });

  it("matches the hand-computed formula for a mixed series", () => {
    // 14 changes: +1 x7, -1 x7 -> avgGain=7/14=0.5, avgLoss=7/14=0.5 -> RSI=50
    const closes = [100];
    for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1]! + (i % 2 === 0 ? 1 : -1));
    expect(computeRsi(closes)).toBeCloseTo(50, 5);
  });
});

describe("computeMacd", () => {
  it("returns Neutral with fewer than 35 closes", () => {
    expect(computeMacd(Array.from({ length: 34 }, (_, i) => 100 + i))).toBe("Neutral");
  });

  it("returns Bullish for a recent acceleration off a flat base", () => {
    // A perfectly linear ramp makes the MACD line mathematically flat (both
    // EMAs settle to the same constant offset), so this exercises a
    // realistic shape instead: flat, then a recent upward acceleration,
    // which pulls the fast EMA above the slow one by a real margin.
    const flat = Array.from({ length: 40 }, () => 100);
    const accelerating = Array.from({ length: 20 }, (_, i) => 100 + i * i * 0.15);
    expect(computeMacd([...flat, ...accelerating])).toBe("Bullish");
  });

  it("returns Bearish for a recent acceleration off a flat base", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const accelerating = Array.from({ length: 20 }, (_, i) => 100 - i * i * 0.15);
    expect(computeMacd([...flat, ...accelerating])).toBe("Bearish");
  });
});

describe("computeAtrSeries", () => {
  it("returns a constant ATR for bars with constant true range", () => {
    const bars: OhlcvBar[] = Array.from({ length: 20 }, (_, i) => ({
      time: i,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
    }));
    const atr = computeAtrSeries(bars, 14);
    expect(atr.length).toBe(20 - 1 - 14 + 1);
    for (const value of atr) expect(value).toBeCloseTo(2, 5); // high-low = 2 every bar
  });

  it("returns an empty series with fewer bars than the period", () => {
    const bars: OhlcvBar[] = Array.from({ length: 5 }, (_, i) => ({ time: i, open: 1, high: 2, low: 0, close: 1, volume: 1 }));
    expect(computeAtrSeries(bars, 14)).toEqual([]);
  });
});

describe("computeSupportResistance", () => {
  // 80 hourly bars drifting from 100 to ~124, with three sharp lower-wick
  // "touch and reject" dips to a floor of exactly 100 at indices 10, 30, 55
  // (>4 bars apart, so each counts as an independent touch) and elevated
  // volume on the touch bars — a textbook repeated-support pattern.
  function buildFloorTouchBars(): OhlcvBar[] {
    const dipIndexes = new Set([10, 30, 55]);
    return Array.from({ length: 80 }, (_, i) => {
      const trendPrice = 100 + i * 0.3;
      const isDip = dipIndexes.has(i);
      return {
        time: i,
        open: trendPrice,
        close: trendPrice,
        high: trendPrice + 0.5,
        low: isDip ? 100 : trendPrice - 0.5,
        volume: isDip ? 4000 : 1000,
      };
    });
  }

  it("detects a repeated-touch support zone at the floor price", () => {
    const bars = buildFloorTouchBars();
    const currentPrice = bars[bars.length - 1]!.close;
    const { support } = computeSupportResistance(bars, currentPrice, false);

    expect(support).not.toBeNull();
    expect(support!.price).toBeCloseTo(100, 0);
    expect(support!.touches).toBe(3);
    expect(support!.qualityPct).toBeGreaterThanOrEqual(40);
  });

  it("falls back to the closed-candle extreme with zero quality when no zone qualifies", () => {
    const bars = buildFloorTouchBars();
    const currentPrice = bars[bars.length - 1]!.close;
    const { resistance } = computeSupportResistance(bars, currentPrice, false);

    // A monotonic uptrend has no repeated resistance touches, so this
    // exercises the "no valid zone" fallback (step 13 of the spec).
    const maxHigh = Math.max(...bars.slice(0, -1).map((b) => b.high)); // currentCandleIsOpen=false here, so closedBars === bars
    expect(resistance).not.toBeNull();
    expect(resistance!.qualityPct).toBe(0);
    expect(resistance!.price).toBeCloseTo(Math.max(...bars.map((b) => b.high)), 1);
    void maxHigh;
  });

  it("falls back with zero quality when there are too few closed candles", () => {
    const bars: OhlcvBar[] = Array.from({ length: 10 }, (_, i) => ({ time: i, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const { support, resistance } = computeSupportResistance(bars, 100, false);
    expect(support?.qualityPct).toBe(0);
    expect(resistance?.qualityPct).toBe(0);
  });

  it("excludes the still-open current candle from pivot discovery", () => {
    const bars = buildFloorTouchBars();
    // Append a fake "open" candle with an absurd low that would otherwise
    // corrupt the fallback/pivot scan if it weren't excluded.
    bars.push({ time: 80, open: 124, high: 125, low: 1, close: 124, volume: 500 });
    const { support } = computeSupportResistance(bars, 124, true);
    expect(support!.price).not.toBeCloseTo(1, 0);
    expect(support!.price).toBeCloseTo(100, 0);
  });
});
