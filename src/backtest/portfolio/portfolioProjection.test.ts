import { describe, expect, it } from "vitest";
import { weeksPerYear, type MarketHistory, type TickerHistory } from "./portfolioPaths.js";
import { bookOutcome, drawPaths, excessWeek, pathFiguresOf, replaysOf, tickerPathExcess, type ProjectedTicker } from "./portfolioProjection.js";

const xle = { premiumRatio: 0.00926, callDaysPerWeek: 1.3, upCapture: 0.588, downCapture: 0.718, sharesHeldShare: 0.635 };

describe("excessWeek (a ticker's week less the T-bill)", () => {
  it("adds options' income and the swing, less the shares' T-bill", () => {
    // XLE, IV 28.3%, a 2% rise, T-bill 3.99%: 0.00926 × 0.283 × 1.30 = 0.3407%, 0.588 × 2% = 1.176%, 0.635 × 3.99% ÷ 52.18.
    const riskFreeWeek = 0.0399 / weeksPerYear;
    const excess = excessWeek(xle, 0.283, 0.02, riskFreeWeek);
    expect(excess).toBeCloseTo(0.00926 * 0.283 * 1.3 + 0.01176 - 0.635 * riskFreeWeek, 12);
    // The week: T-bill + excess = 1.545%.
    expect(riskFreeWeek + excess).toBeCloseTo(0.01545, 4);
  });

  it("takes the down capture on a fall", () => {
    expect(excessWeek(xle, 0, -0.03, 0)).toBeCloseTo(-0.02154, 10);
  });
});

describe("pathFiguresOf", () => {
  it("measures CAGR, Max drawdown and Excess Calmar on weekly values", () => {
    const weeks = Math.round(weeksPerYear);
    const values = Array.from({ length: weeks + 1 }, (_, index) => (index <= 10 ? 1 + index * 0.01 : index <= 20 ? 1.1 - (index - 10) * 0.022 : 0.88 + (index - 20) * 0.01));
    const figures = pathFiguresOf(values, 0.04);
    expect(figures.maxDrawdown).toBeCloseTo(0.88 / 1.1 - 1, 10);
    expect(figures.peakIndex).toBe(10);
    expect(figures.troughIndex).toBe(20);
    expect(figures.cagr).toBeCloseTo((values.at(-1)! / 1) ** (weeksPerYear / weeks) - 1, 10);
    expect(figures.excessCalmar).toBeCloseTo((figures.cagr - 0.04) / 0.2, 10);
  });
});

/** A history of `returns` with an IV of 20%, every week its own. */
function historyOf(symbol: string, returns: number[]): TickerHistory {
  const count = returns.length;
  return { symbol, returns: Float64Array.from(returns), ownWeek: new Uint8Array(count).fill(1), ivs: new Float64Array(count).fill(0.2), ivsUncapped: new Float64Array(count).fill(0.2), residuals: Float64Array.from([0]), beta: 1, ownWeeks: count, neutralShift: 0, ivCap: null };
}

const tickerOf = (symbol: string, weight: number, returns: number[], overrides: Partial<ProjectedTicker> = {}): ProjectedTicker => ({ symbol, weight, lotScale: 1, premiumRatio: 0, callDaysPerWeek: 0, upCapture: 1, downCapture: 1, sharesHeldShare: 0, history: historyOf(symbol, returns), ...overrides });

