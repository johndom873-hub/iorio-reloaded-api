import { easternInstant } from "./marketSessionStatus.js";

// Deadline monitor (opsMonitor.ts): every scheduled job must have STARTED by a fixed time.
// runJob already alerts when a run fails, but a run that never starts (Heroku Scheduler
// misfire, an entry missing in the dashboard, a clock-guard skip, a crash before the job row
// exists) leaves nothing to alert on. The old watchdog noticed at 11:30 PM UTC; this notices
// minutes after the slot.
//
// Times are the Heroku Scheduler slots from PROGRESS.md's "Scheduled jobs" list; the option-chain
// chain is judged in Eastern time because its two UTC entries (14:00/15:00) exist only to land on
// 10:00 ET. `startByGraceMinutes` covers Scheduler start delay plus dyno boot; `maxRunMinutes` is
// about twice the slowest run seen in job_runs history.

export interface ExpectedJob {
  jobName: string;
  zone: "utc" | "eastern";
  hour: number;
  minute: number;
  startByGraceMinutes: number;
  maxRunMinutes: number;
  /** Skipped on days market_calendar marks closed (the job's own script has that guard). */
  marketDaysOnly: boolean;
}

/**
 * When the option-chain capture chain starts, in Eastern time. Must equal the window start in
 * optionChainCaptureClock.ts: jobDeadlines.test.ts fails if the two drift apart.
 */
export const chainCaptureSlotEastern = { hour: 10, minute: 0 };

export const expectedScheduledJobs: ExpectedJob[] = [
  { jobName: "option_chain_structure_refresh", zone: "utc", hour: 9, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 30, marketDaysOnly: true },
  // Runs first inside the same Scheduler entry (run-option-chain-structure-job), so it shares its start time.
  { jobName: "session_close_read", zone: "utc", hour: 9, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 5, marketDaysOnly: true },
  { jobName: "option_chain_capture", zone: "eastern", hour: 10, minute: 0, startByGraceMinutes: 35, maxRunMinutes: 45, marketDaysOnly: true },
  { jobName: "option_surface_fit", zone: "eastern", hour: 10, minute: 0, startByGraceMinutes: 60, maxRunMinutes: 15, marketDaysOnly: true },
  { jobName: "day_signals_seed", zone: "eastern", hour: 10, minute: 0, startByGraceMinutes: 60, maxRunMinutes: 15, marketDaysOnly: true },
  { jobName: "market_calendar_sync", zone: "utc", hour: 19, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 15, marketDaysOnly: false },
  { jobName: "daily_screener_scan", zone: "utc", hour: 18, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 30, marketDaysOnly: true },
  { jobName: "daily_calendar_capture", zone: "utc", hour: 20, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 15, marketDaysOnly: false },
  { jobName: "daily_market_data_capture", zone: "utc", hour: 22, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 60, marketDaysOnly: true },
  { jobName: "daily_pnl_snapshot", zone: "utc", hour: 22, minute: 30, startByGraceMinutes: 10, maxRunMinutes: 30, marketDaysOnly: true },
  { jobName: "expiry_settlement_audit", zone: "utc", hour: 23, minute: 0, startByGraceMinutes: 10, maxRunMinutes: 15, marketDaysOnly: false },
];

// ibkr_health_check runs every 10 minutes all day; two missed slots is an outage of the check itself.
const healthCheckJobName = "ibkr_health_check";
export const healthCheckMaxSilenceMinutes = 25;
const scheduledStartEarlyToleranceMinutes = 30;

