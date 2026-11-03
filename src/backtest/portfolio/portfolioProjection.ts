import { betaOf, drawPathWeeks, seededRandom, weeksPerYear, type MarketHistory, type TickerHistory } from "./portfolioPaths.js";

// The portfolio simulator's projection (P7–P9 and D1, D3–D5, approved by Marcelo 2026-11-03), weekly:
// - A ticker's week: T-bill + s × (k × IV × Call days + capture × the stock's move − shares held × T-bill), s its lot-fit
//   scale (1 at the analysis pot), IV the history week's IV before it, capture the up or down one by the move's sign. Its
//   three parts: options' income s × k × IV × Call days, swings s × capture × move, T-bills (1 − s × shares held) × T-bill.
//   Example (XLE, s 1, a week of IV 28.3%, 1.30 Call days and a 2% rise, T-bill 3.99%): 0.00926 × 0.283 × 1.30 = 0.341%,
//   0.588 × 2% = 1.176%, 0.365 × 3.99% ÷ 52.18 = 0.028%: 1.545% that week.
// - P7 the book's week = Σ allocation × the ticker's week (fixed weights, the shared pool's pots).
// - P8 2,000 paths of the horizon's weeks: each path's CAGR = its end value ^ (52.18 ÷ weeks) − 1, its Max drawdown on the
//   weekly values, its Excess Calmar = (CAGR − the T-bill now) ÷ |Max drawdown|; the 10th, 50th and 90th percentiles.
// - P9 replays: the book through the actual weeks of a window, a ticker not yet listed moving as β × SPY.
// - D1 the average year: each part's average week over every path × 52.18 (they add up to the average year, not exactly
//   the CAGR). D3 share of the fall: in each path's Max drawdown window, a ticker's part of the dollars lost (Σ over the
//   window's weeks of the value before the week × its allocation × its week) ÷ the book's, averaged over the paths with a
//   fall. D4 share of the return: allocation × the ticker's average week ÷ the book's average week. D5 book beta: the slope
//   of the book's weeks through the whole history on SPY's.

export interface ProjectedTicker {
  symbol: string;
  /** The allocation as a share of the book (0.05 for 5%). */
  weight: number;
  /** The lot-fit scale s. */
  lotScale: number;
  premiumRatio: number;
  callDaysPerWeek: number;
  upCapture: number;
  downCapture: number;
  sharesHeldShare: number;
  history: TickerHistory;
}

export type Drift = "as_it_happened" | "neutral";

/** A ticker's week less the T-bill, before the lot-fit scale: k × IV × Call days + capture × move − shares held × T-bill. */
export function excessWeek(ticker: Pick<ProjectedTicker, "premiumRatio" | "callDaysPerWeek" | "upCapture" | "downCapture" | "sharesHeldShare">, iv: number, stockMove: number, riskFreeWeek: number): number {
  return ticker.premiumRatio * iv * ticker.callDaysPerWeek + (stockMove > 0 ? ticker.upCapture : ticker.downCapture) * stockMove - ticker.sharesHeldShare * riskFreeWeek;
}

/** Each path's history weeks, shared by every ticker and both drifts. */
export function drawPaths(historyWeeks: number, horizonWeeks: number, pathCount: number, seed: number): Int32Array[] {
  const random = seededRandom(seed);
  return Array.from({ length: pathCount }, () => drawPathWeeks(random, historyWeeks, horizonWeeks));
}

const symbolSeed = (symbol: string, seed: number) => [...symbol].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0, (2166136261 ^ seed) >>> 0);

/**
 * One ticker's excess weeks on every path (paths × horizon, row by row), with its average options' income and swing a
 * week. The leftover weeks drawn before its listing come from a generator of its own, so the ticker moves the same
 * whatever book it is in.
 */
export function tickerPathExcess(ticker: ProjectedTicker, paths: readonly Int32Array[], drift: Drift, riskFreeWeek: number): { excess: Float32Array; meanPremiumWeek: number; meanSwingWeek: number } {
  const horizon = paths[0]?.length ?? 0;
  const excess = new Float32Array(paths.length * horizon);
  const random = seededRandom(symbolSeed(ticker.history.symbol, 7));
  const { returns, ownWeek, ivs, residuals, neutralShift } = ticker.history;
  const shift = drift === "neutral" ? neutralShift : 0;
  let premiumSum = 0;
  let swingSum = 0;
  let offset = 0;
  for (const path of paths) {
    for (let week = 0; week < horizon; week++) {
      const at = path[week]!;
      const leftover = ownWeek[at] === 1 ? 0 : residuals[Math.floor(random() * residuals.length)]!;
      const move = returns[at]! + leftover + shift;
      const iv = ivs[at - 1]!;
      const premium = ticker.premiumRatio * iv * ticker.callDaysPerWeek;
      const swing = (move > 0 ? ticker.upCapture : ticker.downCapture) * move;
      premiumSum += premium;
      swingSum += swing;
      excess[offset++] = premium + swing - ticker.sharesHeldShare * riskFreeWeek;
    }
  }
  const count = Math.max(1, paths.length * horizon);
  return { excess, meanPremiumWeek: premiumSum / count, meanSwingWeek: swingSum / count };
}

