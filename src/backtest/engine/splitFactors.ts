import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestDetectedSplit } from "../backtestTypes.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { BacktestBarHistory, loadBacktestBarHistory } from "./backtestBarHistory.js";
import { computeParityStockPrice } from "./backtestBook.js";
import { BacktestSymbolFile } from "./backtestSymbolFile.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "./treasuryBillRates.js";

// IBKR's daily bars are split-adjusted (SMCI's 2020 closes are a tenth of what traded); ThetaData's option history is as
// traded (SMCI 2020 strikes $20–35). Each file day D gets the cumulative split factor F(D) = traded price ÷ adjusted
// price, inferred from our own data (Marcelo 2026-10-12, no other source):
//
//   r(D) = the options' CLOSING parity price on D (the closing NBBO mids, the same parity rule as the 10:00 price)
//          ÷ IBKR's adjusted close of D
//   F    = r snapped to the nearest "nice" cumulative factor within ±3%: 1, or a product of up to three standard split
//          ratios (2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50, 1.5, 1.25), all forward splits or all reverse splits
//          (their reciprocals). Among factors within ±3% the one made of the fewest splits wins, then the nearest.
//   F is piecewise constant: each valid day's factor is the snapped median of the 5 valid days centred on it; a run of
//   one factor counts only when it holds for at least 5 valid days. Days with no valid ratio, and gaps of fewer than 5
//   valid days between two runs of the same factor, take that factor; so does a longer gap between two runs of the same
//   factor (at most 30 file days) whose median ratio is nearer that factor than any other nice factor: a stock does not
//   split and un-split within weeks, it is a thin chain's noisy closing quotes (AAOI 2022 at $2–3). Between two different
//   factors the change point is the one the gap's own ratios fit best; an edge stretch takes its neighbour's factor when
//   its ratios agree with it. Anything else (5 or more valid days no factor holds for, a new factor seen on fewer than 5
//   days at the file's edge) stays unresolved: a session touching it fails, naming the dates and the raw ratios.
//
// A detected split is a change point: { last day on the old scale, first day on the new, ratio = F(before) ÷ F(after) }.
//
// A change point whose ratio is no single standard split (one of the ratios above or its reverse, within ±3%) means the
// options before it are another security's, or wrong (Marcelo 2026-10-20): META's options of 2021-07 to 2022-01 are a
// $10–30 ETF's (Facebook's traded as FB until 2022-06-09), and their ratio to IBKR's Meta closes drifts, reading as
// 9-for-10, 14-for-15, 20-for-21 and so on. The schedule then starts at the first day after the last such change: a
// session over the days before it fails, and a download that finds one fails, naming the date to download from.

export const standardSplitRatios: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50, 1.5, 1.25];
export const splitSnapTolerance = 0.03;
export const splitPersistenceDays = 5;
export const maximumSplitsPerFactor = 3;
/** The longest gap (file days) between two runs of the same factor that takes that factor when its median is nearest it. */
export const maximumSameFactorGapDays = 30;
/** Raise when the rule or the cache format changes, so cached schedules are rebuilt. */
const splitScheduleVersion = 3;

export interface NiceSplitFactor {
  factor: number;
  /** How many standard splits it takes (0 for 1). */
  splitCount: number;
}

function buildNiceSplitFactors(): NiceSplitFactor[] {
  const bestByFactor = new Map<number, NiceSplitFactor>([[1, { factor: 1, splitCount: 0 }]]);
  for (const direction of [1, -1]) {
    const ratios = standardSplitRatios.map((ratio) => ratio ** direction);
    const extend = (product: number, count: number, startIndex: number) => {
      if (count > 0) {
        const key = Math.round(product * 1e9) / 1e9;
        const known = bestByFactor.get(key);
        if (!known || known.splitCount > count) bestByFactor.set(key, { factor: product, splitCount: count });
      }
      if (count === maximumSplitsPerFactor) return;
      for (let index = startIndex; index < ratios.length; index++) extend(product * ratios[index]!, count + 1, index);
    };
    extend(1, 0, 0);
  }
  return [...bestByFactor.values()].sort((a, b) => a.factor - b.factor);
}

