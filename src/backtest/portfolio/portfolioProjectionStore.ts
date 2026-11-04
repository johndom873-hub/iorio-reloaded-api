import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { effectiveAllocationPctBySymbol } from "../../lib/tickerAllocation.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { stockCommissionDollars } from "../engine/ledger/ledgerFills.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { tickerBusinessChangeOf, type TickerBusinessChange } from "../tickerBusinessChanges.js";
import { loadBacktestLabSettings } from "../labSettingsStore.js";
import { dayHistoryStartIso, drawDayPaths, marketDayHistoryOf, sharedLeftoverDays, tickerDayHistoryOf, tradingDaysPerYear } from "./portfolioDayHistory.js";
import { floorAllocationPctOf, maxAllocationPct, potDollarsOf, potFiguresOf, suggestAllocations, type PotFigures, type SuggestedAllocations } from "./portfolioPots.js";
import { runReplayPaths, type ProjectionInput } from "./portfolioDayProjection.js";
import { portfolioProjectionCodeHash, readSavedProjection, savedProjectionKey, saveProjection } from "./portfolioProjectionCache.js";
import { runProjectionInParallel } from "./portfolioProjectionPool.js";
import { loadProjectionContext, projectionSeed, type ProjectionContext } from "./portfolioProjectionContext.js";
import { loadTickerProjectionSource, type TickerProjectionSource } from "./portfolioProjectionInputs.js";
import { drawdownAtOddsOf, summarizeProjection, type ProjectionSummary } from "./portfolioProjectionSummary.js";
import { libraryDailyReturns, readLibraryManifest } from "./portfolioLibrary.js";
import { combinedPathFigures } from "./portfolioLibraryScoring.js";
import { PortfolioRequestError, horizonYearsChoices, parsePortfolioBookRequest, type HorizonYears, type PortfolioBookRequest } from "./portfolioSimulatorStore.js";

// The portfolio simulator's projection and pot table (the lab only, Marcelo 2026-11-03): a book's paths run through v4's
// own day on the lab's settings with the book's allocations (portfolioDayProjection.ts, in worker threads), its figures
// over the paths, and each ticker's pot in whole lots with the suggested allocations (portfolioPots.ts). The T-bill now
// is DTB3's latest rate, its average DTB3's from 2010 over the history's days; today is SPY's last file day.

export { projectionSeed };
export const maxProjectionPaths = 2000;
export const defaultProjectionPaths = 500;
/** The windows a book is replayed through. */
export const replayWindows = [
  { name: "2008", from: "2007-10-08", to: "2009-03-09" },
  { name: "Covid", from: "2020-02-17", to: "2020-03-23" },
  { name: "2022", from: "2022-01-03", to: "2022-10-10" },
] as const;

export type ProjectionDrift = "as_it_happened" | "neutral";

export interface PortfolioProjectionRequest extends PortfolioBookRequest {
  drift: ProjectionDrift;
  pathCount: number;
}

/** The book (parsePortfolioBookRequest), a drift (neutral by default) and a path count from 1 to 2,000 (500 by default). */
export function parsePortfolioProjectionRequest(body: unknown): PortfolioProjectionRequest {
  const book = parsePortfolioBookRequest(body);
  const value = (body ?? {}) as Record<string, unknown>;
  const drift = value.drift ?? "neutral";
  if (drift !== "neutral" && drift !== "as_it_happened") throw new PortfolioRequestError("drift must be neutral or as_it_happened.");
  const pathCount = value.pathCount ?? defaultProjectionPaths;
  if (typeof pathCount !== "number" || !Number.isInteger(pathCount) || pathCount < 1 || pathCount > maxProjectionPaths) throw new PortfolioRequestError(`pathCount must be a whole number from 1 to ${maxProjectionPaths}.`);
  return { ...book, drift, pathCount };
}

interface PreparedProjection extends ProjectionContext {
  allocationPct: Map<string, number>;
  /** The lab's settings with the book's allocations. */
  settings: ReturnType<typeof applyBacktestOverrides>;
  sources: TickerProjectionSource[];
}

