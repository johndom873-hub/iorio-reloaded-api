import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { computeSourceClosureHash } from "../../lib/computeSourceClosureHash.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { listBacktestDataFileSymbols } from "../dataFileSummary.js";
import { drawDayPaths, marketDayHistoryOf, sharedLeftoverDays, tradingDaysPerYear, type DayPath, type MarketDayHistory } from "./portfolioDayHistory.js";
import type { ProjectionInput } from "./portfolioDayProjection.js";
import { savedProjectionKey } from "./portfolioProjectionCache.js";
import { runPathValuesInParallel } from "./portfolioProjectionPool.js";
import { loadTickerWithHistory, projectionTickerOf } from "./portfolioProjectionTickers.js";
import { loadProjectionContext, projectionSeed, type ProjectionContext } from "./portfolioProjectionContext.js";

// The suggestions' library (Marcelo 2026-11-04, L1–L3): every data-file ticker run alone through v4's day on the
// projection's first 500 paths (the same paths a projection draws, its own leftover days), 5 years, neutral drift, at six
// pot sizes. A lone run's account is the pot ÷ (1 + the excess allowance), the ticker at 100%, so its pot is the account
// raised by the allowance as in a book. Each run is kept as every path's daily account value ÷ its starting value, 32-bit,
// in <data folder>/portfolio-library/<SYMBOL>/<pot>.f32, with manifest.json saying what it was built from. A rebuild
// keeps a ticker whose inputs are unchanged. Built by a backtest job of kind "portfolio_library".

export const libraryPotLevelsDollars = [25_000, 40_000, 65_000, 100_000, 160_000, 250_000] as const;
export const libraryPathCount = 500;
export const libraryHorizonYears = 5;
const libraryFolderName = "portfolio-library";

export interface LibraryTickerEntry {
  /** The hash of what its runs were built from: its history, calibration and chains. */
  inputKey: string;
  /** Its data file's last complete day when built. */
  lastFileDay: string;
}

export interface LibraryManifest {
  builtAt: string;
  asOf: string;
  /** The hash of what every run shares: today, the market history, the lab's settings, the T-bills, the levels, the paths and the code. */
  globalKey: string;
  pathCount: number;
  horizonDays: number;
  potLevelsDollars: number[];
  riskFreeNowPct: number;
  excessAllowancePct: number;
  tickers: Record<string, LibraryTickerEntry>;
  /** Tickers that could not be run, with why. */
  failed: Record<string, string>;
}

const libraryFolder = (dataDirectory: string) => path.join(dataDirectory, libraryFolderName);
const levelFile = (dataDirectory: string, symbol: string, potDollars: number) => path.join(libraryFolder(dataDirectory), symbol, `${potDollars}.f32`);

let libraryCodeHash: string | null = null;

/** The hash of the code the library runs: this file and the worker with everything they import (once per process). */
function portfolioLibraryCodeHash(): string {
  if (libraryCodeHash === null) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const entries = ["src/backtest/portfolio/portfolioLibrary.ts", "src/backtest/portfolio/portfolioProjectionWorker.ts"];
    libraryCodeHash = createHash("sha256")
      .update(entries.map((entry) => computeSourceClosureHash(repoRoot, entry).hash).join(":"))
      .digest("hex");
  }
  return libraryCodeHash;
}

/** The library's global key for `context` (LibraryManifest.globalKey). */
export function libraryGlobalKey(context: ProjectionContext, market: MarketDayHistory): string {
  return savedProjectionKey(
    { asOf: context.asOfIso, marketDates: market.dates, overnight: market.overnight, day: market.day, labSettings: context.labSettings, riskFreeNowPct: context.riskFreeNowPct, riskFreeAveragePct: context.riskFreeAveragePct, potLevelsDollars: libraryPotLevelsDollars, pathCount: libraryPathCount, horizonYears: libraryHorizonYears, seed: projectionSeed },
    portfolioLibraryCodeHash(),
  );
}