export const niceSplitFactors: readonly NiceSplitFactor[] = buildNiceSplitFactors();

/** The nice factor a ratio stands for, or null when none is within ±3%: the fewest splits first, then the nearest. */
export function snapToNiceSplitFactor(ratio: number): number | null {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  let best: { factor: NiceSplitFactor; distance: number } | null = null;
  for (const candidate of niceSplitFactors) {
    const distance = Math.abs(ratio / candidate.factor - 1);
    if (distance > splitSnapTolerance) continue;
    if (!best || candidate.splitCount < best.factor.splitCount || (candidate.splitCount === best.factor.splitCount && distance < best.distance)) best = { factor: candidate, distance };
  }
  return best?.factor.factor ?? null;
}

/** The nice factor nearest a ratio (log distance), however far. */
export function nearestNiceSplitFactor(ratio: number): number {
  let nearest = niceSplitFactors[0]!.factor;
  for (const candidate of niceSplitFactors) if (Math.abs(Math.log(ratio / candidate.factor)) < Math.abs(Math.log(ratio / nearest))) nearest = candidate.factor;
  return nearest;
}

export interface DailySplitRatio {
  dateIso: string;
  /** Closing parity ÷ adjusted close; null when either is missing. */
  ratio: number | null;
}

export interface SplitFactorSegment {
  fromDateIso: string;
  toDateIso: string;
  factor: number;
}

export interface UnresolvedSplitStretch {
  fromDateIso: string;
  toDateIso: string;
  ratios: DailySplitRatio[];
}

/** The file days before `firstDayIso` match no standard split: the changes of scale that showed it, oldest first. */
export interface UnmatchedOptions {
  firstDayIso: string;
  changes: BacktestDetectedSplit[];
}

