import { describe, expect, it } from "vitest";
import { betaOf, marketHistoryOf, mondayOf, tickerHistoryOf, weeklyBarsOf, type WeeklyBar } from "./portfolioPaths.js";

describe("weeks", () => {
  it("finds a date's Monday", () => {
    expect(mondayOf("2026-11-03")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
    expect(mondayOf("2026-11-09")).toBe("2026-11-09");
  });

  it("keeps each week's last close and last IV", () => {
    const weeks = weeklyBarsOf([
      { tradingDate: "2026-11-02", close: 10, impliedVolatility: 0.3 },
      { tradingDate: "2026-11-06", close: 11, impliedVolatility: null },
      { tradingDate: "2026-11-09", close: 12, impliedVolatility: 0.4 },
    ]);
    expect(weeks).toEqual([
      { week: "2026-11-02", close: 11, impliedVolatility: 0.3 },
      { week: "2026-11-09", close: 12, impliedVolatility: 0.4 },
    ]);
  });
});

describe("betaOf", () => {
  it("is cov ÷ var of the market on the weeks both have", () => {
    const { beta, ownWeeks } = betaOf([0.02, -0.04, null, 0.06], [0.01, -0.02, 0.05, 0.03]);
    expect(ownWeeks).toBe(3);
    expect(beta).toBeCloseTo(2, 10);
  });
});

const weeksFrom = (closes: number[], ivs: (number | null)[], startIndex = 0): WeeklyBar[] =>
  closes.map((close, index) => ({ week: new Date(Date.parse("2010-01-04T00:00:00Z") + (index + startIndex) * 7 * 86_400_000).toISOString().slice(0, 10), close, impliedVolatility: ivs[index] ?? null }));

describe("tickerHistoryOf (P5, P6)", () => {
  // SPY: +1%, −2%, +3%, −1%, +2% over weeks 1–5.
  const spyCloses = [100, 101, 98.98, 101.9494, 100.929906, 102.94850412];
  const market = marketHistoryOf(weeksFrom(spyCloses, [0.2, 0.2, 0.25, 0.2, 0.2, 0.2]));

  it("models the weeks before a listing from SPY through the ticker's β", () => {
    // Listed from week 2, moving exactly 2 × SPY: β 2, the weeks before β × SPY's move around SPY's average plus its own.
    // Its weeks 3–5: +6%, −2%, +4% against SPY's +3%, −1%, +2%.
    const own = weeksFrom([50, 53, 51.94, 54.0176], [0.5, 0.5, 0.5, 0.5], 2);
    const history = tickerHistoryOf("TEST", own, market, null, 0, 0);
    expect(history.ownWeek[1]).toBe(0);
    expect(history.ownWeek[3]).toBe(1);
    expect(history.beta).toBeCloseTo(2, 6);
    // Week 2 is −2% for SPY: modelled as its own average + 2 × (−2% − SPY's average on the shared weeks).
    const ownMean = (0.06 - 0.02 + 0.04) / 3;
    const marketMean = (0.03 - 0.01 + 0.02) / 3;
    expect(history.returns[2]).toBeCloseTo(ownMean + 2 * (-0.02 - marketMean), 6);
  });

  it("takes SPY's IV scaled by the median ratio where its own is missing, capped at the backtest's highest", () => {
    const own = weeksFrom([50, 51, 52, 53, 54, 55], [null, null, null, 0.4, 0.4, 0.4]);
    const history = tickerHistoryOf("TEST", own, market, 0.45, 0, 0);
    // Its median IV 0.4 against SPY's 0.2: week 1's IV is SPY's 0.2 × 2 = 0.4; week 2 has SPY at 0.25: 0.5, capped at 0.45.
    expect(history.ivs[1]).toBeCloseTo(0.4, 10);
    expect(history.ivsUncapped[2]).toBeCloseTo(0.5, 10);
    expect(history.ivs[2]).toBeCloseTo(0.45, 10);
  });

  it("shifts every week so the average becomes T-bill now + β × (SPY's average − the T-bill's average)", () => {
    const own = weeksFrom(spyCloses.map((close) => close / 2), [0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    const history = tickerHistoryOf("HALF", own, market, null, 0.001, 0.0002);
    const shifted = Array.from(history.returns).map((value) => value + history.neutralShift);
    const average = shifted.reduce((sum, value) => sum + value, 0) / shifted.length;
    expect(history.beta).toBeCloseTo(1, 6);
    expect(average).toBeCloseTo(0.001 + 1 * (market.spyMeanWeek - 0.0002), 10);
  });
});