describe("bookOutcome (P7, P8, D1, D3, D4)", () => {
  it("compounds the weighted weeks and splits the average year into its parts", () => {
    // Every history week +1% for A and −1% for B, half each: the book is flat but for the options' income and the T-bill.
    const weeks = 60;
    const a = tickerOf("A", 0.5, Array(weeks).fill(0.01), { premiumRatio: 0.01, callDaysPerWeek: 1, sharesHeldShare: 0.5 });
    const b = tickerOf("B", 0.5, Array(weeks).fill(-0.01), { sharesHeldShare: 0.5 });
    const paths = drawPaths(weeks, 52, 20, 1);
    const riskFreeWeek = 0.04 / weeksPerYear;
    const excess = [a, b].map((ticker) => tickerPathExcess(ticker, paths, "as_it_happened", riskFreeWeek));
    const outcome = bookOutcome([a, b], excess, 20, 52, riskFreeWeek, 0.04);
    // A week: T-bill + ½ × (0.01 × 0.2 + 1% − ½ T-bill) + ½ × (−1% − ½ T-bill) = ½ T-bill + 0.1%.
    const bookWeek = riskFreeWeek / 2 + 0.001;
    expect(outcome.cagr.p50).toBeCloseTo((1 + bookWeek) ** weeksPerYear - 1, 8);
    expect(outcome.averageYear.optionsIncome).toBeCloseTo(0.5 * 0.002 * weeksPerYear, 10);
    expect(outcome.averageYear.swings).toBeCloseTo(0, 10);
    expect(outcome.averageYear.treasuryBills).toBeCloseTo(0.5 * 0.04, 10);
    expect(outcome.maxDrawdown.p50).toBe(0);
    expect(outcome.tickers.reduce((sum, ticker) => sum + ticker.shareOfReturn!, 0)).toBeCloseTo(1, 10);
  });

  it("splits each path's fall between the tickers, the shares adding up to 1", () => {
    const history = Array.from({ length: 80 }, (_, index) => (index % 7 === 0 ? -0.05 : 0.01));
    const a = tickerOf("A", 0.7, history);
    const b = tickerOf("B", 0.3, history.map((value) => value / 2));
    const paths = drawPaths(80, 30, 50, 3);
    const excess = [a, b].map((ticker) => tickerPathExcess(ticker, paths, "as_it_happened", 0));
    const outcome = bookOutcome([a, b], excess, 50, 30, 0, 0);
    const [fallA, fallB] = outcome.tickers.map((ticker) => ticker.shareOfFall!);
    expect(fallA! + fallB!).toBeCloseTo(1, 10);
    // A holds 0.7 at the full move, B 0.3 at half of it: A's part 0.7 ÷ (0.7 + 0.15).
    expect(fallA).toBeCloseTo(0.7 / 0.85, 6);
    expect(outcome.maxDrawdownByPercentile).toHaveLength(101);
    expect(outcome.fan.p50).toHaveLength(31);
  });

  it("gives every book the same paths for the same seed (common random numbers)", () => {
    const history = Array.from({ length: 100 }, (_, index) => Math.sin(index) / 50);
    const a = tickerOf("A", 1, history);
    const first = tickerPathExcess(a, drawPaths(100, 26, 10, 9), "as_it_happened", 0).excess;
    const second = tickerPathExcess(a, drawPaths(100, 26, 10, 9), "as_it_happened", 0).excess;
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});

describe("replaysOf (P9)", () => {
  it("runs the book through a window's actual weeks", () => {
    const weeks = Array.from({ length: 60 }, (_, index) => new Date(Date.parse("2021-11-01T00:00:00Z") + index * 7 * 86_400_000).toISOString().slice(0, 10));
    const spyReturns = weeks.map((_, index) => (index === 0 ? null : -0.01));
    const market: MarketHistory = { weeks, spyReturns, spyIvs: weeks.map(() => 0.2), spyMedianIv: 0.2, spyMeanWeek: -0.01 };
    const ticker = tickerOf("A", 1, weeks.map(() => -0.01), { downCapture: 0.5 });
    const [replay] = replaysOf([ticker], market, 0);
    expect(replay?.name).toBe("2022");
    // The window's weeks: its Mondays from 2022-01-03 to 2022-10-10.
    const windowWeeks = weeks.filter((week) => week >= "2022-01-03" && week <= "2022-10-10").length;
    expect(replay?.spyReturn).toBeCloseTo(0.99 ** windowWeeks - 1, 10);
    expect(replay?.bookReturn).toBeCloseTo(0.995 ** windowWeeks - 1, 10);
  });
});
