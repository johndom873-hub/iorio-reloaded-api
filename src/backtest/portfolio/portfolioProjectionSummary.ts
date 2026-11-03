import type { PathOutcome } from "./portfolioDayProjection.js";

// The projection's figures over its paths (D6, Marcelo 2026-11-03): each path's CAGR, its Max drawdown on the daily
// values and its Excess Calmar = (CAGR − the T-bill now) ÷ |Max drawdown|, as the 10th, 50th and 90th percentiles; the
// share of paths whose Max drawdown is worse than each threshold; the average year of each source (Calls, Puts, LEAPS,
// T-bills, shares: the account's change, from the book's own records) in dollars and as a share of the starting account;
// the account at each year's end; and each ticker's average year. Example: 200 paths, 37 of them with a Max drawdown
// worse than −30%: 18.5%.

export const fallThresholds = [-0.1, -0.2, -0.3, -0.4] as const;

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

export interface ProjectionSummary {
  pathCount: number;
  cagr: Percentiles;
  maxDrawdown: Percentiles;
  excessCalmar: Percentiles;
  /** The share of paths whose Max drawdown is worse than each of fallThresholds. */
  fallWorseThan: { threshold: number; share: number }[];
  /** The average year of each source over every path, dollars and ÷ the starting account. */
  averageYear: Record<"calls" | "puts" | "leaps" | "interest" | "shares", { dollars: number; share: number }>;
  /** The account at each simulated year's end. */
  yearEnds: { year: number; value: Percentiles }[];
  tickers: { symbol: string; premiumYear: number; callsSoldYear: number; callAwaysYear: number; daysWithoutSharesShare: number }[];
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
    fallWorseThan: fallThresholds.map((threshold) => ({ threshold, share: outcomes.filter((outcome) => outcome.maxDrawdown < threshold).length / count })),
    averageYear: {
      calls: yearEntry((outcome) => outcome.sources.callsDollars),
      puts: yearEntry((outcome) => outcome.sources.putsDollars),
      leaps: yearEntry((outcome) => outcome.sources.leapsDollars),
      interest: yearEntry((outcome) => outcome.sources.interestDollars),
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
  };
}
