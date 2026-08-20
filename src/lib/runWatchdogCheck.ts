import { db } from "../db/connection.js";
import { runJob } from "./runJob.js";

const DAILY_JOB_NAMES = ["daily_market_data_capture", "daily_pnl_snapshot", "trade_alert_generation"] as const;
const IBKR_HEALTH_CHECK_JOB_NAME = "ibkr_health_check";
const IBKR_HEALTH_CHECK_WINDOW_MS = 2 * 60 * 60 * 1000;
const STUCK_RUNNING_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Scheduled job #5 (see PROGRESS.md's Scheduled jobs plan): a pure
 * liveness check, since "no failure alerts" isn't proof of health when
 * jobs only alert on their own failure — this catches the case a job's
 * own error handling can't reach at all: Heroku Scheduler misfiring, or
 * the whole VPS/Gateway being down before a job even starts.
 *
 * Deliberately never throws on a missing/stuck job — that would just
 * produce a generic "watchdog failed" alert via runJob()'s catch path.
 * Instead this always succeeds and uses result.notify to report exactly
 * which check(s) failed, so the Telegram alert is actionable.
 */
export async function runWatchdogCheck(): Promise<void> {
  await runJob("watchdog", async () => {
    const now = new Date();
    const todayUtcMidnight = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z");

    const problems: string[] = [];

    const dailyJobRuns = await db("job_runs")
      .select("job_name")
      .whereIn("job_name", DAILY_JOB_NAMES)
      .where("started_at", ">=", todayUtcMidnight)
      .groupBy("job_name");
    const jobNamesThatRanToday = new Set(dailyJobRuns.map((row) => row.job_name as string));
    for (const jobName of DAILY_JOB_NAMES) {
      if (!jobNamesThatRanToday.has(jobName)) {
        problems.push(`${jobName} has not run today`);
      }
    }

    const recentHealthCheck = await db("job_runs")
      .where("job_name", IBKR_HEALTH_CHECK_JOB_NAME)
      .where("started_at", ">=", new Date(now.getTime() - IBKR_HEALTH_CHECK_WINDOW_MS))
      .first();
    if (!recentHealthCheck) {
      problems.push(`${IBKR_HEALTH_CHECK_JOB_NAME} has not run in the last 2 hours`);
    }

    const stuckRunningJobs = await db("job_runs")
      .select("job_name", "started_at")
      .where("status", "running")
      .where("started_at", "<", new Date(now.getTime() - STUCK_RUNNING_THRESHOLD_MS));
    for (const stuckJob of stuckRunningJobs) {
      problems.push(`${stuckJob.job_name} has been stuck in "running" since ${(stuckJob.started_at as Date).toISOString()}`);
    }

    if (problems.length === 0) {
      return { details: { problems: [] } };
    }

    return {
      details: { problems },
      notify: `🐕 Watchdog: ${problems.length} issue(s) found —\n${problems.map((p) => `• ${p}`).join("\n")}`,
    };
  });
}
