import type { BacktestSymbolFile, SymbolFileEndOfDayRow, SymbolFileQuote } from "../engine/backtestSymbolFile.js";
import { noteBaselineForwardAnchors, selectBaselineCandidates, type BaselineCandidateInput, type BaselineForwardAnchor } from "../engine/baselineSaleSteps.js";
import type { BacktestBaselineSettings } from "../backtestTypes.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { commissionPerContractDollars } from "../../lib/optionFriction.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { blackScholesDelta, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";

// The Analyse window's 10:00 chain scan (Marcelo 2026-10-15): every complete day of a symbol file filtered with the
// engine's own selectBaselineCandidates at the ticker's lab values, counted by right and expiry range (F8), the Puts also
// under each day's first-rung cap (F19: cap = 10:00 price × (1 − S ÷ rungs), S that day's shock), and the last day's
// whole chain priced for the chain yield map (F10). Each day also records the contracts its largest pot is taken from
// (approved 2026-10-15): the best Put under the cap, ranked by premium yield as the ladder's Puts are, and the best Call
// a new Covered Call entry would sell, chosen as the engine's entry chooses it.

/** Days to expiry ranges of the year × expiry table (D3). */
export const analysisDteRanges = [
  { key: "1-7", low: 1, high: 7 },
  { key: "8-14", low: 8, high: 14 },
  { key: "15-30", low: 15, high: 30 },
  { key: "31-45", low: 31, high: 45 },
] as const;
export type AnalysisDteRange = (typeof analysisDteRanges)[number]["key"];
/** Calls, Puts, and Puts under the first rung's cap. */
export type AnalysisChainView = "C" | "P" | "Pcap";

export const dteRangeOf = (dte: number): AnalysisDteRange | null => analysisDteRanges.find((range) => dte >= range.low && dte <= range.high)?.key ?? null;

export type ChainScanSettings = Pick<BacktestBaselineSettings, "minAbsDelta" | "maxAbsDelta" | "minDte" | "maxDte" | "maxSpreadPctOfMid" | "ladderRungs" | "ranking" | "expiryChoice" | "minCallYieldPct" | "entryCallStrike" | "ladderPutDeltaRange" | "callDeltaRange" | "callMinAbsDelta" | "callMaxAbsDelta"> & {
  /** λ: the share of the half-spread a fill gives up (0 = the mid). */
  spreadShareCharged: number;
};

export interface ChainScanDayInput {
  date: string;
  /** The previous complete file day, whose end-of-day volume sets the volume limit; null on the file's first day. */
  previousDate: string | null;
  /** The 10:00 price as traded (IBKR's 09:30 bar close × the day's split factor); null when either is missing. */
  spot: number | null;
  /** As a fraction. */
  riskFreeRate: number;
  /** The shock the rule gives for a cycle starting that day, a fraction. */
  shock: number;
  /** Earnings dates known that day and not yet reported, when the lab skips expiries spanning one; null when it ignores earnings. */
  earningsDatesIso: string[] | null;
}

export interface ChainScanCell {
  count: number;
  best: number;
  yields: number[];
}

export interface ChainScanDayRow {
  date: string;
  spot: number | null;
  shock: number;
  cap: number | null;
  cells: Record<AnalysisChainView, Partial<Record<AnalysisDteRange, ChainScanCell>>>;
  /** The best passing Put under the cap: the first rung's actual best. */
  bestCappedPut: { strike: number; expiry: string; dte: number; premiumYield: number; delta: number } | null;
  /** The Call a new Covered Call entry would sell (the engine's choice); null when none passes. */
  bestEntryCall: { strike: number; expiry: string; dte: number; premiumYield: number; delta: number } | null;
  /** The contracts the day's largest pot is taken from, with their volume limits; null when none passes. */
  largestPotPut: { strike: number; volumeCap: number } | null;
  largestPotCall: { strike: number; volumeCap: number } | null;
  passingTotal: number;
  /** Passing contracts quoted at or under 25% of the mid. */
  spreadsUnder25: number;
}

/** A contract of the last day's chain, priced at the mid; delta and yield null when they cannot be placed. */
export interface ChainMapContract {
  right: "C" | "P";
  expiry: string;
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  previousVolume: number;
  delta: number | null;
  yieldAtMid: number | null;
}

export function volumeByContract(rows: readonly SymbolFileEndOfDayRow[] | null): Map<string, number> | null {
  if (rows === null) return null;
  const volumes = new Map<string, number>();
  for (const row of rows) if (row.volume !== null) volumes.set(contractKey(row), row.volume);
  return volumes;
}

/** One day's counts. Pure apart from reading the file. */
export function scanChainDay(file: BacktestSymbolFile, day: ChainScanDayInput, settings: ChainScanSettings): ChainScanDayRow {
  const cap = day.spot === null ? null : day.spot * (1 - day.shock / settings.ladderRungs);
  const row: ChainScanDayRow = { date: day.date, spot: day.spot, shock: day.shock, cap, cells: { C: {}, P: {}, Pcap: {} }, bestCappedPut: null, bestEntryCall: null, largestPotPut: null, largestPotCall: null, passingTotal: 0, spreadsUnder25: 0 };
  if (day.spot === null || cap === null) return row;
  const quotes = file.loadQuotes(day.date);
  const previousSessionVolumeByContract = volumeByContract(day.previousDate === null ? null : file.loadEndOfDay(day.previousDate));
  const add = (view: AnalysisChainView, range: AnalysisDteRange, premiumYield: number) => {
    const cell = (row.cells[view][range] ??= { count: 0, best: Number.NEGATIVE_INFINITY, yields: [] });
    cell.count++;
    cell.best = Math.max(cell.best, premiumYield);
    cell.yields.push(premiumYield);
  };
  // The day's forwards as the engine's first look notes them (parity, else spot × e^(rT)).
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso: day.date, yearsToTodaysClose: 6 / 8760, stockPrice: day.spot, riskFreeRate: day.riskFreeRate });
  // As the engine's selector: Calls on their range (callDeltaRange), the ladder's Puts at any |delta| with ladderPutDeltaRange "none".
  const callSettings = settings.callDeltaRange === "own_range" ? { ...settings, minAbsDelta: settings.callMinAbsDelta, maxAbsDelta: settings.callMaxAbsDelta } : settings;
  const putSettings = settings.ladderPutDeltaRange === "none" ? { ...settings, minAbsDelta: 0, maxAbsDelta: 1 } : settings;
  const select = (right: "C" | "P", rules: Pick<BaselineCandidateInput, "minimumStrike" | "maximumStrike" | "minimumPremiumYield" | "earningsDatesIso" | "ranking" | "nearestExpiryFirst"> = {}) =>
    selectBaselineCandidates({
      quotes,
      forwardAnchors,
      // The backtest's flat commissions ($0.68 a contract, $0.005 a share), as its sessions charge.
      commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator },
      right,
      todayIso: day.date,
      yearsToTodaysClose: 6 / 8760,
      stockPrice: day.spot!,
      riskFreeRate: day.riskFreeRate,
      previousSessionVolumeByContract,
      settings: right === "C" ? callSettings : putSettings,
      spreadShareCharged: settings.spreadShareCharged,
      isHeld: () => false,
      ...rules,
    }).candidates;
  for (const right of ["C", "P"] as const) {
    for (const candidate of select(right)) {
      const range = dteRangeOf(candidate.dte);
      if (range === null) continue;
      row.passingTotal++;
      if ((candidate.ask - candidate.bid) / ((candidate.ask + candidate.bid) / 2) <= 0.25) row.spreadsUnder25++;
      add(right, range, candidate.premiumYield);
      if (right === "P" && candidate.strike <= cap + 1e-9) {
        add("Pcap", range, candidate.premiumYield);
        if (row.bestCappedPut === null || candidate.premiumYield > row.bestCappedPut.premiumYield) {
          row.bestCappedPut = { strike: candidate.strike, expiry: candidate.expiry, dte: candidate.dte, premiumYield: candidate.premiumYield, delta: candidate.delta };
        }
      }
    }
  }
  const earnings = day.earningsDatesIso === null ? {} : { earningsDatesIso: day.earningsDatesIso };
  // The ladder's Put: under the cap, by premium yield (the engine's select("P", null, true, cap, true)).
  const put = select("P", { maximumStrike: cap, ranking: "premium_yield", ...earnings })[0];
  // A new Covered Call entry's Call (the engine's enterWithFreeCash): with no shares held, a cost rule's floor is the price paid.
  const call = select("C", {
    minimumStrike: settings.entryCallStrike === "any" ? null : day.spot,
    minimumPremiumYield: settings.minCallYieldPct > 0 ? settings.minCallYieldPct / 100 : null,
    ...(settings.ranking !== "edge_yield" ? { ranking: settings.ranking } : {}),
    nearestExpiryFirst: settings.expiryChoice === "nearest_qualifying",
    ...earnings,
  })[0];
  row.largestPotPut = put ? { strike: put.strike, volumeCap: put.volumeCap } : null;
  row.largestPotCall = call ? { strike: call.strike, volumeCap: call.volumeCap } : null;
  row.bestEntryCall = call ? { strike: call.strike, expiry: call.expiry, dte: call.dte, premiumYield: call.premiumYield, delta: call.delta } : null;
  return row;
}

