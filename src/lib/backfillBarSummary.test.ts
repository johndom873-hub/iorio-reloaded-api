import { describe, expect, it } from "vitest";
import { summarizeBackfillBars } from "./backfillBarSummary.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";

function bar(day: number, open: number, close: number, volume = 1_000_000): DailyOhlcvBar {
  return { tradingDate: `2024-10-${String(day).padStart(2, "0")}`, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume };
}

describe("summarizeBackfillBars", () => {
  it("reports range and count for clean bars", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i + 1, 100 + i, 100.5 + i));
    expect(summarizeBackfillBars(bars)).toEqual({ barCount: 10, firstTradingDate: "2024-10-01", lastTradingDate: "2024-10-10", suspectedSplitDates: [], invalidBarDates: [] });
  });
  it("flags a 10:1 forward split confirmed by volume", () => {
    const bars = Array.from({ length: 25 }, (_, i) => bar(i + 1, 1000, 1000));
    bars.push({ ...bar(26, 100, 100), volume: 12_000_000 });
    expect(summarizeBackfillBars(bars).suspectedSplitDates).toEqual(["2024-10-26"]);
  });
  it("flags invalid bars and handles no bars", () => {
    expect(summarizeBackfillBars([bar(1, 100, 100), { ...bar(2, 100, 100), close: 0 }]).invalidBarDates).toEqual(["2024-10-02"]);
    expect(summarizeBackfillBars([])).toEqual({ barCount: 0, firstTradingDate: null, lastTradingDate: null, suspectedSplitDates: [], invalidBarDates: [] });
  });
});
