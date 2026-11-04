// The portfolio simulator's one-change candidates (approved by Marcelo 2026-11-03; scored on the library,
// portfolioLibrarySuggestions.ts):
// - drop a ticker (the others keep their proportions, back to 100%);
// - add a ticker v4 suits at an equal share, 1 ÷ (N + 1), the others scaled by N ÷ (N + 1);
// - halve or double one ticker's allocation, the others scaled to keep 100%.

export type SuggestionKind = "drop" | "add" | "halve" | "double";

export interface SuggestionCandidate {
  kind: SuggestionKind;
  symbol: string;
  /** Each ticker's share of the book after the change (adding up to 1). */
  weights: Map<string, number>;
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