/** True when a run started inside the given date's slot window (used to tell a real catch-up from the NEXT day's normal run). */
export function runFallsInSlot(job: ExpectedJob, dateIso: string, startedAt: Date): boolean {
  const slotStart = new Date(scheduledInstant(job, dateIso).getTime() - scheduledStartEarlyToleranceMinutes * 60_000);
  const nextDate = new Date(`${dateIso}T12:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextSlotStart = new Date(scheduledInstant(job, nextDate.toISOString().slice(0, 10)).getTime() - scheduledStartEarlyToleranceMinutes * 60_000);
  return startedAt >= slotStart && startedAt < nextSlotStart;
}

export interface JobRunSummary {
  jobName: string;
  startedAt: Date;
  status: "running" | "success" | "failure";
}

export interface DeadlineProblem {
  /** Stable per problem, so throttledAlert alerts once and the recovery message can find it. */
  alertKey: string;
  message: string;
}

/** The calendar date the job's slot belongs to, in the zone its schedule is written in. */
export function slotDateIso(job: ExpectedJob, now: Date, easternDateIsoOf: (instant: Date) => string): string {
  return job.zone === "eastern" ? easternDateIsoOf(now) : now.toISOString().slice(0, 10);
}

export function scheduledInstant(job: ExpectedJob, dateIso: string): Date {
  if (job.zone === "eastern") return easternInstant(dateIso, job.hour, job.minute);
  return new Date(`${dateIso}T${String(job.hour).padStart(2, "0")}:${String(job.minute).padStart(2, "0")}:00Z`);
}

/**
 * Pure: every job that is past its start deadline today with no run, or stuck in "running".
 * `isOpenDay` answers for the slot's own date (a UTC slot and an Eastern slot can differ near midnight).
 */
export function evaluateJobDeadlines(input: {
  now: Date;
  runs: JobRunSummary[];
  isOpenDay: (dateIso: string) => boolean;
  easternDateIsoOf: (instant: Date) => string;
}): DeadlineProblem[] {
  const problems: DeadlineProblem[] = [];
  for (const job of expectedScheduledJobs) {
    const dateIso = slotDateIso(job, input.now, input.easternDateIsoOf);
    if (job.marketDaysOnly && !input.isOpenDay(dateIso)) continue;
    const scheduledAt = scheduledInstant(job, dateIso);
    const startByAt = new Date(scheduledAt.getTime() + job.startByGraceMinutes * 60_000);
    const countedSince = new Date(scheduledAt.getTime() - scheduledStartEarlyToleranceMinutes * 60_000);
    const jobRuns = input.runs.filter((run) => run.jobName === job.jobName && run.startedAt >= countedSince);

    if (input.now >= startByAt && jobRuns.length === 0) {
      problems.push({
        alertKey: `deadline:${job.jobName}:${dateIso}`,
        message: `⏰ ${job.jobName} has not started for ${dateIso} (was due ${scheduledAt.toISOString().slice(11, 16)} UTC, deadline passed at ${startByAt.toISOString().slice(11, 16)} UTC). Check the Heroku Scheduler entry and the job's clock guard.`,
      });
    }
  }

  // Stuck runs are judged over every recent run, not just today's slot: a run stuck since 22:00 UTC must keep
  // alerting after UTC midnight, when it is no longer inside "today's" window.
  for (const job of expectedScheduledJobs) {
    for (const run of input.runs.filter((candidate) => candidate.jobName === job.jobName)) {
      const runningMinutes = (input.now.getTime() - run.startedAt.getTime()) / 60_000;
      if (run.status === "running" && runningMinutes > job.maxRunMinutes) {
        problems.push({
          alertKey: `deadline:${job.jobName}:stuck:${run.startedAt.toISOString()}`,
          // No live counter in the text: throttledAlert resends whenever the message changes, so a ticking number would page every minute.
          message: `⏰ ${job.jobName} has been "running" for over ${job.maxRunMinutes} min (started ${run.startedAt.toISOString()}). The process may have been killed.`,
        });
      }
    }
  }

  const latestHealthCheck = input.runs.filter((run) => run.jobName === healthCheckJobName).reduce<Date | null>((latest, run) => (latest === null || run.startedAt > latest ? run.startedAt : latest), null);
  const silentMinutes = latestHealthCheck === null ? Infinity : (input.now.getTime() - latestHealthCheck.getTime()) / 60_000;
  if (silentMinutes > healthCheckMaxSilenceMinutes) {
    problems.push({
      alertKey: `deadline:${healthCheckJobName}`,
      message: latestHealthCheck === null ? `⏰ ${healthCheckJobName} has no recorded run at all.` : `⏰ ${healthCheckJobName} has not run for over ${healthCheckMaxSilenceMinutes} min (it runs every 10). Check the Heroku Scheduler entry.`,
    });
  }
  return problems;
}

/**
 * Jobs whose slot today has begun, that have not started yet, and whose deadline has not passed: normal "still to come" state.
 * The morning digest lists them instead of showing yesterday's run as a green line and saying "all clear".
 */
export function evaluatePendingJobs(input: {
  now: Date;
  runs: JobRunSummary[];
  isOpenDay: (dateIso: string) => boolean;
  easternDateIsoOf: (instant: Date) => string;
}): string[] {
  const pending: string[] = [];
  for (const job of expectedScheduledJobs) {
    const dateIso = slotDateIso(job, input.now, input.easternDateIsoOf);
    if (job.marketDaysOnly && !input.isOpenDay(dateIso)) continue;
    const scheduledAt = scheduledInstant(job, dateIso);
    const startByAt = new Date(scheduledAt.getTime() + job.startByGraceMinutes * 60_000);
    const countedSince = new Date(scheduledAt.getTime() - scheduledStartEarlyToleranceMinutes * 60_000);
    const started = input.runs.some((run) => run.jobName === job.jobName && run.startedAt >= countedSince);
    if (input.now >= scheduledAt && input.now < startByAt && !started) pending.push(job.jobName);
  }
  return pending;
}
