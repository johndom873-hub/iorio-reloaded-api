import { describe, expect, it } from "vitest";
import { suggestionCandidatesOf } from "./portfolioSuggestions.js";

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