export interface PathFigures {
  cagr: number;
  maxDrawdown: number;
  excessCalmar: number | null;
}

export function pathFiguresOf(values: ArrayLike<number>, riskFreeYear: number): PathFigures & { peakIndex: number; troughIndex: number } {
  let peak = values[0]!;
  let peakAt = 0;
  let maxDrawdown = 0;
  let peakIndex = 0;
  let troughIndex = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value > peak) {
      peak = value;
      peakAt = index;
    }
    const drawdown = value / peak - 1;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      peakIndex = peakAt;
      troughIndex = index;
    }
  }
  const weeks = values.length - 1;
  const cagr = weeks > 0 ? (values[weeks]! / values[0]!) ** (weeksPerYear / weeks) - 1 : 0;
  return { cagr, maxDrawdown, excessCalmar: maxDrawdown < 0 ? (cagr - riskFreeYear) / Math.abs(maxDrawdown) : null, peakIndex, troughIndex };
}

/** The value at quantile q (0–1) of ascending `sorted`. */
export const quantileOf = (sorted: ArrayLike<number>, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
}

/** NaN (null in JSON) when no path gives a value: a book that never falls has no Excess Calmar. */
const percentilesOf = (values: number[]): Percentiles => {
  if (values.length === 0) return { p10: Number.NaN, p50: Number.NaN, p90: Number.NaN };
  const sorted = Float64Array.from(values).sort();
  return { p10: quantileOf(sorted, 0.1), p50: quantileOf(sorted, 0.5), p90: quantileOf(sorted, 0.9) };
};

export interface BookOutcome {
  paths: number;
  horizonWeeks: number;
  cagr: Percentiles;
  maxDrawdown: Percentiles;
  excessCalmar: Percentiles;
  /** Max drawdown at every whole percentile, ascending (index 0 the worst path): the chance of a fall worse than X. */
  maxDrawdownByPercentile: number[];
  /** The book's value (1 at the start) each week: 10th, 50th and 90th percentile. */
  fan: { p10: number[]; p50: number[]; p90: number[] };
  averageYear: { optionsIncome: number; swings: number; treasuryBills: number; total: number };
  tickers: { symbol: string; shareOfFall: number | null; shareOfReturn: number | null; averageYear: number }[];
}