export function readLibraryManifest(dataDirectory = requireBacktestDataDirectory()): LibraryManifest | null {
  const filePath = path.join(libraryFolder(dataDirectory), "manifest.json");
  return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as LibraryManifest) : null;
}

function writeLibraryManifest(dataDirectory: string, manifest: LibraryManifest): void {
  const filePath = path.join(libraryFolder(dataDirectory), "manifest.json");
  writeFileSync(`${filePath}.partial`, JSON.stringify(manifest, null, 1));
  renameSync(`${filePath}.partial`, filePath);
}

/** A ticker's lone-run input for a pot: the projection's input with that one ticker at 100% on an account of pot ÷ (1 + allowance). */
export function loneRunInput(context: ProjectionContext, ticker: ProjectionInput["tickers"][number], potDollars: number): ProjectionInput {
  const v4 = context.labSettings.volFarmerV4;
  return {
    asOfIso: context.asOfIso,
    tickers: [ticker],
    settings: { ...context.labSettings, volFarmerV4: { ...v4, tickerAllocationPct: { [ticker.symbol]: 100 } } },
    accountDollars: potDollars / (1 + v4.excessAllowancePct / 100),
    horizonYears: libraryHorizonYears,
    drift: "neutral",
    riskFreeRatePercent: context.riskFreeNowPct,
    seed: projectionSeed,
  };
}

export interface LibraryBuildHooks {
  reportProgress(done: number, total: number, label: string): Promise<void> | void;
  isCancelled(): boolean;
  /** Only these tickers (a partial build, for a check); every data-file ticker when absent. */
  onlySymbols?: readonly string[];
}

/**
 * Builds the library: every data-file ticker at every pot level, keeping the tickers whose runs were built from the same
 * inputs. Writes the manifest after each ticker, so a stopped build keeps what it finished.
 */
