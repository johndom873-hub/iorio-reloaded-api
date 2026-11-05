import type { PathOutcome, RegressionSums } from "./portfolioDayProjection.js";

// The projection's figures over its paths (D6, Marcelo 2026-11-03): each path's CAGR, its Max drawdown on the daily
// values and its Excess Calmar = (CAGR − the T-bill now) ÷ |Max drawdown|, as the 10th, 50th and 90th percentiles; the
// Max drawdown reached in 1 path in 10, 20 and 100 (drawdownAtOddsOf); the average year of each source (Calls, Puts,
// LEAPS, T-bills, dividends, shares: the account's change, from the book's own records) in dollars and as a share of the starting
// account; the account at each year's end; and each ticker's average year. Book betas (Marcelo 2026-11-04): the least-squares slope of the book's daily return (10:00 to
// 10:00, the account's own marks) on SPY's simple return over the same stretch of history, over every day of every path,
// and over the days SPY fell (the downside beta).
// Example: the book's days lining up as 0.6 × SPY's plus noise give 0.6: a 10% SPY fall typically comes with a 6% fall.

/** The odds a Max drawdown is read at (Marcelo 2026-11-04): the fall reached in 1 path in 10, in 20 and in 100. */
export const drawdownOdds = [10, 20, 100] as const;

/**
 * The Max drawdown reached in 1 path in N: the value at floor(n ÷ N) of the paths' Max drawdowns sorted from the worst
 * (the percentiles' convention). Example: 500 paths, 1 in 20: the 26th worst.
 */
export function drawdownAtOddsOf(maxDrawdowns: ArrayLike<number>): { oneIn: number; maxDrawdown: number }[] {
  const sorted = Array.from(maxDrawdowns).sort((a, b) => a - b);
  return drawdownOdds.map((oneIn) => ({ oneIn, maxDrawdown: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / oneIn))]! }));
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
}

