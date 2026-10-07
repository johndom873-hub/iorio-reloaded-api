import { describe, expect, it } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { volatilityRatio } from "./tiltMeasures.js";

// Audit F (2026-10-07): computeYangZhangVolatility(bars, window, endIndex) and volatilityRatio(bars, endIndex) must equal the
// same call on bars.slice(0, endIndex), for every window, including when a bad bar or a split sits just inside / outside the window.

function randomWalkBars(count: number, seed: number): DailyOhlcvBar[] {
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const bars: DailyOhlcvBar[] = [];
  let close = 50;
  for (let index = 0; index < count; index++) {
    const open = close * Math.exp((random() - 0.5) * 0.03);
    close = open * Math.exp((random() - 0.5) * 0.04);
    const high = Math.max(open, close) * (1 + random() * 0.01);
    const low = Math.min(open, close) * (1 - random() * 0.01);
    bars.push({ tradingDate: new Date(Date.UTC(2024, 0, 1) + index * 86_400_000).toISOString().slice(0, 10), open, high, low, close, volume: 1_000_000 + Math.round(random() * 400_000) });
  }
  return bars;
}

const windows = [2, 10, 21, 63, 126] as const;

function withBadBar(bars: DailyOhlcvBar[], index: number): DailyOhlcvBar[] {
  const copy = [...bars];
  copy[index] = { ...copy[index]!, low: copy[index]!.high * 1.1 };
  return copy;
}

function withSplitAt(bars: DailyOhlcvBar[], index: number): DailyOhlcvBar[] {
  return bars.map((bar, position) => (position >= index ? { ...bar, open: bar.open / 3, high: bar.high / 3, low: bar.low / 3, close: bar.close / 3, volume: bar.volume * 4 } : bar));
}

describe("computeYangZhangVolatility endIndex equals a slice", () => {
  const histories: [string, DailyOhlcvBar[]][] = [
    ["clean", randomWalkBars(300, 42)],
    ["bad bar at 150", withBadBar(randomWalkBars(300, 9), 150)],
    ["3:1 split at 200", withSplitAt(randomWalkBars(300, 17), 200)],
  ];
  it.each(histories)("for every window and every end on a %s history", (_label, bars) => {
    for (const window of windows) {
      for (let end = 0; end <= bars.length; end++) {
        const byIndex = computeYangZhangVolatility(bars, window, end);
        const bySlice = computeYangZhangVolatility(bars.slice(0, end), window);
        if (JSON.stringify(byIndex) !== JSON.stringify(bySlice)) throw new Error(`window ${window} end ${end}: ${JSON.stringify(byIndex)} != ${JSON.stringify(bySlice)}`);
      }
    }
  });

  it("ignores a bad bar right after the window end and catches one at the prior close", () => {
    const bars = randomWalkBars(60, 3);
    const end = 40;
    expect(computeYangZhangVolatility(withBadBar(bars, end), 21, end).available).toBe(true);
    const priorCloseIndex = end - 21 - 1;
    expect(computeYangZhangVolatility(withBadBar(bars, priorCloseIndex), 21, end)).toMatchObject({ available: false, reason: "invalid_bar" });
    expect(computeYangZhangVolatility(withBadBar(bars, priorCloseIndex - 1), 21, end).available).toBe(true);
  });

  it("the default endIndex is the whole array", () => {
    const bars = randomWalkBars(130, 5);
    expect(computeYangZhangVolatility(bars, 126)).toEqual(computeYangZhangVolatility(bars, 126, bars.length));
  });
});

describe("volatilityRatio endIndex equals a slice", () => {
  it("for every end on a history with a split and a bad bar", () => {
    const bars = withBadBar(withSplitAt(randomWalkBars(420, 23), 260), 330);
    for (let end = 0; end <= bars.length; end++) {
      expect(volatilityRatio(bars, end)).toBe(volatilityRatio(bars.slice(0, end)));
    }
  });
});