export interface SplitSchedule {
  /** Ascending, covering every resolved file day (from unmatchedOptionsBefore's first day when it is set). */
  segments: SplitFactorSegment[];
  splits: BacktestDetectedSplit[];
  unresolved: UnresolvedSplitStretch[];
  /** Set when a change of scale is no standard split: the schedule starts after the last one. Absent in caches before version 3. */
  unmatchedOptionsBefore?: UnmatchedOptions | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const roundRatio = (value: number) => Math.round(value * 1e6) / 1e6;

/** Pure: the schedule from each file day's ratio (`days` ascending, every complete file day once). */
export function inferSplitSchedule(days: readonly DailySplitRatio[]): SplitSchedule {
  const factorByDay: (number | null)[] = days.map(() => null);
  const unresolvedDay: boolean[] = days.map(() => false);
  const validDayIndexes = days.flatMap((day, index) => (day.ratio !== null && day.ratio > 0 && Number.isFinite(day.ratio) ? [index] : []));
  const validCount = validDayIndexes.length;
  const windowSize = Math.min(splitPersistenceDays, validCount);

  // Each valid day's snapped median over the window of valid days centred on it (clipped at the ends).
  const snapped = validDayIndexes.map((_, position) => {
    const start = Math.min(Math.max(0, position - Math.floor(splitPersistenceDays / 2)), validCount - windowSize);
    return snapToNiceSplitFactor(median(validDayIndexes.slice(start, start + windowSize).map((dayIndex) => days[dayIndex]!.ratio!)));
  });

  // Runs of one snapped factor; the persistent ones fix F.
  const runs: { factor: number | null; firstPosition: number; lastPosition: number }[] = [];
  snapped.forEach((factor, position) => {
    const last = runs.at(-1);
    if (last && last.factor === factor) last.lastPosition = position;
    else runs.push({ factor, firstPosition: position, lastPosition: position });
  });
  const persistent = runs.filter((run) => run.factor !== null && run.lastPosition - run.firstPosition + 1 >= windowSize && windowSize > 0) as { factor: number; firstPosition: number; lastPosition: number }[];

  const ratioOf = (dayIndex: number) => days[dayIndex]!.ratio;
  const validIn = (fromDay: number, toDay: number) => validDayIndexes.filter((dayIndex) => dayIndex >= fromDay && dayIndex <= toDay);
  const assign = (fromDay: number, toDay: number, factor: number) => {
    for (let dayIndex = fromDay; dayIndex <= toDay; dayIndex++) factorByDay[dayIndex] = factor;
  };
  const markUnresolved = (fromDay: number, toDay: number) => {
    for (let dayIndex = fromDay; dayIndex <= toDay; dayIndex++) unresolvedDay[dayIndex] = true;
  };
  /** An edge stretch takes its neighbour's factor when its own valid ratios, taken together, stand for that factor. */
  const settleEdge = (fromDay: number, toDay: number, neighbourFactor: number) => {
    if (toDay < fromDay) return;
    const valid = validIn(fromDay, toDay);
    if (valid.length === 0 || snapToNiceSplitFactor(median(valid.map((dayIndex) => ratioOf(dayIndex)!))) === neighbourFactor) assign(fromDay, toDay, neighbourFactor);
    else markUnresolved(fromDay, toDay);
  };

  if (persistent.length === 0) {
    if (days.length > 0) markUnresolved(0, days.length - 1);
  } else {
    for (const run of persistent) assign(validDayIndexes[run.firstPosition]!, validDayIndexes[run.lastPosition]!, run.factor);
    settleEdge(0, validDayIndexes[persistent[0]!.firstPosition]! - 1, persistent[0]!.factor);
    settleEdge(validDayIndexes[persistent.at(-1)!.lastPosition]! + 1, days.length - 1, persistent.at(-1)!.factor);
    for (let index = 1; index < persistent.length; index++) {
      const before = persistent[index - 1]!;
      const after = persistent[index]!;
      const gapFrom = validDayIndexes[before.lastPosition]! + 1;
      const gapTo = validDayIndexes[after.firstPosition]! - 1;
      const gapValid = validIn(gapFrom, gapTo);
      const noisyGapOfOneFactor =
        before.factor === after.factor && gapTo - gapFrom + 1 <= maximumSameFactorGapDays && nearestNiceSplitFactor(median(gapValid.map((dayIndex) => ratioOf(dayIndex)!))) === before.factor;
      if (gapValid.length >= splitPersistenceDays && noisyGapOfOneFactor) {
        assign(gapFrom, gapTo, before.factor);
        continue;
      }
      // Otherwise, five or more valid days that formed no persistent run are a stretch no standard factor explains.
      if (gapValid.length >= splitPersistenceDays) {
        markUnresolved(gapFrom, gapTo);
        continue;
      }
      if (before.factor === after.factor) {
        assign(gapFrom, gapTo, before.factor);
        continue;
      }
      // The first day on the new scale: the candidate the gap's ratios fit best (log distance to each factor).
      let bestChange = gapFrom;
      let bestMisfit = Number.POSITIVE_INFINITY;
      for (let change = gapFrom; change <= gapTo + 1; change++) {
        const misfit = gapValid.reduce((sum, dayIndex) => sum + Math.abs(Math.log(ratioOf(dayIndex)! / (dayIndex < change ? before.factor : after.factor))), 0);
        if (misfit < bestMisfit - 1e-12) {
          bestMisfit = misfit;
          bestChange = change;
        }
      }
      // Days with no ratio between the last day the old factor fits and the first the new one does could be either.
      const lastValidBefore = gapValid.filter((dayIndex) => dayIndex < bestChange).at(-1) ?? gapFrom - 1;
      const firstValidAfter = gapValid.find((dayIndex) => dayIndex >= bestChange) ?? gapTo + 1;
      assign(gapFrom, lastValidBefore, before.factor);
      assign(firstValidAfter, gapTo, after.factor);
      if (firstValidAfter - lastValidBefore > 1) markUnresolved(lastValidBefore + 1, firstValidAfter - 1);
    }
  }

  const segments: SplitFactorSegment[] = [];
  const unresolved: UnresolvedSplitStretch[] = [];
  let previousFactor: number | null | undefined;
  days.forEach((day, dayIndex) => {
    const factor = unresolvedDay[dayIndex] ? null : factorByDay[dayIndex]!;
    if (factor === null) {
      if (previousFactor === null) {
        const last = unresolved.at(-1)!;
        last.toDateIso = day.dateIso;
        last.ratios.push(day);
      } else unresolved.push({ fromDateIso: day.dateIso, toDateIso: day.dateIso, ratios: [day] });
    } else if (previousFactor === factor) segments.at(-1)!.toDateIso = day.dateIso;
    else segments.push({ fromDateIso: day.dateIso, toDateIso: day.dateIso, factor });
    previousFactor = factor;
  });
  const splits: BacktestDetectedSplit[] = [];
  for (let index = 1; index < segments.length; index++) {
    const before = segments[index - 1]!;
    const after = segments[index]!;
    if (before.factor !== after.factor) splits.push({ lastDayBefore: before.toDateIso, firstDayAfter: after.fromDateIso, ratio: roundRatio(before.factor / after.factor) });
  }
  return startAfterNonStandardChanges({ segments, splits, unresolved });
}

/** Whether a change of scale is one standard split, forward or reverse (within ±3%). */
export function isStandardSplitRatio(ratio: number): boolean {
  return ratio > 0 && standardSplitRatios.some((standard) => Math.abs(ratio / standard - 1) <= splitSnapTolerance || Math.abs(ratio * standard - 1) <= splitSnapTolerance);
}

/** The schedule from the first day after its last change of scale that is no standard split; as it was when every change is one. */
export function startAfterNonStandardChanges(schedule: Pick<SplitSchedule, "segments" | "splits" | "unresolved">): SplitSchedule {
  const changes = schedule.splits.filter((split) => !isStandardSplitRatio(split.ratio));
  const lastChange = changes.at(-1);
  if (!lastChange) return { segments: schedule.segments, splits: schedule.splits, unresolved: schedule.unresolved, unmatchedOptionsBefore: null };
  const firstDayIso = lastChange.firstDayAfter;
  return {
    segments: schedule.segments.filter((segment) => segment.fromDateIso >= firstDayIso),
    splits: schedule.splits.filter((split) => split.lastDayBefore >= firstDayIso),
    unresolved: schedule.unresolved.filter((stretch) => stretch.fromDateIso >= firstDayIso),
    unmatchedOptionsBefore: { firstDayIso, changes },
  };
}

/** New shares per old share in words, as the app writes them: 10 → "10-for-1", 1.5 → "3-for-2", 0.9 → "9-for-10", 0.1 → "1-for-10". */
export function describeSplitRatio(ratio: number): string {
  const flipped = ratio < 1 ? 1 / ratio : ratio;
  for (let denominator = 1; denominator <= 20; denominator++) {
    const numerator = Math.round(flipped * denominator);
    if (Math.abs(numerator / denominator - flipped) < 0.001) return ratio < 1 ? `${denominator}-for-${numerator}` : `${numerator}-for-${denominator}`;
  }
  return ratio < 1 ? `1-for-${Number(flipped.toFixed(3))}` : `${Number(ratio.toFixed(3))}-for-1`;
}

/** Why a file's options before a date can't be used: "The META options before 2022-06-09 match IBKR's META prices by no standard split (…)". */
export function describeUnmatchedOptions(symbol: string, unmatched: UnmatchedOptions): string {
  const changes = unmatched.changes.map((change) => `${describeSplitRatio(change.ratio)} on ${change.firstDayAfter}`);
  const listed = changes.length > 4 ? [...changes.slice(0, 3), `${changes.length - 3} more`] : changes;
  return `The ${symbol} options before ${unmatched.firstDayIso} match IBKR's ${symbol} prices by no standard split (their scale changes by ${listed.join(", ")}): the symbol belonged to another security then, or the data is wrong.`;
}

export class UnmatchedOptionsError extends Error {
  constructor(symbol: string, unmatched: UnmatchedOptions) {
    super(`${describeUnmatchedOptions(symbol, unmatched)} Start the session on or after ${unmatched.firstDayIso}, or delete the ${symbol} file and download it again from ${unmatched.firstDayIso}.`);
    this.name = "UnmatchedOptionsError";
  }
}

/** F on a date: the segment holding it, else the last segment before it (a date that is not a file day); null when unresolved or before the schedule. */
export function splitFactorOn(schedule: SplitSchedule, dateIso: string): number | null {
  if (schedule.unresolved.some((stretch) => dateIso >= stretch.fromDateIso && dateIso <= stretch.toDateIso)) return null;
  let found: SplitFactorSegment | null = null;
  for (const segment of schedule.segments) {
    if (segment.fromDateIso > dateIso) break;
    found = segment;
  }
  return found?.factor ?? null;
}

export class UnresolvedSplitScaleError extends Error {
  constructor(symbol: string, stretch: UnresolvedSplitStretch) {
    const ratios = stretch.ratios.map((day) => `${day.dateIso} ${day.ratio === null ? "no ratio" : day.ratio.toFixed(3)}`).join(", ");
    super(
      `The ${symbol} price scale cannot be inferred for ${stretch.fromDateIso} to ${stretch.toDateIso}: the options' closing price ÷ IBKR's split-adjusted close was ${ratios}, and no standard split factor holds there for ${splitPersistenceDays} days in a row. Check the data (or download more days around it) before running a session over these dates.`,
    );
    this.name = "UnresolvedSplitScaleError";
  }
}

/** F for every date in `datesIso`; throws on the first date before the options match IBKR's prices, or in an unresolved stretch. */
export function requireSplitFactors(symbol: string, schedule: SplitSchedule, datesIso: readonly string[]): Map<string, number> {
  const factors = new Map<string, number>();
  const unmatched = schedule.unmatchedOptionsBefore;
  for (const dateIso of datesIso) {
    if (unmatched && dateIso < unmatched.firstDayIso) throw new UnmatchedOptionsError(symbol, unmatched);
    const factor = splitFactorOn(schedule, dateIso);
    if (factor === null) {
      const stretch = schedule.unresolved.find((entry) => dateIso >= entry.fromDateIso && dateIso <= entry.toDateIso) ?? { fromDateIso: dateIso, toDateIso: dateIso, ratios: [{ dateIso, ratio: null }] };
      throw new UnresolvedSplitScaleError(symbol, stretch);
    }
    factors.set(dateIso, factor);
  }
  return factors;
}

// --- Data and cache --------------------------------------------------------------------------------------------------

/** What a schedule was inferred from: any change (more days downloaded, bars backfilled) makes the cache stale. */
export interface SplitScheduleFingerprint {
  version: number;
  fileCompleteDays: number;
  fileLastDateIso: string | null;
  barCount: number;
  barLastDateIso: string | null;
}

export interface SplitScheduleCache {
  symbol: string;
  fingerprint: SplitScheduleFingerprint;
  builtAtIso: string;
  schedule: SplitSchedule;
}

export function splitScheduleFingerprint(fileCompleteDays: number, fileLastDateIso: string | null, barCount: number, barLastDateIso: string | null): SplitScheduleFingerprint {
  return { version: splitScheduleVersion, fileCompleteDays, fileLastDateIso, barCount, barLastDateIso };
}

export function splitScheduleCachePath(dataDirectory: string, symbol: string): string {
  return path.join(dataDirectory, "splits", `${symbol}.json`);
}

export function readSplitScheduleCache(dataDirectory: string, symbol: string): SplitScheduleCache | null {
  const cachePath = splitScheduleCachePath(dataDirectory, symbol);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as SplitScheduleCache;
  } catch {
    return null;
  }
}

