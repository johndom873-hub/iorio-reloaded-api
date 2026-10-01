import { db } from "../db/connection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { evaluateDataInvariants, loadDataInvariantInputs, type InvariantResult } from "./dataInvariants.js";
import { expectedScheduledJobs, evaluateJobDeadlines, evaluatePendingJobs, runFallsInSlot, type JobRunSummary } from "./jobDeadlines.js";
import { easternDateIso, easternInstant, resolveIsOpenDay } from "./marketSessionStatus.js";
import { readGitSha } from "./readGitSha.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { reportBackgroundFailure } from "./backgroundFailureAlert.js";
import { clearUndeliveredAlerts, loadUndeliveredAlerts, notifyTelegramTracked } from "./undeliveredAlerts.js";
import { opsMonitorProcessName } from "./opsMonitorLiveness.js";
import { notifyDownThrottled } from "./throttledAlert.js";

// Runs inside the web dyno on a timer, so it does not depend on Heroku Scheduler (the thing it
// watches). Every minute it (1) writes a heartbeat that the 10-minute ibkr_health_check verifies
// (opsMonitorLiveness.ts), (2) alerts on scheduled jobs past their start deadline or stuck
// (jobDeadlines.ts), and (3) sends the morning digest once per open day at 10:45 ET: every job's
// last status, every data invariant (dataInvariants.ts) and any alert Telegram failed to deliver.

const tickIntervalMs = 60_000;
const deadlineReminderIntervalMs = 6 * 60 * 60_000;
const monitorErrorReminderIntervalMs = 60 * 60_000;
// 45 minutes after the capture chain starts (10:00 ET), so it has finished; kept in step with chainCaptureSlotEastern.
const digestTime = { hour: 10, minute: 45 };
const digestLatestTime = { hour: 16, minute: 0 };
const runHistoryWindowMs = 36 * 60 * 60_000;
const oldAlertStateRetentionMs = 3 * 24 * 60 * 60_000;
const digestRetryPauseMs = 5 * 60_000;
const maxUndeliveredListed = 10;
const telegramMessageLimit = 4096;
let digestRetryNotBefore = 0;

export interface DigestJobLine {
  jobName: string;
  lastStartedAt: Date | null;
  status: "running" | "success" | "failure" | null;
  errorMessage: string | null;
}

