import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireEnvironmentVariable } from "../../config/env.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";

// The 3-month Treasury bill rate for the backtest (docs/backtesting/FORMULAS.md, "Interest on idle cash"): FRED series
// DTB3, daily, in percent. It is both the interest idle cash earns and the risk-free rate of the day's surface fit and
// stock price. Cached as BACKTEST_DATA_DIR/fred-DTB3.json and fetched again (one request, the whole series) only when the
// cache does not reach a session's dates.

export const treasuryBillSeriesId = "DTB3";
/** The series is fetched from here on: every session's dates (2016 and later) and some room before. */
export const treasuryBillSeriesStartIso = "2010-01-01";
const fredRequestTimeoutMs = 30_000;
/** A cache ending this many calendar days before the last day it must serve still covers it (weekends, holidays, FRED's one-day lag). */
const allowedTrailingGapDays = 5;
/** A cache fetched at least this long after the last day it must serve is as complete as FRED gets: no refetch. */
const settledAfterDays = 3;

export interface TreasuryBillObservation {
  dateIso: string;
  ratePercent: number;
}

export interface TreasuryBillCache {
  seriesId: typeof treasuryBillSeriesId;
  fetchedAtIso: string;
  observations: TreasuryBillObservation[];
}

/** The series with "latest observation on or before a date" lookups. Observations ascending by date. */
export class TreasuryBillRates {
  constructor(private readonly observations: readonly TreasuryBillObservation[]) {}

  /** The latest rate (percent) observed on or before `dateIso`; null before the series starts. */
  ratePercentOnOrBefore(dateIso: string): number | null {
    let low = 0;
    let high = this.observations.length - 1;
    let found: TreasuryBillObservation | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const observation = this.observations[middle]!;
      if (observation.dateIso <= dateIso) {
        found = observation;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found?.ratePercent ?? null;
  }
}

/** Pure: whether a cache serves every day from `firstDateIso` to `lastDateIso` (both the day itself and the day before are looked up). */
export function treasuryBillCacheCovers(cache: TreasuryBillCache, firstDateIso: string, lastDateIso: string): boolean {
  const first = cache.observations[0]?.dateIso;
  const last = cache.observations.at(-1)?.dateIso;
  if (!first || !last || first > addCalendarDays(firstDateIso, -1)) return false;
  if (last >= addCalendarDays(lastDateIso, -allowedTrailingGapDays)) return true;
  return cache.fetchedAtIso.slice(0, 10) >= addCalendarDays(lastDateIso, settledAfterDays);
}

/** Pure: FRED's observations (value "." = no observation that day) as ascending numeric observations. */
export function parseFredObservations(observations: { date: string; value: string }[]): TreasuryBillObservation[] {
  return observations
    .map((observation) => ({ dateIso: observation.date, ratePercent: Number.parseFloat(observation.value) }))
    .filter((observation) => Number.isFinite(observation.ratePercent))
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

export async function fetchTreasuryBillSeriesFromFred(): Promise<TreasuryBillObservation[]> {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", treasuryBillSeriesId);
  url.searchParams.set("observation_start", treasuryBillSeriesStartIso);
  url.searchParams.set("api_key", requireEnvironmentVariable("FRED_API_KEY"));
  url.searchParams.set("file_type", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(fredRequestTimeoutMs) });
  if (!response.ok) throw new Error(`FRED responded ${response.status} for ${treasuryBillSeriesId}`);
  const body = (await response.json()) as { observations?: { date: string; value: string }[] };
  const observations = parseFredObservations(body.observations ?? []);
  if (observations.length === 0) throw new Error(`FRED returned no ${treasuryBillSeriesId} observations`);
  return observations;
}

export function treasuryBillCachePath(dataDirectory: string): string {
  return path.join(dataDirectory, `fred-${treasuryBillSeriesId}.json`);
}

/** The rates for a session's days: the cache when it covers them, else one FRED request that rewrites the cache. */
export async function loadTreasuryBillRates(dataDirectory: string, firstDateIso: string, lastDateIso: string, fetchSeries: () => Promise<TreasuryBillObservation[]> = fetchTreasuryBillSeriesFromFred, now: Date = new Date()): Promise<TreasuryBillRates> {
  const cachePath = treasuryBillCachePath(dataDirectory);
  const cached: TreasuryBillCache | null = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as TreasuryBillCache) : null;
  if (cached && treasuryBillCacheCovers(cached, firstDateIso, lastDateIso)) return new TreasuryBillRates(cached.observations);
  const observations = await fetchSeries();
  const cache: TreasuryBillCache = { seriesId: treasuryBillSeriesId, fetchedAtIso: now.toISOString(), observations };
  writeFileSync(cachePath, JSON.stringify(cache));
  return new TreasuryBillRates(observations);
}