/** The last day's chain for the yield map: every quoted contract 1–45 days out with a usable mid, its delta from the mid's IV and its premium yield at the mid. */
export function priceChainMap(quotes: readonly SymbolFileQuote[], day: ChainScanDayInput, previousSessionVolumeByContract: ReadonlyMap<string, number> | null): ChainMapContract[] {
  if (day.spot === null) return [];
  const spot = day.spot;
  const forwardByExpiry = new Map<string, number>();
  const contracts: ChainMapContract[] = [];
  for (const quote of quotes) {
    const years = yearsBetweenIsoDates(day.date, quote.expiry);
    const dte = Math.round(years * 365);
    if (dte < 1 || dte > 45) continue;
    if (quote.bid === null || quote.ask === null || !(quote.ask > quote.bid) || !(quote.ask > 0)) continue;
    const bid = Math.max(quote.bid, 0);
    const mid = (bid + quote.ask) / 2;
    let forward = forwardByExpiry.get(quote.expiry);
    if (forward === undefined) {
      const spotForward = spot * Math.exp(day.riskFreeRate * years);
      const expiryQuotes = quotes.filter((other) => other.expiry === quote.expiry).map((other) => ({ strike: other.strike, right: other.right, bid: other.bid, ask: other.ask }));
      forward = parityImpliedForward(expiryQuotes, spotForward, years, day.riskFreeRate) ?? spotForward;
      forwardByExpiry.set(quote.expiry, forward);
    }
    const isCall = quote.right === "C";
    const impliedVolatility = impliedVolatilityFromPrice(mid, forward, quote.strike, years, day.riskFreeRate, isCall);
    const delta = impliedVolatility === null ? null : blackScholesDelta(forward, quote.strike, years, day.riskFreeRate, impliedVolatility, isCall);
    const intrinsic = isCall ? Math.max(spot - quote.strike, 0) : Math.max(quote.strike - spot, 0);
    const earned = (mid - intrinsic) * 100 - commissionPerContractDollars;
    const capitalAtRisk = ((isCall ? spot : quote.strike) - mid) * 100;
    const yieldAtMid = earned > 0 && capitalAtRisk > 0 ? earned / capitalAtRisk / Math.max(years, 1 / 365) : null;
    contracts.push({ right: quote.right, expiry: quote.expiry, strike: quote.strike, dte, bid, ask: quote.ask, previousVolume: previousSessionVolumeByContract?.get(contractKey(quote)) ?? 0, delta, yieldAtMid });
  }
  return contracts;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** A year × expiry range cell (F8): trading days with a price, days with a passing contract, the median passing a day (zeros included), the median of each day's best yield, the pooled median yield. */
export interface AnalysisGridCell {
  days: number;
  daysWithPassing: number;
  medianPassingPerDay: number;
  medianBestYield: number | null;
  pooledMedianYield: number | null;
}

export interface AnalysisChainSummary {
  /** grid[view][year][range]. */
  grid: Record<AnalysisChainView, Record<string, Record<AnalysisDteRange, AnalysisGridCell>>>;
  /** First and last scanned day of each calendar year (partial years are labelled). */
  years: Record<string, { from: string; to: string }>;
  /** One row per month: the median a day of Calls, Puts and capped Puts passing, and of the daily totals (F6). */
  monthly: { month: string; days: number; callsMedian: number; putsMedian: number; cappedPutsMedian: number; totalMedian: number; cappedTotalMedian: number }[];
  /** Days skipped: no 10:00 price (or no split factor). */
  daysWithoutPrice: number;
  /** Days with a price where nothing passed. */
  daysWithNothingPassing: string[];
  /** Share of passing contract-days quoted at or under 25% of the mid. */
  spreadShareUnder25: number | null;
}

/** Aggregates the day rows into the grid, the months and the counts. Pure. */
export function summarizeChainScan(rows: readonly ChainScanDayRow[]): AnalysisChainSummary {
  const priced = rows.filter((row) => row.spot !== null);
  const grid = { C: {}, P: {}, Pcap: {} } as AnalysisChainSummary["grid"];
  const years: AnalysisChainSummary["years"] = {};
  const byYear = new Map<string, ChainScanDayRow[]>();
  for (const row of priced) {
    const year = row.date.slice(0, 4);
    (byYear.get(year) ?? byYear.set(year, []).get(year)!).push(row);
    const span = (years[year] ??= { from: row.date, to: row.date });
    if (row.date < span.from) span.from = row.date;
    if (row.date > span.to) span.to = row.date;
  }
  for (const view of ["C", "P", "Pcap"] as const) {
    for (const [year, yearRows] of byYear) {
      const cells = {} as Record<AnalysisDteRange, AnalysisGridCell>;
      for (const { key } of analysisDteRanges) {
        const perDay = yearRows.map((row) => row.cells[view][key]);
        const counts = perDay.map((cell) => cell?.count ?? 0);
        cells[key] = {
          days: yearRows.length,
          daysWithPassing: counts.filter((count) => count > 0).length,
          medianPassingPerDay: median(counts) ?? 0,
          medianBestYield: median(perDay.filter((cell): cell is ChainScanCell => cell !== undefined).map((cell) => cell.best)),
          pooledMedianYield: median(perDay.flatMap((cell) => cell?.yields ?? [])),
        };
      }
      grid[view][year] = cells;
    }
  }
  const total = (row: ChainScanDayRow, view: AnalysisChainView) => Object.values(row.cells[view]).reduce((sum, cell) => sum + (cell?.count ?? 0), 0);
  const byMonth = new Map<string, ChainScanDayRow[]>();
  for (const row of priced) (byMonth.get(row.date.slice(0, 7)) ?? byMonth.set(row.date.slice(0, 7), []).get(row.date.slice(0, 7))!).push(row);
  const monthly = [...byMonth.entries()].map(([month, monthRows]) => ({
    month,
    days: monthRows.length,
    callsMedian: median(monthRows.map((row) => total(row, "C")))!,
    putsMedian: median(monthRows.map((row) => total(row, "P")))!,
    cappedPutsMedian: median(monthRows.map((row) => total(row, "Pcap")))!,
    totalMedian: median(monthRows.map((row) => total(row, "C") + total(row, "P")))!,
    cappedTotalMedian: median(monthRows.map((row) => total(row, "C") + total(row, "Pcap")))!,
  }));
  const passingTotal = priced.reduce((sum, row) => sum + row.passingTotal, 0);
  return {
    grid,
    years,
    monthly,
    daysWithoutPrice: rows.length - priced.length,
    daysWithNothingPassing: priced.filter((row) => row.passingTotal === 0).map((row) => row.date),
    spreadShareUnder25: passingTotal === 0 ? null : priced.reduce((sum, row) => sum + row.spreadsUnder25, 0) / passingTotal,
  };
}
