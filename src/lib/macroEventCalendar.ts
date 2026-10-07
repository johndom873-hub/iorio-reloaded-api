import { db } from "../db/connection.js";
import { easternInstant, easternIsoDate } from "./easternIsoDate.js";
import { addCalendarDays } from "./signalsRoadmap.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
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
  scheduleKnownThroughIso,
  type MajorMacroEventKey,
  type MajorMacroEventSource,
} from "./majorMacroEventSources.js";

// Major US macro events (decided by Marcelo): the Fed rate decision, CPI, GDP and US federal elections, nothing
// else. They feed the Signals "macro_event_before_expiry" flag (a flag, never an exclusion), Pluto's per-ticker
// macro_events, the Calendar page and the order-review warning. Sources: majorMacroEventSources.ts.

/** How far ahead events are stored. */
export const majorMacroEventLookaheadDays = 90;
/** The longest expiry Signals and Pluto accept: a source whose schedule ends sooner than this raises an alert. */
export const majorMacroEventMinimumHorizonDays = 45;
const horizonAlertKey = "major_macro_events_horizon";
const horizonAlertReminderIntervalMs = 24 * 60 * 60 * 1000;

export interface MacroEvent {
  dateIso: string; // YYYY-MM-DD (Eastern date of the release)
  eventAtIso: string; // UTC ISO of event_at, the release time
  title: string;
}

/** Major US events from today (Eastern) forward, in time order. */
export async function loadUpcomingMajorMacroEvents(): Promise<MacroEvent[]> {
  return db("major_macro_events")
    .whereRaw("(event_at AT TIME ZONE 'America/New_York')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date")
    .orderBy("event_at", "asc")
    .select(db.raw(`(event_at AT TIME ZONE 'America/New_York')::date::text AS "dateIso"`), db.raw(`to_char(event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "eventAtIso"`), "title");
}

export interface MajorMacroEventToStore {
  title: string;
  eventAt: Date;
}

/**
 * Replaces every stored row of `eventKey` with `events` that fall from today (Eastern) to now + the lookahead, in one
 * transaction: a date the source moved (a release postponed, a tentative FOMC date changed) disappears instead of
 * lingering, and past rows are dropped. Called only with a successful fetch, so a failing source keeps its rows.
 */
export async function replaceMajorMacroEvents(eventKey: MajorMacroEventKey, source: MajorMacroEventSource, events: MajorMacroEventToStore[], now: Date = new Date()): Promise<number> {
  const todayEastern = easternIsoDate(now);
  const lookaheadEnd = now.getTime() + majorMacroEventLookaheadDays * 24 * 60 * 60 * 1000;
  const rows = events
    .filter((event) => easternIsoDate(event.eventAt) >= todayEastern && event.eventAt.getTime() <= lookaheadEnd)
    .map((event) => ({ event_key: eventKey, title: event.title, event_at: event.eventAt, source }));
  await db.transaction(async (transaction) => {
    await transaction("major_macro_events").where({ event_key: eventKey }).del();
    if (rows.length > 0) await transaction("major_macro_events").insert(rows);
  });
  return rows.length;
}

export interface MajorMacroEventCaptureFailure {
  source: string;
  message: string;
}