/** P7, P8, D1, D3 and D4 for a book: `excessByTicker` from tickerPathExcess on the same paths and drift. */
export function bookOutcome(tickers: readonly ProjectedTicker[], excessByTicker: readonly ReturnType<typeof tickerPathExcess>[], pathCount: number, horizonWeeks: number, riskFreeWeek: number, riskFreeYear: number, withPathDetail = true): BookOutcome {
  const cagrs: number[] = [];
  const drawdowns: number[] = [];
  const calmars: number[] = [];
  const fanValues = withPathDetail ? Array.from({ length: horizonWeeks + 1 }, () => new Float64Array(pathCount)) : [];
  const fallShares = tickers.map(() => 0);
  let pathsWithFall = 0;
  const values = new Float64Array(horizonWeeks + 1);
  const scaled = tickers.map((ticker) => ticker.weight * ticker.lotScale);
  let bookWeekSum = 0;
  const tickerWeekSums = tickers.map(() => 0);
  for (let path = 0; path < pathCount; path++) {
    values[0] = 1;
    const base = path * horizonWeeks;
    for (let week = 0; week < horizonWeeks; week++) {
      let bookWeek = riskFreeWeek;
      for (let ticker = 0; ticker < tickers.length; ticker++) {
        const part = scaled[ticker]! * excessByTicker[ticker]!.excess[base + week]!;
        bookWeek += part;
        tickerWeekSums[ticker] = tickerWeekSums[ticker]! + tickers[ticker]!.weight * riskFreeWeek + part;
      }
      bookWeekSum += bookWeek;
      values[week + 1] = values[week]! * (1 + bookWeek);
    }
    const figures = pathFiguresOf(values, riskFreeYear);
    cagrs.push(figures.cagr);
    drawdowns.push(figures.maxDrawdown);
    if (figures.excessCalmar !== null) calmars.push(figures.excessCalmar);
    if (!withPathDetail) continue;
    for (let week = 0; week <= horizonWeeks; week++) fanValues[week]![path] = values[week]!;
    if (figures.maxDrawdown < 0) {
      const parts = tickers.map(() => 0);
      let total = 0;
      for (let week = figures.peakIndex; week < figures.troughIndex; week++) {
        for (let ticker = 0; ticker < tickers.length; ticker++) {
          const dollars = values[week]! * (tickers[ticker]!.weight * riskFreeWeek + scaled[ticker]! * excessByTicker[ticker]!.excess[base + week]!);
          parts[ticker] = parts[ticker]! + dollars;
          total += dollars;
        }
      }
      if (total < 0) {
        pathsWithFall += 1;
        parts.forEach((dollars, ticker) => (fallShares[ticker] = fallShares[ticker]! + dollars / total));
      }
    }
  }
  const sortedDrawdowns = Float64Array.from(drawdowns).sort();
  const weekCount = pathCount * horizonWeeks;
  const optionsIncome = tickers.reduce((sum, ticker, index) => sum + scaled[index]! * excessByTicker[index]!.meanPremiumWeek, 0) * weeksPerYear;
  const swings = tickers.reduce((sum, ticker, index) => sum + scaled[index]! * excessByTicker[index]!.meanSwingWeek, 0) * weeksPerYear;
  const treasuryBills = (1 - tickers.reduce((sum, ticker, index) => sum + scaled[index]! * ticker.sharesHeldShare, 0)) * riskFreeWeek * weeksPerYear;
  const bookAverageWeek = bookWeekSum / weekCount;
  return {
    paths: pathCount,
    horizonWeeks,
    cagr: percentilesOf(cagrs),
    maxDrawdown: percentilesOf(drawdowns),
    excessCalmar: percentilesOf(calmars),
    maxDrawdownByPercentile: Array.from({ length: 101 }, (_, percentile) => quantileOf(sortedDrawdowns, percentile / 100)),
    fan: withPathDetail
      ? {
          p10: fanValues.map((week) => quantileOf(week.sort(), 0.1)),
          p50: fanValues.map((week) => quantileOf(week, 0.5)),
          p90: fanValues.map((week) => quantileOf(week, 0.9)),
        }
      : { p10: [], p50: [], p90: [] },
    averageYear: { optionsIncome, swings, treasuryBills, total: optionsIncome + swings + treasuryBills },
    tickers: tickers.map((ticker, index) => ({
      symbol: ticker.history.symbol,
      shareOfFall: withPathDetail && pathsWithFall > 0 ? fallShares[index]! / pathsWithFall : null,
      shareOfReturn: bookAverageWeek !== 0 ? tickerWeekSums[index]! / weekCount / bookAverageWeek : null,
      averageYear: (tickerWeekSums[index]! / weekCount / Math.max(ticker.weight, 1e-12)) * weeksPerYear,
    })),
  };
}

export const replayWindows = [
  { name: "2008", from: "2007-10-08", to: "2009-03-09" },
  { name: "Covid", from: "2020-02-17", to: "2020-03-23" },
  { name: "2022", from: "2022-01-03", to: "2022-10-10" },
] as const;

export interface Replay {
  name: string;
  from: string;
  to: string;
  bookReturn: number;
  worstFall: number;
  spyReturn: number;
}

/** A ticker's week through the actual history at `at` (no leftover drawn before its listing), IV capped or not. */
function historyWeek(ticker: ProjectedTicker, at: number, riskFreeWeek: number, capped: boolean): number {
  const ivs = capped ? ticker.history.ivs : ticker.history.ivsUncapped;
  return riskFreeWeek + ticker.lotScale * excessWeek(ticker, ivs[at - 1] ?? ivs[at]!, ticker.history.returns[at]!, riskFreeWeek);
}

/** P9: the book through each window's actual weeks. */
export function replaysOf(tickers: readonly ProjectedTicker[], market: MarketHistory, riskFreeWeek: number, capped = true): Replay[] {
  return replayWindows.flatMap((window) => {
    const first = market.weeks.findIndex((week) => week >= window.from);
    if (first < 1 || market.weeks.at(-1)! < window.to) return [];
    let value = 1;
    let peak = 1;
    let worstFall = 0;
    let spy = 1;
    for (let at = first; at < market.weeks.length && market.weeks[at]! <= window.to; at++) {
      value *= 1 + tickers.reduce((sum, ticker) => sum + ticker.weight * historyWeek(ticker, at, riskFreeWeek, capped), 0);
      spy *= 1 + (market.spyReturns[at] ?? 0);
      peak = Math.max(peak, value);
      worstFall = Math.min(worstFall, value / peak - 1);
    }
    return [{ name: window.name, from: window.from, to: window.to, bookReturn: value - 1, worstFall, spyReturn: spy - 1 }];
  });
}

/** D5: the slope of the book's weeks through the whole history on SPY's. */
export function bookBetaOf(tickers: readonly ProjectedTicker[], market: MarketHistory, riskFreeWeek: number): number {
  const book: (number | null)[] = market.weeks.map((_, at) => (at === 0 ? null : tickers.reduce((sum, ticker) => sum + ticker.weight * historyWeek(ticker, at, riskFreeWeek, true), 0)));
  return betaOf(book, market.spyReturns).beta;
}