export async function buildPortfolioLibrary(hooks: LibraryBuildHooks, connection: Knex = db): Promise<LibraryManifest> {
  const dataDirectory = requireBacktestDataDirectory();
  mkdirSync(libraryFolder(dataDirectory), { recursive: true });
  const context = await loadProjectionContext(connection);
  if (context.spy.dividendShares === null) throw new Error("SPY's dividends were never fetched: npm run backtest:fetch-dividends -- SPY.");
  const market = marketDayHistoryOf(context.spy.sessions, context.spy.dividendShares);
  const globalKey = libraryGlobalKey(context, market);
  const previous = readLibraryManifest(dataDirectory);
  const horizonDays = libraryHorizonYears * tradingDaysPerYear;
  const manifest: LibraryManifest = {
    builtAt: new Date().toISOString(),
    asOf: context.asOfIso,
    globalKey,
    pathCount: libraryPathCount,
    horizonDays,
    potLevelsDollars: [...libraryPotLevelsDollars],
    riskFreeNowPct: context.riskFreeNowPct,
    excessAllowancePct: context.labSettings.volFarmerV4.excessAllowancePct,
    tickers: previous?.globalKey === globalKey ? { ...previous.tickers } : {},
    failed: {},
  };
  const paths: DayPath[] = drawDayPaths(market.dates.length, horizonDays, libraryPathCount, projectionSeed);
  const fileSymbols = listBacktestDataFileSymbols();
  const symbols = hooks.onlySymbols ? fileSymbols.filter((symbol) => hooks.onlySymbols!.includes(symbol)) : fileSymbols;
  const totalRuns = symbols.length * libraryPotLevelsDollars.length;
  let runsDone = 0;
  for (const symbol of symbols) {
    if (hooks.isCancelled()) break;
    let input: ProjectionInput["tickers"][number];
    let inputKey: string;
    let lastFileDay: string;
    try {
      const ticker = await loadTickerWithHistory(symbol, market, context.rates, { nowPct: context.riskFreeNowPct, averagePct: context.riskFreeAveragePct }, connection);
      const source = ticker.source;
      input = projectionTickerOf(ticker, market, sharedLeftoverDays([ticker.history]));
      inputKey = savedProjectionKey(input, globalKey);
      lastFileDay = source.lastFileDay;
    } catch (error) {
      manifest.failed[symbol] = error instanceof Error ? error.message : String(error);
      delete manifest.tickers[symbol];
      runsDone += libraryPotLevelsDollars.length;
      continue;
    }
    const kept = manifest.tickers[symbol];
    if (kept?.inputKey === inputKey && libraryPotLevelsDollars.every((pot) => existsSync(levelFile(dataDirectory, symbol, pot)))) {
      runsDone += libraryPotLevelsDollars.length;
      continue;
    }
    delete manifest.tickers[symbol];
    mkdirSync(path.join(libraryFolder(dataDirectory), symbol), { recursive: true });
    let cancelled = false;
    for (const potDollars of libraryPotLevelsDollars) {
      if (hooks.isCancelled()) {
        cancelled = true;
        break;
      }
      const label = `${symbol} at a $${potDollars / 1000}k pot`;
      await hooks.reportProgress(runsDone, totalRuns, label);
      const values = await runPathValuesInParallel(loneRunInput(context, input, potDollars), paths);
      const filePath = levelFile(dataDirectory, symbol, potDollars);
      writeFileSync(`${filePath}.partial`, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
      renameSync(`${filePath}.partial`, filePath);
      runsDone += 1;
    }
    if (cancelled) break;
    manifest.tickers[symbol] = { inputKey, lastFileDay };
    writeLibraryManifest(dataDirectory, manifest);
  }
  // Tickers whose data file is gone leave the library.
  for (const symbol of Object.keys(manifest.tickers)) {
    if (fileSymbols.includes(symbol)) continue;
    delete manifest.tickers[symbol];
    rmSync(path.join(libraryFolder(dataDirectory), symbol), { recursive: true, force: true });
  }
  writeLibraryManifest(dataDirectory, manifest);
  await hooks.reportProgress(runsDone, totalRuns, "Library built");
  return manifest;
}

/** Every path's daily account value ÷ its starting value for one ticker at one level: pathCount × horizonDays. */
function readLevel(dataDirectory: string, symbol: string, potDollars: number): Float32Array {
  const buffer = readFileSync(levelFile(dataDirectory, symbol, potDollars));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * A ticker's daily returns at a pot of `potDollars` (L2): the blend of its two neighbouring levels' daily returns,
 * weighted by where ln(pot) falls between them; the end level below the first or above the last. pathCount × horizonDays,
 * each day's return over the day before (the first over the starting value).
 */
export function libraryDailyReturns(manifest: LibraryManifest, symbol: string, potDollars: number, dataDirectory = requireBacktestDataDirectory()): Float64Array {
  const levels = manifest.potLevelsDollars;
  const upperIndex = levels.findIndex((level) => level >= potDollars);
  const [lower, upper, upperWeight] =
    upperIndex === -1 ? [levels.at(-1)!, levels.at(-1)!, 0] : upperIndex === 0 ? [levels[0]!, levels[0]!, 0] : [levels[upperIndex - 1]!, levels[upperIndex]!, Math.log(potDollars / levels[upperIndex - 1]!) / Math.log(levels[upperIndex]! / levels[upperIndex - 1]!)];
  const lowerValues = readLevel(dataDirectory, symbol, lower);
  const upperValues = upper === lower ? lowerValues : readLevel(dataDirectory, symbol, upper);
  const days = manifest.horizonDays;
  const returns = new Float64Array(lowerValues.length);
  for (let pathIndex = 0; pathIndex < manifest.pathCount; pathIndex++) {
    for (let day = 0; day < days; day++) {
      const at = pathIndex * days + day;
      const lowerReturn = lowerValues[at]! / (day === 0 ? 1 : lowerValues[at - 1]!) - 1;
      const upperReturn = upperValues[at]! / (day === 0 ? 1 : upperValues[at - 1]!) - 1;
      returns[at] = (1 - upperWeight) * lowerReturn + upperWeight * upperReturn;
    }
  }
  return returns;
}
