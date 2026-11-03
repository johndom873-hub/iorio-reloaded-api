import type { TickerHistory } from "./portfolioPaths.js";

// How a book's tickers move together (approved by Marcelo 2026-11-03), on their own weekly moves since 2006, the weeks both
// traded:
// - Correlation: cov ÷ √(var × var).
// - Worst weeks together: of A's worst 10% of the shared weeks, the share also among B's worst 10% (the same count for
//   both, so it reads the same both ways). Unrelated tickers score about 10%. QQQ–SPY 77%, TLT–XLE 5%. Correlation on SPY's
//   down weeks was dropped: keeping only those weeks removes most of the market's own move, so it reads lower than on
//   every week (0.24 against 0.32 on 41 tickers).
// - Groups: tickers joined by average linkage while the two groups' average worst weeks together is 50% or more.
// - D2, moves like N independent tickers: 1 ÷ Σᵢ Σⱼ wᵢ wⱼ ρᵢⱼ (ρᵢᵢ = 1; a pair with too few shared weeks counts 0).
//   Example: 41 equal tickers, average correlation 0.318: 3.0.

export const worstWeeksShare = 0.1;
export const groupLinkThreshold = 0.5;
/** Fewer shared weeks than this give no figure. */
export const minimumSharedWeeks = 52;

function sharedWeeks(a: TickerHistory, b: TickerHistory): number[] {
  const shared: number[] = [];
  for (let index = 1; index < a.returns.length; index++) if (a.ownWeek[index] === 1 && b.ownWeek[index] === 1) shared.push(index);
  return shared;
}

export function correlationOf(a: TickerHistory, b: TickerHistory): number | null {
  const shared = sharedWeeks(a, b);
  if (shared.length < minimumSharedWeeks) return null;
  let meanA = 0;
  let meanB = 0;
  for (const index of shared) {
    meanA += a.returns[index]!;
    meanB += b.returns[index]!;
  }
  meanA /= shared.length;
  meanB /= shared.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const index of shared) {
    const deviationA = a.returns[index]! - meanA;
    const deviationB = b.returns[index]! - meanB;
    covariance += deviationA * deviationB;
    varianceA += deviationA ** 2;
    varianceB += deviationB ** 2;
  }
  return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

export function worstWeeksTogetherOf(a: TickerHistory, b: TickerHistory): number | null {
  const shared = sharedWeeks(a, b);
  if (shared.length < minimumSharedWeeks) return null;
  const count = Math.max(1, Math.floor(shared.length * worstWeeksShare));
  const worstOf = (ticker: TickerHistory) => new Set([...shared].sort((x, y) => ticker.returns[x]! - ticker.returns[y]!).slice(0, count));
  const worstA = worstOf(a);
  const worstB = worstOf(b);
  let together = 0;
  for (const index of worstA) if (worstB.has(index)) together += 1;
  return together / count;
}

export interface PairMatrix {
  symbols: string[];
  /** [i][j], null where the pair shares too few weeks; 1 on the diagonal. */
  values: (number | null)[][];
}

export function pairMatrixOf(tickers: readonly TickerHistory[], measure: (a: TickerHistory, b: TickerHistory) => number | null): PairMatrix {
  const values = tickers.map(() => tickers.map(() => null as number | null));
  for (let i = 0; i < tickers.length; i++) {
    values[i]![i] = 1;
    for (let j = i + 1; j < tickers.length; j++) {
      const value = measure(tickers[i]!, tickers[j]!);
      values[i]![j] = value;
      values[j]![i] = value;
    }
  }
  return { symbols: tickers.map((ticker) => ticker.symbol), values };
}

/** Average linkage on worst weeks together: groups merged while their average is at least the threshold; singletons kept. */
export function groupsOf(matrix: PairMatrix, threshold = groupLinkThreshold): number[][] {
  let groups = matrix.symbols.map((_, index) => [index]);
  const averageBetween = (a: number[], b: number[]) => {
    let sum = 0;
    let count = 0;
    for (const i of a)
      for (const j of b) {
        const value = matrix.values[i]![j];
        if (value !== null && value !== undefined) {
          sum += value;
          count += 1;
        }
      }
    return count === 0 ? null : sum / count;
  };
  for (;;) {
    let best: { a: number; b: number; average: number } | null = null;
    for (let a = 0; a < groups.length; a++)
      for (let b = a + 1; b < groups.length; b++) {
        const average = averageBetween(groups[a]!, groups[b]!);
        if (average !== null && average >= threshold && (best === null || average > best.average)) best = { a, b, average };
      }
    if (best === null) return groups.map((group) => [...group].sort((x, y) => x - y)).sort((x, y) => y.length - x.length || x[0]! - y[0]!);
    const merged = [...groups[best.a]!, ...groups[best.b]!];
    groups = groups.filter((_, index) => index !== best!.a && index !== best!.b);
    groups.push(merged);
  }
}

/** D2: 1 ÷ Σᵢ Σⱼ wᵢ wⱼ ρᵢⱼ, the weights adding up to 1. */
export function independentTickersOf(correlation: PairMatrix, weights: readonly number[]): number | null {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) for (let j = 0; j < weights.length; j++) sum += weights[i]! * weights[j]! * (correlation.values[i]![j] ?? 0);
  return sum > 0 ? 1 / sum : null;
}
