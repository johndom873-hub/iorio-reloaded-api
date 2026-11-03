import { describe, expect, it } from "vitest";
import type { TickerHistory } from "./portfolioPaths.js";
import { correlationOf, groupsOf, independentTickersOf, pairMatrixOf, worstWeeksTogetherOf } from "./portfolioCorrelation.js";

function historyOf(symbol: string, returns: number[]): TickerHistory {
  const count = returns.length;
  return { symbol, returns: Float64Array.from(returns), ownWeek: new Uint8Array(count).fill(1), ivs: new Float64Array(count), ivsUncapped: new Float64Array(count), residuals: Float64Array.from([0]), beta: 1, ownWeeks: count, neutralShift: 0, ivCap: null };
}

const wave = (count: number, phase: number) => Array.from({ length: count }, (_, index) => Math.sin(index * 0.7 + phase) / 100);

describe("correlation and worst weeks together", () => {
  const a = historyOf("A", wave(200, 0));
  const same = historyOf("B", wave(200, 0).map((value) => value * 2));
  const opposite = historyOf("C", wave(200, 0).map((value) => -value));

  it("reads 1 for a ticker moving as another and −1 for its opposite", () => {
    expect(correlationOf(a, same)).toBeCloseTo(1, 10);
    expect(correlationOf(a, opposite)).toBeCloseTo(-1, 10);
  });

  it("finds every worst week shared with a ticker moving the same way, none with its opposite", () => {
    expect(worstWeeksTogetherOf(a, same)).toBe(1);
    expect(worstWeeksTogetherOf(a, opposite)).toBe(0);
  });

  it("gives no figure on fewer than 52 shared weeks", () => {
    const short = historyOf("D", wave(200, 0));
    short.ownWeek.fill(0, 0, 160);
    expect(correlationOf(a, short)).toBeNull();
  });
});

describe("groupsOf", () => {
  it("joins tickers whose average worst weeks together is 50% or more", () => {
    const matrix = { symbols: ["A", "B", "C", "D"], values: [
      [1, 0.8, 0.6, 0.1],
      [0.8, 1, 0.5, 0.1],
      [0.6, 0.5, 1, 0.1],
      [0.1, 0.1, 0.1, 1],
    ] };
    // A–B join at 80%; C joins them at (60 + 50) ÷ 2 = 55%; D stays alone.
    expect(groupsOf(matrix)).toEqual([[0, 1, 2], [3]]);
  });
});

describe("independentTickersOf (D2)", () => {
  it("is N for N unrelated tickers on equal shares and 1 for N moving as one", () => {
    const unrelated = { symbols: ["A", "B", "C", "D"], values: [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0))) };
    const together = { symbols: ["A", "B", "C", "D"], values: [0, 1, 2, 3].map(() => [1, 1, 1, 1]) };
    expect(independentTickersOf(unrelated, [0.25, 0.25, 0.25, 0.25])).toBeCloseTo(4, 10);
    expect(independentTickersOf(together, [0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 10);
  });

  it("reads 41 equal tickers at an average correlation of 0.318 as about 3", () => {
    const n = 41;
    const matrix = { symbols: Array.from({ length: n }, (_, index) => `T${index}`), values: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0.318))) };
    expect(independentTickersOf(matrix, Array(n).fill(1 / n))).toBeCloseTo(1 / (1 / n + ((n - 1) / n) * 0.318), 10);
    expect(independentTickersOf(matrix, Array(n).fill(1 / n))).toBeCloseTo(3.0, 1);
  });
});

describe("pairMatrixOf", () => {
  it("is symmetric with 1 on the diagonal", () => {
    const matrix = pairMatrixOf([historyOf("A", wave(100, 0)), historyOf("B", wave(100, 1))], correlationOf);
    expect(matrix.values[0]![0]).toBe(1);
    expect(matrix.values[0]![1]).toBe(matrix.values[1]![0]);
  });
});
