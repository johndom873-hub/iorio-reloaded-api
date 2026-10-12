import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { easternInstant, easternIsoDate } from "../lib/easternIsoDate.js";
import { majorMacroEventLookaheadDays, type MacroEvent } from "../lib/macroEventCalendar.js";
import {
  dataReleaseEasternTime,
  fedRateDecisionEasternTime,
  fedRateDecisionTitle,
  federalElectionEasternTime,
  fetchFomcCalendarPage,
  fetchFredReleaseDates,
  fredMajorReleases,
  generateUsFederalElectionDays,
  parseFomcRateDecisionDates,
  type MajorMacroEventKey,
} from "../lib/majorMacroEventSources.js";
import { runWithRetries } from "../lib/riskFreeRate.js";
import { addCalendarDays } from "../lib/signalsRoadmap.js";

// The major macro events of the past, for a backtest (docs/backtesting/FORMULAS.md, "Macro events"): the Fed rate
// decisions, CPI, GDP, the jobs report and US federal elections from 2019 on, from the sources the live calendar reads
// (lib/majorMacroEventSources.ts): FRED's release dates, the Federal Reserve's FOMC pages and the election rule. The live
// table keeps only what is still ahead, so the history is rebuilt here and cached as BACKTEST_DATA_DIR/macro-events.json;
// it is fetched again when the cache was built before a session's last day.
//
// The dates are the ones the sources hold now: a release that was moved is known here at its final date from the start,
// and a meeting scheduled and then cancelled (the Fed's 17-18 March 2020) is absent, as the unscheduled ones are.

/** The history starts here: before any option data file can (2020), with a year of room. */
export const macroEventHistoryStartIso = "2019-01-01";
const historicalPageRequestTimeoutMs = 10_000;
const historicalPageAttempts = 3;
const historicalPageRetryBackoffMs = [2_000, 4_000];

export interface HistoricalMacroEvent extends MacroEvent {
  eventKey: MajorMacroEventKey;
}

export interface MacroEventHistoryCache {
  builtAtIso: string;
  firstDateIso: string;
  events: HistoricalMacroEvent[];
}

const monthNumberByName: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/**
 * The rate-decision dates (the last day of each scheduled meeting) on one of the Fed's pages for a past year
 * (fomchistoricalYYYY.htm), ascending. Its meetings are headed "January 28-29 Meeting - 2020", "April/May 30-1 Meeting -
 * 2019"; a heading with a parenthesis ("March 15 (unscheduled) Meeting - 2020", "(notation vote)", "(cancelled)") is
 * skipped, as on the current calendar. Throws when the page shows no scheduled meeting of the year.
 */
