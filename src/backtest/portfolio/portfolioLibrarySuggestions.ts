import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { readBacktestDataFileContents } from "../dataFileSummary.js";
import { effectiveAllocationPctBySymbol } from "../../lib/tickerAllocation.js";
import { marketDayHistoryOf, tradingDaysPerYear } from "./portfolioDayHistory.js";
import { libraryDailyReturns, libraryGlobalKey, readLibraryManifest, type LibraryManifest } from "./portfolioLibrary.js";
import { combinedPathFigures, excessCalmarOfAverages, scoreChange, type PathFigures, type ScoredChange } from "./portfolioLibraryScoring.js";
import { maxAllocationPct } from "./portfolioPots.js";
import { loadProjectionContext, projectionSeed } from "./portfolioProjectionContext.js";
import { projectPortfolio } from "./portfolioProjectionStore.js";
import { listPortfolioTickers, PortfolioRequestError, type PortfolioBookRequest } from "./portfolioSimulatorStore.js";
import { suggestionCandidatesOf, type SuggestionKind } from "./portfolioSuggestions.js";

// The portfolio simulator's suggestions on the library (S1–S5, Marcelo 2026-11-04): every one-change candidate of the book
// (drop a ticker, add one v4 suits at an equal share, halve or double one; none above 25%) scored on the library in
// seconds and sent at once; then the best 5 and the book projected exactly (500 paths, the shared account, the same paths)
// and their exact scores sent as they finish.

export const confirmedSuggestionCount = 5;
const confirmationPathCount = 500;

export interface LibraryStatus {
  asOf: string;
  builtAt: string;
  /** Why the library is not current for this book (another day, other settings or code, a ticker updated since); empty when it is. */
  staleReasons: string[];
}

export interface BookFigures {
  cagr: number;
  maxDrawdown: number;
  excessCalmar: number;
}

export interface LibrarySuggestion extends ScoredChange {
  kind: SuggestionKind;
  symbol: string;
  /** Allocation % after the change, for Apply. */
  allocationsPct: Record<string, number>;
  /** The candidate's averages over the paths. */
  figures: BookFigures;
  /** Its exact projection's scores, once confirmed; null until then (and for those past the best 5). */
  exact: (ScoredChange & { figures: BookFigures }) | null;
}

export interface PortfolioSuggestions {
  library: LibraryStatus;
  /** The book's averages over the paths on the library, and exactly once confirmed. */
  book: BookFigures;
  bookExact: BookFigures | null;
  /** Every candidate, highest score first (the confirmed ones by their exact score, first). */
  suggestions: LibrarySuggestion[];
}

const averages = (figures: PathFigures, riskFreeRatePercent: number): BookFigures => ({
  cagr: figures.cagr.reduce((sum, value) => sum + value, 0) / figures.cagr.length,
  maxDrawdown: figures.maxDrawdown.reduce((sum, value) => sum + value, 0) / figures.maxDrawdown.length,
  excessCalmar: excessCalmarOfAverages(figures, riskFreeRatePercent),
});

function staleReasonsOf(manifest: LibraryManifest, globalKey: string, symbols: readonly string[]): string[] {
  const reasons: string[] = [];
  if (manifest.globalKey !== globalKey) reasons.push(`built ${manifest.asOf} for other data, lab settings or code: rebuild it`);
  for (const symbol of symbols) {
    const entry = manifest.tickers[symbol];
    const lastDate = readBacktestDataFileContents(symbol)?.lastDate ?? null;
    if (entry && lastDate !== null && entry.lastFileDay !== lastDate) reasons.push(`${symbol}'s data file was updated since (${entry.lastFileDay} → ${lastDate})`);
  }
  return reasons;
}

export interface SuggestionHooks {
  onProgress?(done: number, total: number, label: string): void;
  /** The suggestions so far: on the library first, then after each exact projection. */
  onSuggestions?(suggestions: PortfolioSuggestions): void;
}