async function prepareProjection(request: PortfolioBookRequest, connection: Knex): Promise<PreparedProjection> {
  const context = await loadProjectionContext(connection);
  const sources = await Promise.all(request.tickers.map((ticker) => loadTickerProjectionSource(ticker.symbol, context.rates, connection).catch((error: unknown) => Promise.reject(new PortfolioRequestError(error instanceof Error ? error.message : String(error))))));
  const allocationPct = effectiveAllocationPctBySymbol(request.tickers);
  const settings = { ...context.labSettings, volFarmerV4: { ...context.labSettings.volFarmerV4, tickerAllocationPct: Object.fromEntries(allocationPct) } };
  return { ...context, allocationPct, settings, sources };
}

export interface TickerPot extends PotFigures {
  symbol: string;
  allocationPct: number;
  price: number;
  /** The allocation whose pot is the smallest one its band acts in. */
  floorPct: number;
}

/** Each ticker's pot at its allocation, in whole lots, and its floor. */
function potsOf(prepared: PreparedProjection, accountDollars: number): TickerPot[] {
  const v4 = prepared.settings.volFarmerV4;
  return prepared.sources.map((source) => {
    const allocationPct = prepared.allocationPct.get(source.symbol)!;
    const figures = potFiguresOf({ potDollars: potDollarsOf(allocationPct, v4.excessAllowancePct, accountDollars), price: source.calibration.price, stockCommissionDollars: stockCommissionDollars(100), firstPositionPct: v4.firstPositionPct, rebalanceBandPct: v4.rebalanceBandPct });
    return { symbol: source.symbol, allocationPct, price: source.calibration.price, floorPct: floorAllocationPctOf(figures.smallestBandActingPot, v4.excessAllowancePct, accountDollars), ...figures };
  });
}

export interface PortfolioPots {
  asOf: string;
  accountDollars: number;
  excessAllowancePct: number;
  firstPositionPct: number;
  rebalanceBandPct: number;
  maxAllocationPct: number;
  pots: TickerPot[];
  suggested: Omit<SuggestedAllocations, "allocationPctBySymbol"> & { allocationPct: { symbol: string; allocationPct: number }[] };
}

/** The book's pot table at its allocations, and the suggested allocations for its tickers. */
export async function portfolioPots(request: PortfolioBookRequest, connection: Knex = db): Promise<PortfolioPots> {
  const prepared = await prepareProjection(request, connection);
  const pots = potsOf(prepared, request.accountDollars);
  const suggested = suggestAllocations(pots.map((pot) => ({ symbol: pot.symbol, floorPct: pot.floorPct })));
  const { allocationPctBySymbol, ...rest } = suggested;
  const v4 = prepared.settings.volFarmerV4;
  return {
    asOf: prepared.asOfIso,
    accountDollars: request.accountDollars,
    excessAllowancePct: v4.excessAllowancePct,
    firstPositionPct: v4.firstPositionPct,
    rebalanceBandPct: v4.rebalanceBandPct,
    maxAllocationPct,
    pots,
    suggested: { ...rest, allocationPct: [...allocationPctBySymbol].map(([symbol, allocationPct]) => ({ symbol, allocationPct })) },
  };
}

export interface PortfolioProjection {
  asOf: string;
  horizonYears: HorizonYears;
  drift: ProjectionDrift;
  accountDollars: number;
  riskFree: { nowPct: number; averagePct: number };
  history: { from: string; to: string; days: number };
  summary: ProjectionSummary;
  pots: TickerPot[];
  tickers: { symbol: string; allocationPct: number; price: number; strikeSpacing: number; expiryWeekdays: number[]; beta: number; ownHistoryFrom: string | null; tenOclockFrom: string | null; chainDays: number; businessChange: TickerBusinessChange | null; dividendYield: number | null; ownDrawdownAtOdds: { oneIn: number; maxDrawdown: number }[] | null }[];
  /** Where each ticker's own drawdowns come from: the suggestions' library (its lone runs at the ticker's pot, neutral drift); null without one. */
  ownDrawdowns: { libraryAsOf: string; staleSymbols: string[] } | null;
  /** Today's book through each window's actual days (one path each, at the actual drift), and SPY's return over them. */
  replays: { name: string; from: string; to: string; days: number; bookReturn: number; maxDrawdown: number; spyReturn: number }[];
  /** Each path's CAGR and Max drawdown, in path order: the suggestions compare a change with the book path by path. */
  pathFigures: { cagr: number[]; maxDrawdown: number[] };
  /** When this projection was computed and saved, if it was read back (portfolioProjectionCache.ts); null when computed now. */
  savedAt: string | null;
}