/** Pure: the morning digest text. */
export function buildMorningDigest(input: {
  dateIso: string;
  jobs: DigestJobLine[];
  invariants: InvariantResult[];
  undelivered: { alertedAt: Date; message: string }[];
  /** Overdue or stuck jobs still open, from evaluateJobDeadlines. */
  deadlineProblems: string[];
  /** Jobs whose slot today has begun but that have not started yet (deadline not passed): shown as pending, not as yesterday's green line. */
  pendingJobs?: string[];
}): string {
  const pendingJobs = input.pendingJobs ?? [];
  const jobProblems = input.jobs.filter((job) => job.status !== "success");
  const invariantProblems = input.invariants.filter((invariant) => !invariant.ok);
  const problemCount = jobProblems.length + invariantProblems.length + input.undelivered.length + input.deadlineProblems.length;
  const header =
    problemCount > 0
      ? `⚠️ Iorio morning check ${input.dateIso}: ${problemCount} problem(s)`
      : pendingJobs.length > 0
        ? `✅ Iorio morning check ${input.dateIso}: nothing wrong so far, still to run today: ${pendingJobs.join(", ")}`
        : `✅ Iorio morning check ${input.dateIso}: all clear (${input.jobs.length} jobs, ${input.invariants.length} data checks)`;

  const formatStartedAt = (instant: Date): string => instant.toISOString().slice(5, 16).replace("T", " ");
  const jobLines = input.jobs.map((job) => {
    if (pendingJobs.includes(job.jobName)) return `⏳ ${job.jobName}: not run yet today${job.lastStartedAt ? ` (last run ${formatStartedAt(job.lastStartedAt)} UTC)` : ""}`;
    if (job.status === null || job.lastStartedAt === null) return `❌ ${job.jobName}: never run`;
    const when = `${formatStartedAt(job.lastStartedAt)} UTC`;
    if (job.status === "success") return `✅ ${job.jobName}: ${when}`;
    if (job.status === "running") return `⏳ ${job.jobName}: still running (started ${when})`;
    return `❌ ${job.jobName}: failed ${when}${job.errorMessage ? ` — ${job.errorMessage.split("\n")[0]!.slice(0, 160)}` : ""}`;
  });
  const invariantLines = input.invariants.map((invariant) => `${invariant.ok ? "✅" : "❌"} ${invariant.name}: ${invariant.detail}`);
  const sections = [header];
  if (input.deadlineProblems.length > 0) sections.push(`Overdue or stuck\n${input.deadlineProblems.join("\n")}`);
  sections.push(`Jobs (last run)\n${jobLines.join("\n")}`, `Data checks\n${invariantLines.join("\n")}`);
  if (input.undelivered.length > 0) {
    sections.push(`Alerts Telegram could not deliver\n${input.undelivered.map((alert) => `• ${formatStartedAt(alert.alertedAt)} UTC — ${alert.message.split("\n")[0]!.slice(0, 200)}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

async function loadRecentRuns(now: Date): Promise<JobRunSummary[]> {
  const rows: { job_name: string; started_at: Date; status: JobRunSummary["status"] }[] = await db("job_runs")
    .where("started_at", ">=", new Date(now.getTime() - runHistoryWindowMs))
    .select("job_name", "started_at", "status");
  return rows.map((row) => ({ jobName: row.job_name, startedAt: new Date(row.started_at), status: row.status }));
}

async function findDeadlineProblems(now: Date) {
  const runs = await loadRecentRuns(now);
  const openByDate = new Map<string, boolean>();
  for (const dateIso of new Set([now.toISOString().slice(0, 10), easternDateIso(now)])) openByDate.set(dateIso, await resolveIsOpenDay(dateIso));
  return { runs, problems: evaluateJobDeadlines({ now, runs, isOpenDay: (dateIso) => openByDate.get(dateIso) ?? true, easternDateIsoOf: easternDateIso }) };
}

/** Alerts (once, then every few hours) on jobs past their deadline; announces when one later catches up. */
export async function reportJobDeadlines(now: Date = new Date()): Promise<void> {
  const { runs, problems } = await findDeadlineProblems(now);
  for (const problem of problems) await notifyDownThrottled(problem.alertKey, problem.message, deadlineReminderIntervalMs);

  const activeKeys = new Set(problems.map((problem) => problem.alertKey));
  const alertedRows: { alert_key: string; first_alerted_at: Date }[] = await db("alert_state").where("alert_key", "like", "deadline:%").select("alert_key", "first_alerted_at");
  for (const row of alertedRows) {
    if (activeKeys.has(row.alert_key)) continue;
    const [, jobName = "", ...rest] = row.alert_key.split(":");
    const firstAlertedAt = new Date(row.first_alerted_at);
    const slotDateIso = rest[0] && /^\d{4}-\d{2}-\d{2}$/.test(rest[0]) ? rest[0] : null;
    const stuckRunStartedAt = rest[0] === "stuck" ? rest.slice(1).join(":") : null;
    const job = expectedScheduledJobs.find((candidate) => candidate.jobName === jobName);
    // A "did not start for DATE" alert is only resolved by a run inside THAT date's slot: the next day's
    // normal run must not be announced as the missed one catching up.
    const caughtUp =
      stuckRunStartedAt !== null
        ? runs.some((run) => run.jobName === jobName && run.startedAt.toISOString() === stuckRunStartedAt && run.status !== "running")
        : slotDateIso !== null && job
          ? runs.some((run) => run.jobName === jobName && runFallsInSlot(job, slotDateIso, run.startedAt))
          : runs.some((run) => run.jobName === jobName && run.startedAt > firstAlertedAt);
    if (!caughtUp && now.getTime() - firstAlertedAt.getTime() < oldAlertStateRetentionMs) continue;
    // Two web dynos can both reach this row: only the one whose delete actually removed it announces.
    const removed = await db("alert_state").where({ alert_key: row.alert_key }).del();
    if (caughtUp && removed > 0) await notifyTelegramTracked(`✅ ${jobName} has now run (its deadline alert is cleared).`);
  }
}

/** Sends the morning digest once per open day between 10:45 and 16:00 ET. Returns whether it sent. */
export async function sendMorningDigestIfDue(now: Date = new Date()): Promise<boolean> {
  if (now.getTime() < digestRetryNotBefore) return false;
  const dateIso = easternDateIso(now);
  if (now < easternInstant(dateIso, digestTime.hour, digestTime.minute) || now >= easternInstant(dateIso, digestLatestTime.hour, digestLatestTime.minute)) return false;
  if (!(await resolveIsOpenDay(dateIso))) return false;

  const digestKey = `digest:${dateIso}`;
  const claimed = await db("alert_state").insert({ alert_key: digestKey, first_alerted_at: db.fn.now(), last_alerted_at: db.fn.now(), last_message: "morning digest" }).onConflict("alert_key").ignore().returning("alert_key");
  if (claimed.length === 0) return false;

  let clearableUndeliveredKeys: string[] = [];
  try {
    const [inputs, latestRuns, allUndelivered, deadlines] = await Promise.all([loadDataInvariantInputs(now, dateIso), loadLatestRunPerExpectedJob(), loadUndeliveredAlerts(), findDeadlineProblems(now)]);
    // List (and later clear) at most this many: the digest is cut at Telegram's 4096-character limit, and an alert that was
    // cut off must not be cleared as if it had been shown. The rest are listed by the next digest.
    const undelivered = allUndelivered.slice(0, maxUndeliveredListed);
    const openDays = new Map<string, boolean>();
    for (const day of new Set([now.toISOString().slice(0, 10), dateIso])) openDays.set(day, await resolveIsOpenDay(day));
    const pendingJobs = evaluatePendingJobs({ now, runs: deadlines.runs, isOpenDay: (day) => openDays.get(day) ?? true, easternDateIsoOf: easternDateIso });
    const digest = buildMorningDigest({ dateIso, jobs: latestRuns, invariants: evaluateDataInvariants(inputs), undelivered, deadlineProblems: deadlines.problems.map((problem) => problem.message), pendingJobs });
    // Plain send: the earlier undelivered alerts are only cleared once the digest that lists them was really delivered.
    const delivered = await notifyTelegram(digest);
    if (!delivered) {
      // Release the claim so the digest is retried, after a pause so a Telegram outage does not re-run the queries every minute.
      await db("alert_state").where({ alert_key: digestKey }).del();
      digestRetryNotBefore = now.getTime() + digestRetryPauseMs;
      return false;
    }
    // Only alerts that were really shown: a digest cut off at Telegram's length limit keeps them for tomorrow.
    if (digest.length <= telegramMessageLimit) clearableUndeliveredKeys = undelivered.map((alert) => alert.alertKey);
  } catch (error) {
    // Release the claim so the next tick retries instead of losing the day's digest.
    await db("alert_state").where({ alert_key: digestKey }).del();
    throw error;
  }
  // Outside the try on purpose: a failure clearing rows after a SUCCESSFUL send must not release the claim (that would
  // send the digest twice) or mask anything; the rows simply appear again in tomorrow's digest.
  if (clearableUndeliveredKeys.length > 0) {
    await clearUndeliveredAlerts(clearableUndeliveredKeys).catch((error) => console.error(`Could not clear delivered undelivered-alert rows: ${error instanceof Error ? error.message : error}`));
  }
  return true;
}

async function loadLatestRunPerExpectedJob(): Promise<DigestJobLine[]> {
  const jobNames = expectedScheduledJobs.map((job) => job.jobName);
  const rows: { job_name: string; started_at: Date; status: DigestJobLine["status"]; error_message: string | null }[] = await db("job_runs")
    .whereIn("job_name", jobNames)
    .distinctOn("job_name")
    .orderBy([{ column: "job_name" }, { column: "started_at", order: "desc" }])
    .select("job_name", "started_at", "status", "error_message");
  const byJobName = new Map(rows.map((row) => [row.job_name, row]));
  return jobNames.map((jobName) => {
    const row = byJobName.get(jobName);
    return { jobName, lastStartedAt: row ? new Date(row.started_at) : null, status: row?.status ?? null, errorMessage: row?.error_message ?? null };
  });
}

async function writeHeartbeat(startedAtMs: number, tickNumber: number): Promise<void> {
  await db("worker_health")
    .insert({
      process_name: opsMonitorProcessName,
      connected: true,
      uptime_ms: Date.now() - startedAtMs,
      total_reconnects: tickNumber,
      git_sha: readGitSha(),
      app_environment: readAppEnvironment(),
      updated_at: db.fn.now(),
    })
    .onConflict("process_name")
    .merge();
}

async function pruneOldAlertState(now: Date): Promise<void> {
  await db("alert_state").where("alert_key", "like", "digest:%").andWhere("first_alerted_at", "<", new Date(now.getTime() - oldAlertStateRetentionMs)).del();
}

export function startOpsMonitor(): void {
  const startedAtMs = Date.now();
  let tickNumber = 0;
  let tickInProgress = false;

  async function tick(): Promise<void> {
    if (tickInProgress) return;
    tickInProgress = true;
    tickNumber++;
    const now = new Date();
    try {
      await writeHeartbeat(startedAtMs, tickNumber);
      await reportJobDeadlines(now);
      await sendMorningDigestIfDue(now);
      if (tickNumber % 60 === 0) await pruneOldAlertState(now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ops monitor: tick failed — ${message}`);
      // The monitor failing must itself be loud; reportBackgroundFailure limits it to one alert per hour and
      // still sends when the database (the usual cause) is the thing that is down.
      reportBackgroundFailure("ops-monitor:tick", `The ops monitor (job deadlines and morning digest) hit an error: ${message.split("\n")[0]}`);
    } finally {
      tickInProgress = false;
    }
  }

  const timer = setInterval(() => void tick(), tickIntervalMs);
  timer.unref?.();
  void tick();
  console.log(`Ops monitor started (job deadlines every ${tickIntervalMs / 1000}s, morning digest ${digestTime.hour}:${String(digestTime.minute).padStart(2, "0")} ET).`);
}
