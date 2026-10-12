import { easternIsoDate, easternMinutesOfDay } from "../../lib/easternIsoDate.js";
import type { BacktestJobDisplayStatus, BacktestJobStatus } from "../backtestTypes.js";

// The background-job rules of docs/backtesting/DATA-FILES.md. Pure.

/** A running job whose heartbeat is older than this shows as stopped. */
export const staleHeartbeatMilliseconds = 60_000;
/** How often a job process writes its heartbeat and reads cancel_requested (the docs ask for at least every 10 s). */
export const jobHeartbeatIntervalMilliseconds = 5_000;
/** Finished jobs stay on the overview this many days. */
export const finishedJobListingDays = 7;
export const defaultDownloadStartDate = "2020-01-01";
/** Today's session counts as finished from 18:00 ET: ThetaData builds the end-of-day data around 17:15 ET. */
const sessionFinishedEasternMinutes = 18 * 60;

export function isRunningJobStale(heartbeatAt: Date | null, now: Date): boolean {
  return heartbeatAt === null || now.getTime() - heartbeatAt.getTime() > staleHeartbeatMilliseconds;
}

export function deriveJobDisplayStatus(status: BacktestJobStatus, heartbeatAt: Date | null, now: Date): BacktestJobDisplayStatus {
  return status === "running" && isRunningJobStale(heartbeatAt, now) ? "stopped" : status;
}

export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isWeekendDate(dateIso: string): boolean {
  const weekday = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function addCalendarDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Weekdays from `fromIso` to `toIso`, both included (holidays not excluded). */
export function weekdaysBetweenInclusive(fromIso: string, toIso: string): number {
  let weekdays = 0;
  for (let day = fromIso; day <= toIso; day = addCalendarDays(day, 1)) {
    if (!isWeekendDate(day)) weekdays += 1;
  }
  return weekdays;
}

/** The last finished session: today after 18:00 ET on a weekday, otherwise the last weekday before today. */
export function lastFinishedBacktestSessionDate(now: Date): string {
  const today = easternIsoDate(now);
  if (!isWeekendDate(today) && easternMinutesOfDay(now) >= sessionFinishedEasternMinutes) return today;
  let day = addCalendarDays(today, -1);
  while (isWeekendDate(day)) day = addCalendarDays(day, -1);
  return day;
}

/** "2024-03-15 · 1,201 of 1,700 days"; without a date while nothing new is saved yet. */
export function formatDownloadProgressLabel(lastDate: string | null, daysDone: number, daysTotal: number): string {
  const counts = `${daysDone.toLocaleString("en-US")} of ${daysTotal.toLocaleString("en-US")} days`;
  return lastDate ? `${lastDate} · ${counts}` : counts;
}

export interface ProgressSample {
  atMilliseconds: number;
  done: number;
}

/** Seconds left at the pace between the first and last sample; null until two samples show progress. */
export function estimateSecondsLeft(samples: readonly ProgressSample[], done: number, total: number): number | null {
  if (total <= 0 || done >= total || samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsedSeconds = (last.atMilliseconds - first.atMilliseconds) / 1000;
  const progressed = last.done - first.done;
  if (!(elapsedSeconds > 0) || !(progressed > 0)) return null;
  return Math.round(((total - done) * elapsedSeconds) / progressed);
}

/** How far back the recent pace looks. */
export const recentPaceWindowMilliseconds = 10 * 60_000;

/**
 * Adds one observation to a job's samples and keeps the recent window: a repeat of the newest observation is ignored,
 * and progress that went backwards (a backtest re-run) starts the samples over.
 */
export function appendProgressSample(samples: readonly ProgressSample[], sample: ProgressSample): ProgressSample[] {
  const newest = samples[samples.length - 1];
  if (newest && newest.atMilliseconds === sample.atMilliseconds) return [...samples];
  if (newest && sample.done < newest.done) return [sample];
  return [...samples, sample].filter((entry) => sample.atMilliseconds - entry.atMilliseconds <= recentPaceWindowMilliseconds);
}
