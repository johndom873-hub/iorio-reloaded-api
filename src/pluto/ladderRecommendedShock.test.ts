import { describe, expect, it } from "vitest";
import { recommendLadderShock } from "./ladderRecommendedShock.js";

const settings = { ladderShockMinPct: 60, ladderShockMaxPct: 80, ladderShockNoHistoryPct: 90, ladderShockLookbackYears: 10 };

/** `count` weekday closes ending the day before 2026-10-15, falling linearly from `from` to `to`. */
function closesFalling(from: number, to: number, count: number): { date: string; close: number }[] {
  const closes: { date: string; close: number }[] = [];
  const day = new Date(Date.UTC(2026, 9, 14));
  while (closes.length < count) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) closes.push({ date: day.toISOString().slice(0, 10), close: 0 });
    day.setUTCDate(day.getUTCDate() - 1);
  }
  closes.reverse();
  return closes.map((bar, index) => ({ ...bar, close: from + ((to - from) * index) / (count - 1) }));
}

describe("recommendLadderShock (the backtest's examples)", () => {
  it("a stock that fell from $100 to $30 gets its Max drawdown, 70%", () => {
    expect(recommendLadderShock(settings, closesFalling(100, 30, 300), "2026-10-15")).toMatchObject({ recommendedShockPct: 70, maxDrawdownPct: 70, closesUsed: 300 });
  });

  it("a fall to $10 (90%) is capped at 80%, a fall to $90 (10%) raised to 60%", () => {
    expect(recommendLadderShock(settings, closesFalling(100, 10, 300), "2026-10-15").recommendedShockPct).toBe(80);
    expect(recommendLadderShock(settings, closesFalling(100, 90, 300), "2026-10-15").recommendedShockPct).toBe(60);
  });

  it("under 250 closes in the lookback (a new listing) gives 90%, outside the range", () => {
    expect(recommendLadderShock(settings, closesFalling(100, 30, 249), "2026-10-15")).toMatchObject({ recommendedShockPct: 90, maxDrawdownPct: null, closesUsed: 249 });
  });

  it("counts only the lookback years before the day: the day itself and older closes are left out", () => {
    const history = [{ date: "2015-06-01", close: 1000 }, ...closesFalling(100, 70, 300), { date: "2026-10-15", close: 1 }];
    const result = recommendLadderShock(settings, history, "2026-10-15");
    expect(result.closesUsed).toBe(300);
    expect(result.toIso).toBe("2026-10-14");
    expect(result.recommendedShockPct).toBe(60);
  });
});
