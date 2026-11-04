import { seededRandom } from "../../lib/seededRandom.js";

// The suggestions' scores on the library (S1–S4, Marcelo 2026-11-04): a book's paths put together from its tickers' lone
// runs at its weights every day, the unallocated weight at the T-bill now (S1); a change's effect on CAGR and on Max
// drawdown as the average over the paths of (candidate − book), ± 2 standard errors of those differences (S2); its score,
// the change in Excess Calmar = (average CAGR − T-bill now) ÷ |average Max drawdown|, ± 2 bootstrap standard errors over
// the paths (S3); within noise when the score is within its ± (S4).

export interface PathFigures {
  cagr: Float64Array;
  maxDrawdown: Float64Array;
}

export interface WeightedReturns {
  /** The ticker's daily returns, path after path, `daysPerPath` each (portfolioLibrary.ts libraryDailyReturns). */
  returns: Float64Array;
  /** Its share of the account, 0.1 for 10%. */
  weight: number;
}

/** S1: each path's CAGR and Max drawdown over its first `horizonDays`, the book's day = Σ weight × the ticker's return + the cash's. */
export function combinedPathFigures(tickers: readonly WeightedReturns[], input: { pathCount: number; daysPerPath: number; horizonDays: number; riskFreeRatePercent: number; tradingDaysPerYear: number }): PathFigures {
  const cashWeight = Math.max(0, 1 - tickers.reduce((sum, ticker) => sum + ticker.weight, 0));
  const cashDay = input.riskFreeRatePercent / 100 / input.tradingDaysPerYear;
  const years = input.horizonDays / input.tradingDaysPerYear;
  const cagr = new Float64Array(input.pathCount);
  const maxDrawdown = new Float64Array(input.pathCount);
  for (let pathIndex = 0; pathIndex < input.pathCount; pathIndex++) {
    const offset = pathIndex * input.daysPerPath;
    let value = 1;
    let peak = 1;
    let worst = 0;
    for (let day = 0; day < input.horizonDays; day++) {
      let dayReturn = cashWeight * cashDay;
      for (const ticker of tickers) dayReturn += ticker.weight * ticker.returns[offset + day]!;
      value *= 1 + dayReturn;
      if (value > peak) peak = value;
      else if (value / peak - 1 < worst) worst = value / peak - 1;
    }
    cagr[pathIndex] = value ** (1 / years) - 1;
    maxDrawdown[pathIndex] = worst;
  }
  return { cagr, maxDrawdown };
}

const mean = (values: ArrayLike<number>, picks?: readonly number[]) => {
  let sum = 0;
  const count = picks?.length ?? values.length;
  for (let at = 0; at < count; at++) sum += values[picks ? picks[at]! : at]!;
  return sum / count;
};

/** Excess Calmar of averages: (average CAGR − T-bill now) ÷ |average Max drawdown| over the paths (or the paths picked). */
export function excessCalmarOfAverages(figures: PathFigures, riskFreeRatePercent: number, picks?: readonly number[]): number {
  return (mean(figures.cagr, picks) - riskFreeRatePercent / 100) / Math.abs(mean(figures.maxDrawdown, picks));
}

export interface ChangeWithPlusMinus {
  change: number;
  /** 2 standard errors. */
  plusMinus: number;
}

/** S2: the average over the paths of (candidate − book), ± 2 × the differences' standard deviation ÷ √paths. */
export function pairedChange(candidate: Float64Array, book: Float64Array): ChangeWithPlusMinus {
  const count = candidate.length;
  const differences = Array.from(candidate, (value, at) => value - book[at]!);
  const change = mean(differences);
  const variance = differences.reduce((sum, difference) => sum + (difference - change) ** 2, 0) / (count - 1);
  return { change, plusMinus: (2 * Math.sqrt(variance)) / Math.sqrt(count) };
}

export const scoreBootstrapResamples = 500;

/** S3: the change in Excess Calmar of averages, ± 2 × its bootstrap standard error (the same resampled paths for both). */
export function excessCalmarChange(candidate: PathFigures, book: PathFigures, riskFreeRatePercent: number, seed: number): ChangeWithPlusMinus {
  const change = excessCalmarOfAverages(candidate, riskFreeRatePercent) - excessCalmarOfAverages(book, riskFreeRatePercent);
  const random = seededRandom(seed);
  const count = candidate.cagr.length;
  const resampled: number[] = [];
  for (let resample = 0; resample < scoreBootstrapResamples; resample++) {
    const picks = Array.from({ length: count }, () => Math.floor(random() * count));
    resampled.push(excessCalmarOfAverages(candidate, riskFreeRatePercent, picks) - excessCalmarOfAverages(book, riskFreeRatePercent, picks));
  }
  const resampledMean = mean(resampled);
  const variance = resampled.reduce((sum, value) => sum + (value - resampledMean) ** 2, 0) / (resampled.length - 1);
  return { change, plusMinus: 2 * Math.sqrt(variance) };
}

export interface ScoredChange {
  score: ChangeWithPlusMinus;
  cagr: ChangeWithPlusMinus;
  maxDrawdown: ChangeWithPlusMinus;
  /** S4: the score within its ±. */
  withinNoise: boolean;
}

/** S2–S4 for one candidate against the book on the same paths. */
export function scoreChange(candidate: PathFigures, book: PathFigures, riskFreeRatePercent: number, seed: number): ScoredChange {
  const score = excessCalmarChange(candidate, book, riskFreeRatePercent, seed);
  return { score, cagr: pairedChange(candidate.cagr, book.cagr), maxDrawdown: pairedChange(candidate.maxDrawdown, book.maxDrawdown), withinNoise: Math.abs(score.change) <= score.plusMinus };
}
