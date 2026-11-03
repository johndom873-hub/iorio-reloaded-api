import { describe, expect, it } from "vitest";
import type { TickerHistory } from "./portfolioPaths.js";
import { drawPaths, tickerPathExcess, type ProjectedTicker } from "./portfolioProjection.js";
import { rankSuggestions, suggestionCandidatesOf } from "./portfolioSuggestions.js";

describe("suggestionCandidatesOf", () => {
  it("drops, halves, doubles and adds, every candidate's weights adding up to 1", () => {
    const book = new Map([
      ["A", 0.5],
      ["B", 0.3],
      ["C", 0.2],
    ]);
    const candidates = suggestionCandidatesOf(book, ["A", "D"]);
    // 3 drops + 3 halves + 3 doubles (each under 50%... A at 50% is not doubled) + 1 add (A is in the book).
    expect(candidates.filter((candidate) => candidate.kind === "drop")).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.kind === "double").map((candidate) => candidate.symbol)).toEqual(["B", "C"]);
    expect(candidates.filter((candidate) => candidate.kind === "add").map((candidate) => candidate.symbol)).toEqual(["D"]);
    for (const candidate of candidates) expect([...candidate.weights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    // Adding D to 3 tickers: D at 1 ÷ 4, A at 0.5 × 3 ÷ 4.
    const add = candidates.find((candidate) => candidate.kind === "add")!;
    expect(add.weights.get("D")).toBeCloseTo(0.25, 10);
    expect(add.weights.get("A")).toBeCloseTo(0.375, 10);
    // Dropping A: B 0.3 ÷ 0.5 = 0.6.
    expect(candidates.find((candidate) => candidate.kind === "drop" && candidate.symbol === "A")!.weights.get("B")).toBeCloseTo(0.6, 10);
  });
});

function historyOf(symbol: string, returns: number[]): TickerHistory {
  const count = returns.length;
  return { symbol, returns: Float64Array.from(returns), ownWeek: new Uint8Array(count).fill(1), ivs: new Float64Array(count).fill(0.2), ivsUncapped: new Float64Array(count).fill(0.2), residuals: Float64Array.from([0]), beta: 1, ownWeeks: count, neutralShift: 0, ivCap: null };
}

describe("rankSuggestions", () => {
  it("ranks first the change that raises the median Excess Calmar most", () => {
    // A rises with small dips; B rises about as much but falls hard every 10th week. Dropping B leaves a steadier book.
    const weeks = 200;
    const steady = Array.from({ length: weeks }, (_, index) => (index % 5 === 0 ? -0.002 : 0.0045));
    const rough = Array.from({ length: weeks }, (_, index) => (index % 10 === 0 ? -0.06 : 0.01));
    const histories = new Map([
      ["A", historyOf("A", steady)],
      ["B", historyOf("B", rough)],
    ]);
    const tickerFor = (symbol: string, weight: number): ProjectedTicker => ({ symbol, weight, lotScale: 1, premiumRatio: 0, callDaysPerWeek: 0, upCapture: 1, downCapture: 1, sharesHeldShare: 1, history: histories.get(symbol)! });
    const paths = drawPaths(weeks, 52, 200, 5);
    const excess = new Map([...histories.keys()].map((symbol) => [symbol, tickerPathExcess(tickerFor(symbol, 1), paths, "neutral", 0)]));
    const book = new Map([
      ["A", 0.5],
      ["B", 0.5],
    ]);
    const { baseline, suggestions } = rankSuggestions({ book, candidates: suggestionCandidatesOf(book, []), tickerFor, excessFor: (symbol) => excess.get(symbol)!, pathCount: 200, horizonWeeks: 52, riskFreeWeek: 0, riskFreeYear: 0 });
    expect(suggestions[0]).toMatchObject({ kind: "drop", symbol: "B" });
    expect(suggestions[0]!.excessCalmar).toBeGreaterThan(baseline.excessCalmar);
    for (const suggestion of suggestions) expect(suggestion.excessCalmarChange).toBeGreaterThan(0);
  });
});