export function parseFomcHistoricalRateDecisionDates(html: string, year: number): string[] {
  const decisionDates: string[] = [];
  for (const heading of html.matchAll(/<h5[^>]*>([^<]*)<\/h5>/g)) {
    const text = heading[1]!.trim();
    if (text.includes("(")) continue;
    const meeting = text.match(/^([A-Za-z]+)(?:\/([A-Za-z]+))?\s+(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s+Meeting\s+-\s+(\d{4})$/);
    if (!meeting || Number(meeting[5]) !== year) continue;
    const firstMonth = monthNumberByName[meeting[1]!.toLowerCase()];
    const decisionMonth = monthNumberByName[(meeting[2] ?? meeting[1]!).toLowerCase()];
    if (firstMonth === undefined || decisionMonth === undefined) throw new Error(`FOMC ${year} page: unknown month in "${text}"`);
    const decisionYear = decisionMonth < firstMonth ? year + 1 : year;
    decisionDates.push(new Date(Date.UTC(decisionYear, decisionMonth - 1, Number(meeting[4] ?? meeting[3]))).toISOString().slice(0, 10));
  }
  if (decisionDates.length === 0) throw new Error(`FOMC ${year} page: no scheduled meeting found`);
  return [...new Set(decisionDates)].sort();
}

async function fetchFomcHistoricalPage(year: number): Promise<string> {
  return runWithRetries(
    async () => {
      const response = await fetch(`https://www.federalreserve.gov/monetarypolicy/fomchistorical${year}.htm`, { headers: { "User-Agent": "Mozilla/5.0 (iorio-reloaded calendar capture)" }, signal: AbortSignal.timeout(historicalPageRequestTimeoutMs) });
      if (!response.ok) throw new Error(`federalreserve.gov FOMC ${year} page responded ${response.status}`);
      return response.text();
    },
    historicalPageAttempts,
    historicalPageRetryBackoffMs,
  );
}

/** Every source read once: FRED's three releases from the history's start, the FOMC calendar and the Fed's pages of the years before it, and the election rule through next year. */
export async function fetchMacroEventHistory(now: Date = new Date()): Promise<HistoricalMacroEvent[]> {
  const firstYear = Number(macroEventHistoryStartIso.slice(0, 4));
  const event = (eventKey: MajorMacroEventKey, title: string, dateIso: string, time: { hour: number; minute: number }): HistoricalMacroEvent => ({ eventKey, title, dateIso, eventAtIso: easternInstant(dateIso, time.hour, time.minute).toISOString() });

  const releases = await Promise.all(fredMajorReleases.map(async (release) => (await fetchFredReleaseDates(release.releaseId, macroEventHistoryStartIso)).map((dateIso) => event(release.eventKey, release.title, dateIso, dataReleaseEasternTime))));

  const calendarDecisionDates = parseFomcRateDecisionDates(await fetchFomcCalendarPage());
  const firstCalendarYear = Number(calendarDecisionDates[0]!.slice(0, 4));
  const earlierDecisionDates: string[] = [];
  for (let year = firstYear; year < firstCalendarYear; year++) earlierDecisionDates.push(...parseFomcHistoricalRateDecisionDates(await fetchFomcHistoricalPage(year), year));
  const decisions = [...new Set([...earlierDecisionDates, ...calendarDecisionDates])].filter((dateIso) => dateIso >= macroEventHistoryStartIso).map((dateIso) => event("fed_rate_decision", fedRateDecisionTitle, dateIso, fedRateDecisionEasternTime));

  const elections = generateUsFederalElectionDays(firstYear, Number(easternIsoDate(now).slice(0, 4)) + 1).map((election) => event("us_federal_election", election.title, election.dateIso, federalElectionEasternTime));

  return [...releases.flat(), ...decisions, ...elections].sort((a, b) => a.eventAtIso.localeCompare(b.eventAtIso) || a.title.localeCompare(b.title));
}

/** The events of a period, with "what was still ahead on a day" lookups. Events ascending by time. */
export class MacroEventHistory {
  constructor(private readonly events: readonly HistoricalMacroEvent[]) {}

  get count(): number {
    return this.events.length;
  }

  /**
   * What the live calendar would hold on `todayIso` (loadUpcomingMajorMacroEvents): the events dated from that day
   * through the calendar's lookahead, in time order.
   */
  upcomingOn(todayIso: string): MacroEvent[] {
    const lastDateIso = addCalendarDays(todayIso, majorMacroEventLookaheadDays);
    return this.events.filter((entry) => entry.dateIso >= todayIso && entry.dateIso <= lastDateIso).map((entry) => ({ dateIso: entry.dateIso, eventAtIso: entry.eventAtIso, title: entry.title }));
  }
}

export function macroEventHistoryCachePath(dataDirectory: string): string {
  return path.join(dataDirectory, "macro-events.json");
}

/** Pure: a cache serves a session when it starts at the history's start and was built on or after the session's last day (or today, for a session ending today or later). */
export function macroEventHistoryCacheCovers(cache: MacroEventHistoryCache, lastDateIso: string, now: Date): boolean {
  const todayIso = easternIsoDate(now);
  return cache.firstDateIso <= macroEventHistoryStartIso && easternIsoDate(new Date(cache.builtAtIso)) >= (lastDateIso < todayIso ? lastDateIso : todayIso);
}

/** The history for a session ending on `lastDateIso`: the cache when it covers it, else every source read again and the cache rewritten. */
export async function loadMacroEventHistory(dataDirectory: string, lastDateIso: string, fetchHistory: (now: Date) => Promise<HistoricalMacroEvent[]> = fetchMacroEventHistory, now: Date = new Date()): Promise<MacroEventHistory> {
  const cachePath = macroEventHistoryCachePath(dataDirectory);
  const cached: MacroEventHistoryCache | null = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as MacroEventHistoryCache) : null;
  if (cached && macroEventHistoryCacheCovers(cached, lastDateIso, now)) return new MacroEventHistory(cached.events);
  let events: HistoricalMacroEvent[];
  try {
    events = await fetchHistory(now);
  } catch (error) {
    throw new Error(`The macro-event history could not be built (${error instanceof Error ? error.message : String(error)}): the macro flag and the closes before a macro event need it. Check FRED_API_KEY and the connection, then run the session again.`);
  }
  const cache: MacroEventHistoryCache = { builtAtIso: now.toISOString(), firstDateIso: macroEventHistoryStartIso, events };
  writeFileSync(cachePath, JSON.stringify(cache));
  return new MacroEventHistory(events);
}