/** The book's projection, read back when the same one was saved before (portfolioProjectionCache.ts); `onProgress` after each path; `signal` stops it. */
export async function projectPortfolio(request: PortfolioProjectionRequest, onProgress?: (done: number, total: number) => void, connection: Knex = db, signal?: AbortSignal): Promise<PortfolioProjection> {
  if (!(horizonYearsChoices as readonly number[]).includes(request.horizonYears)) throw new PortfolioRequestError(`horizonYears must be one of ${horizonYearsChoices.join(", ")}.`);
  const prepared = await prepareProjection(request, connection);
  if (prepared.spy.dividendShares === null) throw new PortfolioRequestError("SPY's dividends were never fetched: npm run backtest:fetch-dividends -- SPY.");
  const spyDividendShares = prepared.spy.dividendShares;
  const market = marketDayHistoryOf(prepared.spy.sessions, spyDividendShares);
  if (market.dates.length < 2 * tradingDaysPerYear) throw new PortfolioRequestError("SPY's 10:00 prices cover under 2 years: extend its 30-minute bars back (npm run backtest:backfill-file-stock-bars -- --extend-intraday-bars-back SPY).");
  const riskFreeNowDay = prepared.riskFreeNowPct / 100 / tradingDaysPerYear;
  const riskFreeMeanDay = prepared.riskFreeAveragePct / 100 / tradingDaysPerYear;
  const histories = prepared.sources.map((source) => tickerDayHistoryOf(source.symbol, source.sessions, market, riskFreeNowDay, riskFreeMeanDay, source.dividendYield ?? 0));
  const horizonDays = request.horizonYears * tradingDaysPerYear;
  const paths = drawDayPaths(market.dates.length, horizonDays, request.pathCount, projectionSeed);
  const leftoverDays = sharedLeftoverDays(histories);
  const input: ProjectionInput = {
    asOfIso: prepared.asOfIso,
    tickers: prepared.sources.map((source, index) => ({
      symbol: source.symbol,
      history: histories[index]!,
      todaysPrice: source.calibration.price,
      strikeSpacing: source.calibration.strikeSpacing,
      expiryWeekdays: source.calibration.expiryWeekdays,
      sameDayVolatilityUplift: source.calibration.sameDayVolatilityUplift ?? 1,
      observedDays: source.observedDays,
      anchorCurve: source.anchorCurve,
      leftoverDays,
      dividendYield: source.dividendYield ?? 0,
    })),
    settings: prepared.settings,
    accountDollars: request.accountDollars,
    horizonYears: request.horizonYears,
    drift: request.drift,
    riskFreeRatePercent: prepared.riskFreeNowPct,
    seed: projectionSeed,
    spyMoves: { overnight: market.overnight, day: market.day },
  };
  const dataDirectory = requireBacktestDataDirectory();
  const key = savedProjectionKey({ input, pathCount: request.pathCount, marketDates: market.dates }, portfolioProjectionCodeHash());
  const saved = readSavedProjection<PortfolioProjection>(dataDirectory, key);
  if (saved !== null) return withOwnDrawdowns({ ...saved.projection, savedAt: saved.savedAt }, prepared, request.horizonYears);
  const outcomes = await runProjectionInParallel(input, paths, onProgress, undefined, signal);
  const windows = replayWindows
    .map((window) => ({ ...window, days: Int32Array.from(market.dates.flatMap((date, at) => (date >= window.from && date <= window.to ? [at] : []))) }))
    .filter((window) => window.days.length > 0 && window.days[0]! > 0 && market.dates.at(-1)! >= window.to);
  const replays = await runReplayPaths({ ...input, drift: "as_it_happened" }, windows);
  const projection: PortfolioProjection = {
    asOf: prepared.asOfIso,
    horizonYears: request.horizonYears,
    drift: request.drift,
    accountDollars: request.accountDollars,
    riskFree: { nowPct: prepared.riskFreeNowPct, averagePct: prepared.riskFreeAveragePct },
    history: { from: market.dates[0]!, to: market.dates.at(-1)!, days: market.dates.length },
    summary: summarizeProjection(outcomes, { accountDollars: request.accountDollars, horizonYears: request.horizonYears, riskFreeRatePercent: prepared.riskFreeNowPct, horizonDays }),
    pots: potsOf(prepared, request.accountDollars),
    tickers: prepared.sources.map((source, index) => ({
      symbol: source.symbol,
      allocationPct: prepared.allocationPct.get(source.symbol)!,
      price: source.calibration.price,
      strikeSpacing: source.calibration.strikeSpacing,
      expiryWeekdays: source.calibration.expiryWeekdays,
      beta: histories[index]!.beta,
      ownHistoryFrom: market.dates[histories[index]!.own.indexOf(1)] ?? null,
      tenOclockFrom: source.firstTenOclockDate !== null && source.firstTenOclockDate < dayHistoryStartIso ? dayHistoryStartIso : source.firstTenOclockDate,
      chainDays: source.observedDays.length,
      businessChange: tickerBusinessChangeOf(source.symbol),
      dividendYield: source.dividendYield,
      ownDrawdownAtOdds: null,
    })),
    replays: windows.map((window, index) => ({
      name: window.name,
      from: market.dates[window.days[0]!]!,
      to: market.dates[window.days.at(-1)!]!,
      days: window.days.length,
      bookReturn: replays[index]!.bookReturn,
      maxDrawdown: replays[index]!.maxDrawdown,
      // With its dividends reinvested, as the book's are kept.
      spyReturn:
        Math.exp(Array.from(window.days).reduce((sum, at) => sum + market.overnight[at]! + market.day[at]!, 0)) *
          spyDividendShares.filter((dividend) => dividend.exDividendDate >= market.dates[window.days[0]!]! && dividend.exDividendDate <= market.dates[window.days.at(-1)!]!).reduce((product, dividend) => product * (1 + dividend.share), 1) -
        1,
    })),
    pathFigures: { cagr: outcomes.map((outcome) => outcome.cagr), maxDrawdown: outcomes.map((outcome) => outcome.maxDrawdown) },
    ownDrawdowns: null,
    savedAt: null,
  };
  saveProjection(dataDirectory, key, projection);
  return withOwnDrawdowns(projection, prepared, request.horizonYears);
}