export async function suggestPortfolioChangesFromLibrary(request: PortfolioBookRequest, hooks: SuggestionHooks = {}, connection: Knex = db): Promise<PortfolioSuggestions> {
  const manifest = readLibraryManifest();
  if (manifest === null) throw new PortfolioRequestError("The suggestions' library has not been built yet: rebuild it (about 2.5 hours).");
  const missing = request.tickers.map((ticker) => ticker.symbol).filter((symbol) => !manifest.tickers[symbol]);
  if (missing.length > 0) throw new PortfolioRequestError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the suggestions' library${missing.some((symbol) => manifest.failed[symbol]) ? ` (${missing.filter((symbol) => manifest.failed[symbol]).map((symbol) => `${symbol}: ${manifest.failed[symbol]}`).join("; ")})` : ": rebuild it"}.`);
  const context = await loadProjectionContext(connection);
  const globalKey = libraryGlobalKey(context, marketDayHistoryOf(context.spy.sessions));
  const library: LibraryStatus = { asOf: manifest.asOf, builtAt: manifest.builtAt, staleReasons: staleReasonsOf(manifest, globalKey, request.tickers.map((ticker) => ticker.symbol)) };

  const addable = (await listPortfolioTickers(connection)).filter((ticker) => ticker.verdict === "suits" && manifest.tickers[ticker.symbol]).map((ticker) => ticker.symbol);
  const allocationPct = effectiveAllocationPctBySymbol(request.tickers);
  const book = new Map(request.tickers.map((ticker) => [ticker.symbol, allocationPct.get(ticker.symbol)! / 100]));
  const candidates = suggestionCandidatesOf(book, addable).filter((candidate) => [...candidate.weights.values()].every((weight) => weight * 100 <= maxAllocationPct + 1e-9));

  const excessAllowance = manifest.excessAllowancePct / 100;
  const horizonDays = request.horizonYears * tradingDaysPerYear;
  const returnsCache = new Map<string, Float64Array>();
  const figuresOf = (weights: ReadonlyMap<string, number>) =>
    combinedPathFigures(
      [...weights].map(([symbol, weight]) => {
        const potDollars = Math.round(weight * (1 + excessAllowance) * request.accountDollars);
        const key = `${symbol}@${potDollars}`;
        let returns = returnsCache.get(key);
        if (!returns) returnsCache.set(key, (returns = libraryDailyReturns(manifest, symbol, potDollars)));
        return { returns, weight };
      }),
      { pathCount: manifest.pathCount, daysPerPath: manifest.horizonDays, horizonDays, riskFreeRatePercent: context.riskFreeNowPct, tradingDaysPerYear },
    );

  const total = candidates.length + 1 + confirmedSuggestionCount + 1;
  hooks.onProgress?.(0, total, "Scoring the changes on the library");
  const bookFigures = figuresOf(book);
  let suggestions: LibrarySuggestion[] = candidates.map((candidate, index) => {
    const figures = figuresOf(candidate.weights);
    hooks.onProgress?.(index + 1, total, "Scoring the changes on the library");
    return {
      kind: candidate.kind,
      symbol: candidate.symbol,
      allocationsPct: Object.fromEntries([...candidate.weights].map(([symbol, weight]) => [symbol, Number((weight * 100).toFixed(4))])),
      figures: averages(figures, context.riskFreeNowPct),
      ...scoreChange(figures, bookFigures, context.riskFreeNowPct, projectionSeed + index),
      exact: null,
    };
  });
  suggestions.sort((a, b) => b.score.change - a.score.change);
  const result: PortfolioSuggestions = { library, book: averages(bookFigures, context.riskFreeNowPct), bookExact: null, suggestions };
  hooks.onSuggestions?.(result);

  // S5: the book and the best 5 projected exactly on the same paths, one after another.
  let done = candidates.length + 1;
  const exactFiguresOf = async (allocationsPct: Record<string, number> | null, label: string): Promise<PathFigures> => {
    hooks.onProgress?.(done, total, label);
    const tickers = allocationsPct === null ? request.tickers : Object.entries(allocationsPct).map(([symbol, allocation]) => ({ symbol, allocationPct: allocation }));
    const projection = await projectPortfolio({ ...request, tickers, drift: "neutral", pathCount: confirmationPathCount }, undefined, connection);
    done += 1;
    return { cagr: Float64Array.from(projection.pathFigures.cagr), maxDrawdown: Float64Array.from(projection.pathFigures.maxDrawdown) };
  };
  const bookExact = await exactFiguresOf(null, "Projecting the book exactly");
  result.bookExact = averages(bookExact, context.riskFreeNowPct);
  for (const [rank, suggestion] of suggestions.slice(0, confirmedSuggestionCount).entries()) {
    const exact = await exactFiguresOf(suggestion.allocationsPct, `Confirming change ${rank + 1} of ${confirmedSuggestionCount} exactly`);
    suggestion.exact = { figures: averages(exact, context.riskFreeNowPct), ...scoreChange(exact, bookExact, context.riskFreeNowPct, projectionSeed + rank) };
    hooks.onSuggestions?.(result);
  }
  const confirmed = suggestions.filter((suggestion) => suggestion.exact !== null).sort((a, b) => b.exact!.score.change - a.exact!.score.change);
  suggestions = [...confirmed, ...suggestions.filter((suggestion) => suggestion.exact === null)];
  result.suggestions = suggestions;
  hooks.onProgress?.(total, total, "Done");
  return result;
}