export function writeSplitScheduleCache(dataDirectory: string, cache: SplitScheduleCache): void {
  const cachePath = splitScheduleCachePath(dataDirectory, cache.symbol);
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
}

export function splitScheduleFingerprintsMatch(a: SplitScheduleFingerprint, b: SplitScheduleFingerprint): boolean {
  return a.version === b.version && a.fileCompleteDays === b.fileCompleteDays && a.fileLastDateIso === b.fileLastDateIso && a.barCount === b.barCount && a.barLastDateIso === b.barLastDateIso;
}

/** Each complete file day's closing parity price ÷ IBKR's adjusted close of that day. */
export function computeDailySplitRatios(file: BacktestSymbolFile, completeDaysIso: readonly string[], bars: BacktestBarHistory, rates: TreasuryBillRates): DailySplitRatio[] {
  return completeDaysIso.map((dateIso) => {
    const adjustedClose = bars.closeOn(dateIso);
    if (adjustedClose === null || !(adjustedClose > 0)) return { dateIso, ratio: null };
    const parity = computeParityStockPrice(file.loadEndOfDay(dateIso), dateIso, (rates.ratePercentOnOrBefore(dateIso) ?? 0) / 100, null);
    return { dateIso, ratio: parity ? parity.price / adjustedClose : null };
  });
}

