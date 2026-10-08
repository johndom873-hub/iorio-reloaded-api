import { requireEnvironmentVariable } from "../config/env.js";
import { runWithRetries } from "./riskFreeRate.js";

// Where the major US macro events come from (stored by macroEventCalendar.ts):
//  - CPI and GDP: FRED's release calendar. FRED returns dates only; the releases are at 08:30 ET by convention.
//    Future dates are only returned with include_release_dates_with_no_data=true, and FRED carries them up to
//    the end of the year the agencies have published.
//  - Fed rate decision: the second day of each FOMC meeting, 14:00 ET, from the Federal Reserve's FOMC calendar
//    page (no API publishes it). Dates are tentative until the previous meeting confirms them, so it is re-read daily.
//  - US federal elections: fixed by law (the Tuesday after the first Monday in November, even years), 19:00 ET.

export type MajorMacroEventKey = "fed_rate_decision" | "cpi" | "gdp" | "us_federal_election";
export type MajorMacroEventSource = "federal_reserve" | "fred" | "election_rule";

export interface FredMajorRelease {
  eventKey: Extract<MajorMacroEventKey, "cpi" | "gdp">;
  title: string;
  releaseId: number;
}

export const fredMajorReleases: readonly FredMajorRelease[] = [
  { eventKey: "cpi", title: "CPI", releaseId: 10 },
  { eventKey: "gdp", title: "GDP", releaseId: 53 }, // advance, second and third estimates
];

export const fedRateDecisionTitle = "Fed rate decision";
export const dataReleaseEasternTime = { hour: 8, minute: 30 };
export const fedRateDecisionEasternTime = { hour: 14, minute: 0 };
export const federalElectionEasternTime = { hour: 19, minute: 0 }; // first polls close

const fomcCalendarUrl = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const sourceRequestTimeoutMs = 10_000;
const sourceAttempts = 3;
const sourceRetryBackoffMs = [2_000, 4_000];

/** Every release date FRED has for `releaseId` from `fromDateIso` on (YYYY-MM-DD, ascending). */
export async function fetchFredReleaseDates(releaseId: number, fromDateIso: string): Promise<string[]> {
  const url = new URL("https://api.stlouisfed.org/fred/release/dates");
  url.searchParams.set("release_id", String(releaseId));
  url.searchParams.set("realtime_start", fromDateIso);
  url.searchParams.set("realtime_end", "9999-12-31");
  url.searchParams.set("include_release_dates_with_no_data", "true");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("file_type", "json");
  url.searchParams.set("api_key", requireEnvironmentVariable("FRED_API_KEY"));

  const body = await runWithRetries(
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(sourceRequestTimeoutMs) });
      if (!response.ok) throw new Error(`FRED release ${releaseId} responded ${response.status}`);
      return (await response.json()) as { release_dates?: { date: string }[] };
    },
    sourceAttempts,
    sourceRetryBackoffMs,
  );
  if (!Array.isArray(body.release_dates)) throw new Error(`FRED release ${releaseId} returned no release_dates`);
  const dates = body.release_dates.map((entry) => entry.date);
  const malformed = dates.find((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date));
  if (malformed !== undefined) throw new Error(`FRED release ${releaseId} returned a malformed date: ${malformed}`);
  return dates.filter((date) => date >= fromDateIso);
}

export async function fetchFomcCalendarPage(): Promise<string> {
  return runWithRetries(
    async () => {
      const response = await fetch(fomcCalendarUrl, { headers: { "User-Agent": "Mozilla/5.0 (iorio-reloaded calendar capture)" }, signal: AbortSignal.timeout(sourceRequestTimeoutMs) });
      if (!response.ok) throw new Error(`federalreserve.gov FOMC calendar responded ${response.status}`);
      return response.text();
    },
    sourceAttempts,
    sourceRetryBackoffMs,
  );
}

const monthNumberByName: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function monthNumber(name: string): number {
  const month = monthNumberByName[name.trim().toLowerCase()];
  if (month === undefined) throw new Error(`FOMC calendar: unknown month "${name}"`);
  return month;
}

function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`FOMC calendar: invalid date ${year}-${month}-${day}`);
  return date.toISOString().slice(0, 10);
}

/**
 * The rate-decision dates (the last day of each scheduled meeting) of every "YYYY FOMC Meetings" section on the
 * Fed's calendar page, ascending. Entries look like month "October" + days "27-28", "March" + "17-18*" (the
 * asterisk marks projections), "Apr/May" + "30-1" (a meeting across two months). Parenthesised entries
 * ("22 (notation vote)", "(unscheduled)") are skipped: they are only announced when they happen. Throws on
 * anything it cannot read, so a page redesign fails the capture instead of silently storing fewer meetings.
 */
export function parseFomcRateDecisionDates(html: string): string[] {
  const headings = [...html.matchAll(/(\d{4}) FOMC Meetings/g)].map((match) => ({ year: Number(match[1]), start: match.index! }));
  if (headings.length === 0) throw new Error("FOMC calendar: no \"YYYY FOMC Meetings\" sections found");
  const sorted = [...headings].sort((a, b) => a.start - b.start);
  const decisionDates: string[] = [];
  for (const [index, heading] of sorted.entries()) {
    const section = html.slice(heading.start, sorted[index + 1]?.start ?? html.length);
    const meetings = [...section.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]*)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]*)</g)];
    if (meetings.length === 0) throw new Error(`FOMC calendar: no meetings found in the ${heading.year} section`);
    for (const meeting of meetings) {
      const monthText = meeting[1]!.trim();
      const daysText = meeting[2]!.trim();
      if (daysText.includes("(") || monthText.includes("(")) continue;
      const days = daysText.replace(/\*/g, "").trim().match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
      if (!days) throw new Error(`FOMC calendar: unreadable meeting days "${daysText}" (${monthText} ${heading.year})`);
      const months = monthText.split("/");
      const firstMonth = monthNumber(months[0]!);
      const decisionMonth = monthNumber(months[months.length - 1]!);
      const decisionYear = decisionMonth < firstMonth ? heading.year + 1 : heading.year;
      decisionDates.push(isoDate(decisionYear, decisionMonth, Number(days[2] ?? days[1])));
    }
  }
  return [...new Set(decisionDates)].sort();
}

export const presidentialElectionTitle = "US presidential election";
export const midtermElectionsTitle = "US midterm elections";

/** US federal election days (Tuesday after the first Monday in November, even years) from `fromYear` to `toYear`. */
export function generateUsFederalElectionDays(fromYear: number, toYear: number): { dateIso: string; title: string }[] {
  const elections: { dateIso: string; title: string }[] = [];
  for (let year = fromYear + (fromYear % 2); year <= toYear; year += 2) {
    const novemberFirstWeekday = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0 = Sunday
    const firstMonday = 1 + ((1 - novemberFirstWeekday + 7) % 7);
    elections.push({ dateIso: isoDate(year, 11, firstMonday + 1), title: year % 4 === 0 ? presidentialElectionTitle : midtermElectionsTitle });
  }
  return elections;
}

/** The last day a source's schedule is known through: Dec 31 of the latest year it returned dates for (sources publish a year at a time). */
export function scheduleKnownThroughIso(dateIsos: string[]): string | null {
  if (dateIsos.length === 0) return null;
  const latestYear = Math.max(...dateIsos.map((date) => Number(date.slice(0, 4))));
  return `${latestYear}-12-31`;
}