/** The 10th, 50th and 90th percentiles: the value at floor(q × n) of the sorted values. */
export function percentilesOf(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/** A path's figures summed up over the paths: v4's own, the book held, SPY held. */
export interface HeldSummary {
  cagr: Percentiles;
  maxDrawdown: Percentiles;
  /** The account's lowest value against the start, −30% for a low 30% under it (0 when it never went under). */
  lowestAgainstStart: Percentiles;
  /** That low reached in 1 path in 10, 20 and 100, at the drawdown odds' convention. */
  lowestAgainstStartAtOdds: { oneIn: number; lowestAgainstStart: number }[];
  /** The account at each simulated year's end. */
  yearEnds: { year: number; value: Percentiles }[];
}

function heldSummaryOf(figures: readonly { cagr: number; maxDrawdown: number; lowestAgainstStart: number; yearEndValues: readonly number[] }[]): HeldSummary {
  const lows = figures.map((figure) => figure.lowestAgainstStart);
  return {
    yearEnds: (figures[0]?.yearEndValues ?? []).map((_, index) => ({ year: index + 1, value: percentilesOf(figures.map((figure) => figure.yearEndValues[index]!)) })),
    cagr: percentilesOf(figures.map((figure) => figure.cagr)),
    maxDrawdown: percentilesOf(figures.map((figure) => figure.maxDrawdown)),
    lowestAgainstStart: percentilesOf(lows),
    lowestAgainstStartAtOdds: drawdownAtOddsOf(lows).map((entry) => ({ oneIn: entry.oneIn, lowestAgainstStart: entry.maxDrawdown })),
  };
}

export interface ProjectionSummary {
  pathCount: number;
  cagr: Percentiles;
  maxDrawdown: Percentiles;
  excessCalmar: Percentiles;
  /** The Max drawdown reached in 1 path in 10, 20 and 100 (drawdownAtOddsOf). */
  drawdownAtOdds: { oneIn: number; maxDrawdown: number }[];
  /** The average year of each source over every path, dollars and ÷ the starting account. */
  averageYear: Record<"calls" | "puts" | "leaps" | "interest" | "dividends" | "shares", { dollars: number; share: number }>;
  /** The account at each simulated year's end. */
  yearEnds: { year: number; value: Percentiles }[];
  tickers: { symbol: string; premiumYear: number; callsSoldYear: number; callAwaysYear: number; daysWithoutSharesShare: number }[];
  /** The book's beta on SPY over every day, and over the days SPY fell; null without the regression. */
  bookBeta: { all: number; down: number } | null;
  /** v4's lowest against the start, and on the same paths the book and SPY held (Marcelo 2026-11-04); spy null without it. */
  v4: HeldSummary;
  heldBook: HeldSummary;
  heldSpy: HeldSummary | null;
}

/** The least-squares slope of the pooled sums: (n Σxy − Σx Σy) ÷ (n Σx² − (Σx)²). */
export function slopeOfSums(sums: readonly RegressionSums[]): number {
  let count = 0;
  let sumSpy = 0;
  let sumBook = 0;
  let sumSpyBook = 0;
  let sumSpySquared = 0;
  for (const part of sums) {
    count += part.count;
    sumSpy += part.sumSpy;
    sumBook += part.sumBook;
    sumSpyBook += part.sumSpyBook;
    sumSpySquared += part.sumSpySquared;
  }
  return (count * sumSpyBook - sumSpy * sumBook) / (count * sumSpySquared - sumSpy * sumSpy);
}

export function summarizeProjection(outcomes: readonly PathOutcome[], input: { accountDollars: number; horizonYears: number; riskFreeRatePercent: number; horizonDays: number }): ProjectionSummary {
  const riskFree = input.riskFreeRatePercent / 100;
  const count = outcomes.length;
  const perYear = (pick: (outcome: PathOutcome) => number) => outcomes.reduce((sum, outcome) => sum + pick(outcome), 0) / count / input.horizonYears;
  const yearEntry = (pick: (outcome: PathOutcome) => number) => {
    const dollars = perYear(pick);
    return { dollars, share: dollars / input.accountDollars };
  };
  const symbols = outcomes[0]?.byTicker.map((ticker) => ticker.symbol) ?? [];
  return {
    pathCount: count,
    cagr: percentilesOf(outcomes.map((outcome) => outcome.cagr)),
    maxDrawdown: percentilesOf(outcomes.map((outcome) => outcome.maxDrawdown)),
    excessCalmar: percentilesOf(outcomes.map((outcome) => (outcome.maxDrawdown < 0 ? (outcome.cagr - riskFree) / -outcome.maxDrawdown : Number.POSITIVE_INFINITY))),
    drawdownAtOdds: drawdownAtOddsOf(outcomes.map((outcome) => outcome.maxDrawdown)),
    averageYear: {
      calls: yearEntry((outcome) => outcome.sources.callsDollars),
      puts: yearEntry((outcome) => outcome.sources.putsDollars),
      leaps: yearEntry((outcome) => outcome.sources.leapsDollars),
      interest: yearEntry((outcome) => outcome.sources.interestDollars),
      dividends: yearEntry((outcome) => outcome.sources.dividendsDollars),
      shares: yearEntry((outcome) => outcome.sources.sharesDollars),
    },
    yearEnds: (outcomes[0]?.yearEndValues ?? []).map((_, index) => ({ year: index + 1, value: percentilesOf(outcomes.map((outcome) => outcome.yearEndValues[index]!)) })),
    tickers: symbols.map((symbol, index) => ({
      symbol,
      premiumYear: perYear((outcome) => outcome.byTicker[index]!.premiumDollars),
      callsSoldYear: perYear((outcome) => outcome.byTicker[index]!.callsSold),
      callAwaysYear: perYear((outcome) => outcome.byTicker[index]!.callAways),
      daysWithoutSharesShare: outcomes.reduce((sum, outcome) => sum + outcome.byTicker[index]!.daysWithoutShares, 0) / count / input.horizonDays,
    })),
    bookBeta: outcomes.length > 0 && outcomes.every((outcome) => outcome.spyRegression !== null) ? { all: slopeOfSums(outcomes.map((outcome) => outcome.spyRegression!.all)), down: slopeOfSums(outcomes.map((outcome) => outcome.spyRegression!.down)) } : null,
    v4: heldSummaryOf(outcomes),
    heldBook: heldSummaryOf(outcomes.map((outcome) => outcome.heldBook)),
    heldSpy: outcomes.length > 0 && outcomes.every((outcome) => outcome.heldSpy !== null) ? heldSummaryOf(outcomes.map((outcome) => outcome.heldSpy!)) : null,
  };
}
