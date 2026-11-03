import { bookOutcome, type ProjectedTicker, type tickerPathExcess } from "./portfolioProjection.js";

// The portfolio simulator's suggestions (approved by Marcelo 2026-11-03): one change at a time, each scored on the neutral
// projection's median Excess Calmar, every candidate on the same paths so a difference is the change, not the draw:
// - drop a ticker (the others keep their proportions, back to 100%);
// - add a ticker v4 suits at an equal share, 1 ÷ (N + 1), the others scaled by N ÷ (N + 1);
// - halve or double one ticker's allocation, the others scaled to keep 100%.
// The changes that raise the median Excess Calmar come first, the largest rise first.

export type SuggestionKind = "drop" | "add" | "halve" | "double";

export interface SuggestionCandidate {
  kind: SuggestionKind;
  symbol: string;
  /** Each ticker's share of the book after the change (adding up to 1). */
  weights: Map<string, number>;
}

export interface Suggestion {
  kind: SuggestionKind;
  symbol: string;
  /** Allocation % after the change, for Apply. */
  allocationsPct: Record<string, number>;
  excessCalmar: number;
  excessCalmarChange: number;
  cagr: number;
  cagrChange: number;
  maxDrawdown: number;
  maxDrawdownChange: number;
}

const scaledToOne = (weights: Map<string, number>) => {
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return new Map([...weights].map(([symbol, weight]) => [symbol, total > 0 ? weight / total : 0]));
};

/** Every one-change candidate of `book` (weights adding up to 1), adding from `addable`. */
export function suggestionCandidatesOf(book: ReadonlyMap<string, number>, addable: readonly string[]): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  const symbols = [...book.keys()];
  for (const symbol of symbols) {
    if (symbols.length > 1) candidates.push({ kind: "drop", symbol, weights: scaledToOne(new Map([...book].filter(([other]) => other !== symbol))) });
    candidates.push({ kind: "halve", symbol, weights: scaledToOne(new Map([...book].map(([other, weight]) => [other, other === symbol ? weight / 2 : weight]))) });
    if (book.get(symbol)! < 0.5) candidates.push({ kind: "double", symbol, weights: scaledToOne(new Map([...book].map(([other, weight]) => [other, other === symbol ? weight * 2 : weight]))) });
  }
  const share = 1 / (symbols.length + 1);
  for (const symbol of addable) {
    if (book.has(symbol)) continue;
    candidates.push({ kind: "add", symbol, weights: new Map([...[...book].map(([other, weight]) => [other, weight * (1 - share)] as const), [symbol, share]]) });
  }
  return candidates;
}

/**
 * Scores every candidate: `tickerFor(symbol, weight)` gives the ticker at that weight (its lot-fit scale follows its pot),
 * `excessFor(symbol)` its neutral excess weeks on the shared paths.
 */
export function rankSuggestions(input: {
  book: ReadonlyMap<string, number>;
  candidates: readonly SuggestionCandidate[];
  tickerFor: (symbol: string, weight: number) => ProjectedTicker;
  excessFor: (symbol: string) => ReturnType<typeof tickerPathExcess>;
  pathCount: number;
  horizonWeeks: number;
  riskFreeWeek: number;
  riskFreeYear: number;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}): { baseline: { excessCalmar: number; cagr: number; maxDrawdown: number }; suggestions: Suggestion[] } {
  const score = (weights: ReadonlyMap<string, number>) => {
    const symbols = [...weights.keys()];
    const outcome = bookOutcome(
      symbols.map((symbol) => input.tickerFor(symbol, weights.get(symbol)!)),
      symbols.map((symbol) => input.excessFor(symbol)),
      input.pathCount,
      input.horizonWeeks,
      input.riskFreeWeek,
      input.riskFreeYear,
      false,
    );
    return { excessCalmar: outcome.excessCalmar.p50, cagr: outcome.cagr.p50, maxDrawdown: outcome.maxDrawdown.p50 };
  };
  const baseline = score(input.book);
  const scored: Suggestion[] = [];
  input.candidates.forEach((candidate, index) => {
    const result = score(candidate.weights);
    input.onProgress?.(index + 1, input.candidates.length);
    if (result.excessCalmar <= baseline.excessCalmar) return;
    scored.push({
      kind: candidate.kind,
      symbol: candidate.symbol,
      allocationsPct: Object.fromEntries([...candidate.weights].map(([symbol, weight]) => [symbol, Number((weight * 100).toFixed(4))])),
      excessCalmar: result.excessCalmar,
      excessCalmarChange: result.excessCalmar - baseline.excessCalmar,
      cagr: result.cagr,
      cagrChange: result.cagr - baseline.cagr,
      maxDrawdown: result.maxDrawdown,
      maxDrawdownChange: result.maxDrawdown - baseline.maxDrawdown,
    });
  });
  scored.sort((a, b) => b.excessCalmarChange - a.excessCalmarChange);
  return { baseline, suggestions: scored.slice(0, input.limit ?? 5) };
}