export interface MajorMacroEventCaptureResult {
  writtenBySource: Record<string, number>;
  failures: MajorMacroEventCaptureFailure[];
  /** Sources whose published schedule ends less than majorMacroEventMinimumHorizonDays ahead. */
  horizonShortfalls: string[];
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Fetches every source in parallel and replaces each one's rows; a failing source is reported and keeps its rows. */
export async function captureMajorMacroEvents(now: Date = new Date()): Promise<MajorMacroEventCaptureResult> {
  const todayEastern = easternIsoDate(now);
  const horizonRequiredThroughIso = addCalendarDays(todayEastern, majorMacroEventMinimumHorizonDays);
  const writtenBySource: Record<string, number> = {};
  const failures: MajorMacroEventCaptureFailure[] = [];
  const horizonShortfalls: string[] = [];

  const scheduledSources = [
    ...fredMajorReleases.map((release) => ({
      name: `${release.title} (FRED)`,
      eventKey: release.eventKey,
      source: "fred" as const,
      fetchDates: () => fetchFredReleaseDates(release.releaseId, todayEastern),
      toEvent: (dateIso: string) => ({ title: release.title, eventAt: easternInstant(dateIso, dataReleaseEasternTime.hour, dataReleaseEasternTime.minute) }),
    })),
    {
      name: `${fedRateDecisionTitle} (Federal Reserve)`,
      eventKey: "fed_rate_decision" as const,
      source: "federal_reserve" as const,
      fetchDates: async () => parseFomcRateDecisionDates(await fetchFomcCalendarPage()),
      toEvent: (dateIso: string) => ({ title: fedRateDecisionTitle, eventAt: easternInstant(dateIso, fedRateDecisionEasternTime.hour, fedRateDecisionEasternTime.minute) }),
    },
  ];

  await Promise.all(
    scheduledSources.map(async (scheduled) => {
      try {
        const dates = await scheduled.fetchDates();
        const futureDates = dates.filter((date) => date >= todayEastern);
        writtenBySource[scheduled.name] = await replaceMajorMacroEvents(scheduled.eventKey, scheduled.source, futureDates.map(scheduled.toEvent), now);
        // No future dates at all (late December before next year is published) is a short schedule, not a failed fetch.
        const knownThroughIso = scheduleKnownThroughIso(futureDates);
        if (knownThroughIso === null || knownThroughIso < horizonRequiredThroughIso) horizonShortfalls.push(scheduled.name);
      } catch (error) {
        console.error(`daily_calendar_capture: ${scheduled.name} failed`, error);
        failures.push({ source: scheduled.name, message: describeError(error) });
      }
    }),
  );

  const currentYear = Number(todayEastern.slice(0, 4));
  const elections = generateUsFederalElectionDays(currentYear, currentYear + 1).map((election) => ({
    title: election.title,
    eventAt: easternInstant(election.dateIso, federalElectionEasternTime.hour, federalElectionEasternTime.minute),
  }));
  writtenBySource["US federal elections (rule)"] = await replaceMajorMacroEvents("us_federal_election", "election_rule", elections, now);

  return { writtenBySource, failures, horizonShortfalls: horizonShortfalls.sort() };
}

/** Text constant per set of sources (notifyDownThrottled re-sends on any text change). */
export function buildMajorMacroEventHorizonMessage(horizonShortfalls: string[]): string {
  return (
    `⚠️ Major macro events: the published schedule of ${horizonShortfalls.join(", ")} ends less than ${majorMacroEventMinimumHorizonDays} days ahead, ` +
    `so the Signals macro flag and Pluto can miss a release on a longer expiry. It clears once next year's dates are published; check FRED or the Fed's FOMC calendar if it lasts.`
  );
}

/**
 * Alerts (reminding daily) while any source's schedule is too short; announces once when it is long enough again.
 * A run with a failed source never clears the alert: that source's schedule was not checked (the failure alerts on its own).
 */
export async function reportMajorMacroEventHorizon(result: Pick<MajorMacroEventCaptureResult, "horizonShortfalls" | "failures">): Promise<void> {
  if (result.horizonShortfalls.length > 0) {
    await notifyDownThrottled(horizonAlertKey, buildMajorMacroEventHorizonMessage(result.horizonShortfalls), horizonAlertReminderIntervalMs);
    return;
  }
  if (result.failures.length > 0) return;
  const shortForMs = await clearDownState(horizonAlertKey);
  if (shortForMs !== null) await notifyTelegramTracked(`✅ Major macro events: every schedule reaches ${majorMacroEventMinimumHorizonDays} days ahead again (was short ~${formatDurationHuman(shortForMs)}).`);
}