/**
 * Each ticker's own Max drawdown at the odds (Marcelo 2026-11-04), read fresh from the suggestions' library: its lone
 * runs at its pot (L2's blend), over the horizon. A ticker the library lacks gets null; one whose data file changed since
 * its runs is listed as stale.
 */
function withOwnDrawdowns(projection: PortfolioProjection, prepared: PreparedProjection, horizonYears: number): PortfolioProjection {
  const manifest = readLibraryManifest();
  if (manifest === null) return { ...projection, ownDrawdowns: null, tickers: projection.tickers.map((ticker) => ({ ...ticker, ownDrawdownAtOdds: null })) };
  const potBySymbol = new Map(projection.pots.map((pot) => [pot.symbol, pot.potDollars]));
  const lastFileDayBySymbol = new Map(prepared.sources.map((source) => [source.symbol, source.lastFileDay]));
  return {
    ...projection,
    ownDrawdowns: { libraryAsOf: manifest.asOf, staleSymbols: projection.tickers.filter((ticker) => manifest.tickers[ticker.symbol] && manifest.tickers[ticker.symbol]!.lastFileDay !== lastFileDayBySymbol.get(ticker.symbol)).map((ticker) => ticker.symbol) },
    tickers: projection.tickers.map((ticker) => {
      if (!manifest.tickers[ticker.symbol]) return { ...ticker, ownDrawdownAtOdds: null };
      const returns = libraryDailyReturns(manifest, ticker.symbol, potBySymbol.get(ticker.symbol)!);
      const figures = combinedPathFigures([{ returns, weight: 1 }], { pathCount: manifest.pathCount, daysPerPath: manifest.horizonDays, horizonDays: horizonYears * tradingDaysPerYear, riskFreeRatePercent: manifest.riskFreeNowPct, tradingDaysPerYear });
      return { ...ticker, ownDrawdownAtOdds: drawdownAtOddsOf(figures.maxDrawdown) };
    }),
  };
}
