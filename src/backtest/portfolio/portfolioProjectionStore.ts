import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { effectiveAllocationPctBySymbol } from "../../lib/tickerAllocation.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { stockCommissionDollars } from "../engine/ledger/ledgerFills.js";
import { loadTreasuryBillRates } from "../engine/treasuryBillRates.js";
import { tickerBusinessChangeOf, type TickerBusinessChange } from "../tickerBusinessChanges.js";
import { loadBacktestLabSettings } from "../labSettingsStore.js";
import { dayHistoryStartIso, drawDayPaths, marketDayHistoryOf, sharedLeftoverDays, tickerDayHistoryOf, tradingDaysPerYear } from "./portfolioDayHistory.js";
import { floorAllocationPctOf, maxAllocationPct, potDollarsOf, potFiguresOf, suggestAllocations, type PotFigures, type SuggestedAllocations } from "./portfolioPots.js";
import { runReplayPaths, type ProjectionInput } from "./portfolioDayProjection.js";
import { portfolioProjectionCodeHash, readSavedProjection, savedProjectionKey, saveProjection } from "./portfolioProjectionCache.js";
import { runProjectionInParallel } from "./portfolioProjectionPool.js";
import { loadTickerProjectionSource, type TickerProjectionSource } from "./portfolioProjectionInputs.js";
import { summarizeProjection, type ProjectionSummary } from "./portfolioProjectionSummary.js";
import { PortfolioRequestError, horizonYearsChoices, parsePortfolioBookRequest, type HorizonYears, type PortfolioBookRequest } from "./portfolioSimulatorStore.js";

// The portfolio simulator's projection and pot table (the lab only, Marcelo 2026-11-03): a book's paths run through v4's
// own day on the lab's settings with the book's allocations (portfolioDayProjection.ts, in worker threads), its figures
// over the paths, and each ticker's pot in whole lots with the suggested allocations (portfolioPots.ts). The T-bill now
// is DTB3's latest rate, its average DTB3's from 2010 over the history's days; today is SPY's last file day.

export const projectionSeed = 20261103;
export const maxProjectionPaths = 2000;
export const defaultProjectionPaths = 500;
/** The windows a book is replayed through. */
export const replayWindows = [
  { name: "2008", from: "2007-10-08", to: "2009-03-09" },
  { name: "Covid", from: "2020-02-17", to: "2020-03-23" },
  { name: "2022", from: "2022-01-03", to: "2022-10-10" },
] as const;
const treasuryBillAverageFromIso = "2010-01-04";

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

interface PreparedProjection {
  asOfIso: string;
  riskFreeNowPct: number;
  riskFreeAveragePct: number;
  allocationPct: Map<string, number>;
  settings: ReturnType<typeof applyBacktestOverrides>;
  sources: TickerProjectionSource[];
}

async function prepareProjection(request: PortfolioBookRequest, connection: Knex): Promise<PreparedProjection & { spy: TickerProjectionSource; rates: Awaited<ReturnType<typeof loadTreasuryBillRates>> }> {
  const dataDirectory = requireBacktestDataDirectory();
  const ratesToday = await loadTreasuryBillRates(dataDirectory, treasuryBillAverageFromIso, new Date().toISOString().slice(0, 10));
  const spy = await loadTickerProjectionSource("SPY", ratesToday, connection);
  const asOfIso = spy.lastFileDay;
  const sources = await Promise.all(request.tickers.map((ticker) => loadTickerProjectionSource(ticker.symbol, ratesToday, connection).catch((error: unknown) => Promise.reject(new PortfolioRequestError(error instanceof Error ? error.message : String(error))))));
  const lab = await loadBacktestLabSettings(connection);
  const effective = applyBacktestOverrides(lab.settings, {});
  const allocationPct = effectiveAllocationPctBySymbol(request.tickers);
  const settings = { ...effective, volFarmerV4: { ...effective.volFarmerV4, tickerAllocationPct: Object.fromEntries(allocationPct) } };
  const historyDates = spy.sessions.filter((session) => session.tradingDate >= treasuryBillAverageFromIso).map((session) => session.tradingDate);
  const riskFreeAveragePct = historyDates.reduce((sum, date) => sum + (ratesToday.ratePercentOnOrBefore(date) ?? 0), 0) / Math.max(1, historyDates.length);
  return { asOfIso, riskFreeNowPct: ratesToday.ratePercentOnOrBefore(asOfIso) ?? 0, riskFreeAveragePct, allocationPct, settings, sources, spy, rates: ratesToday };
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
  tickers: { symbol: string; allocationPct: number; price: number; strikeSpacing: number; expiryWeekdays: number[]; beta: number; ownHistoryFrom: string | null; tenOclockFrom: string | null; chainDays: number; businessChange: TickerBusinessChange | null }[];
  /** Today's book through each window's actual days (one path each, at the actual drift), and SPY's return over them. */
  replays: { name: string; from: string; to: string; days: number; bookReturn: number; maxDrawdown: number; spyReturn: number }[];
  /** When this projection was computed and saved, if it was read back (portfolioProjectionCache.ts); null when computed now. */
  savedAt: string | null;
}

/** The book's projection, read back when the same one was saved before (portfolioProjectionCache.ts); `onProgress` after each path. */
export async function projectPortfolio(request: PortfolioProjectionRequest, onProgress?: (done: number, total: number) => void, connection: Knex = db): Promise<PortfolioProjection> {
  if (!(horizonYearsChoices as readonly number[]).includes(request.horizonYears)) throw new PortfolioRequestError(`horizonYears must be one of ${horizonYearsChoices.join(", ")}.`);
  const prepared = await prepareProjection(request, connection);
  const market = marketDayHistoryOf(prepared.spy.sessions);
  if (market.dates.length < 2 * tradingDaysPerYear) throw new PortfolioRequestError("SPY's 10:00 prices cover under 2 years: extend its 30-minute bars back (npm run backtest:backfill-file-stock-bars -- --extend-intraday-bars-back SPY).");
  const riskFreeNowDay = prepared.riskFreeNowPct / 100 / tradingDaysPerYear;
  const riskFreeMeanDay = prepared.riskFreeAveragePct / 100 / tradingDaysPerYear;
  const histories = prepared.sources.map((source) => tickerDayHistoryOf(source.symbol, source.sessions, market, riskFreeNowDay, riskFreeMeanDay));
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
    })),
    settings: prepared.settings,
    accountDollars: request.accountDollars,
    horizonYears: request.horizonYears,
    drift: request.drift,
    riskFreeRatePercent: prepared.riskFreeNowPct,
    seed: projectionSeed,
  };
  const dataDirectory = requireBacktestDataDirectory();
  const key = savedProjectionKey({ input, pathCount: request.pathCount, marketDates: market.dates }, portfolioProjectionCodeHash());
  const saved = readSavedProjection<PortfolioProjection>(dataDirectory, key);
  if (saved !== null) return { ...saved.projection, savedAt: saved.savedAt };
  const outcomes = await runProjectionInParallel(input, paths, onProgress);
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
    })),
    replays: windows.map((window, index) => ({
      name: window.name,
      from: market.dates[window.days[0]!]!,
      to: market.dates[window.days.at(-1)!]!,
      days: window.days.length,
      bookReturn: replays[index]!.bookReturn,
      maxDrawdown: replays[index]!.maxDrawdown,
      spyReturn: Math.exp(Array.from(window.days).reduce((sum, at) => sum + market.overnight[at]! + market.day[at]!, 0)) - 1,
    })),
    savedAt: null,
  };
  saveProjection(dataDirectory, key, projection);
  return projection;
}