/** The cached schedule when it matches the data, else inferred now and cached. */
export function loadOrInferSplitSchedule(dataDirectory: string, symbol: string, file: BacktestSymbolFile, completeDaysIso: readonly string[], bars: BacktestBarHistory, rates: TreasuryBillRates): { schedule: SplitSchedule; cached: boolean } {
  const fingerprint = splitScheduleFingerprint(completeDaysIso.length, completeDaysIso.at(-1) ?? null, bars.rows.length, bars.lastDateIso());
  const cache = readSplitScheduleCache(dataDirectory, symbol);
  if (cache && splitScheduleFingerprintsMatch(cache.fingerprint, fingerprint)) return { schedule: cache.schedule, cached: true };
  const schedule = inferSplitSchedule(computeDailySplitRatios(file, completeDaysIso, bars, rates));
  writeSplitScheduleCache(dataDirectory, { symbol, fingerprint, builtAtIso: new Date().toISOString(), schedule });
  return { schedule, cached: false };
}

/**
 * After a download: infer (or confirm) the symbol's schedule from its whole file and cache it, against the IBKR daily
 * bars the file keeps (what a session reads); a file without them yet is read against the local DB's.
 */
export async function refreshSplitScheduleForSymbol(symbol: string, connection: Knex = db): Promise<SplitSchedule | null> {
  const ticker: { id: string } | undefined = await connection("tickers").where({ symbol }).first("id");
  if (!ticker) return null;
  const dataDirectory = requireBacktestDataDirectory();
  const file = BacktestSymbolFile.open(symbol);
  try {
    const completeDaysIso = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
    if (completeDaysIso.length === 0) return null;
    const fileBars = file.loadIbkrDailyBars();
    const bars = fileBars ? new BacktestBarHistory(fileBars) : await loadBacktestBarHistory(ticker.id, connection);
    const rates = await loadTreasuryBillRates(dataDirectory, completeDaysIso[0]!, completeDaysIso.at(-1)!);
    return loadOrInferSplitSchedule(dataDirectory, symbol, file, completeDaysIso, bars, rates).schedule;
  } finally {
    file.close();
  }
}
