import { describe, expect, it } from "vitest";
import type { DailyOhlcvBar } from "../lib/realizedVolatility.js";
import { computeMoveContext } from "./moveContext.js";

/** A steady 0.5 %-a-day climb with a 1 % intraday range: enough history for every window. */
function bars(count: number): DailyOhlcvBar[] {
  const out: DailyOhlcvBar[] = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open * 1.005;
    out.push({ tradingDate: `2026-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`, open, high: close * 1.005, low: open * 0.995, close, volume: 1000 });
  }
  return out;
}

describe("computeMoveContext", () => {
  it("expected daily move is the annualised forecast over √252, and today's move is measured in those units", () => {
    const context = computeMoveContext({ bars: bars(200), forecastVolatility: 0.746, dayChangePct: 4.8, ivRank: 62 });
    // 74.6 % / 15.87 = 4.70 % a day → 4.8 % is about one sigma
    expect(context.expectedDailyMovePct).toBeCloseTo(4.7, 1);
    expect(context.dayMoveSigmas).toBeCloseTo(1.02, 2);
    expect(context.ivRank).toBe(62);
  });

  it("recent path from the bars: 5, 21 and 63 sessions back", () => {
    const context = computeMoveContext({ bars: bars(200), forecastVolatility: 0.5, dayChangePct: 0, ivRank: null });
    expect(context.change1wPct).toBeCloseTo((1.005 ** 5 - 1) * 100, 6);
    expect(context.change1mPct).toBeCloseTo((1.005 ** 21 - 1) * 100, 6);
    expect(context.change3mPct).toBeCloseTo((1.005 ** 63 - 1) * 100, 6);
    expect(context.realizedVol21dPct).not.toBeNull();
    expect(context.realizedVol126dPct).not.toBeNull();
  });

  it("is null wherever the inputs are missing, never a wrong number", () => {
    const context = computeMoveContext({ bars: bars(10), forecastVolatility: null, dayChangePct: 2, ivRank: null });
    expect(context).toEqual({ dayMoveSigmas: null, expectedDailyMovePct: null, change1wPct: expect.any(Number), change1mPct: null, change3mPct: null, realizedVol21dPct: null, realizedVol126dPct: null, ivRank: null });
  });
});
