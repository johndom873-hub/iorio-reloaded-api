import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";

// A Heroku deploy sends SIGTERM to the web dyno to restart it. If a manual
// job (e.g. Trade Alerts' "Run Now", via runJob() in runJob.ts) is mid-run
// at that moment, the process dies before runJob()'s own try/catch ever
// gets to update its job_runs row -- so the row is abandoned in status
// "running" forever, and every future run of that job is rejected by
// runJob()'s already-running guard even though nothing is actually running
// anymore. Root-caused 2026-09-11: a deploy killed a manual Trade Alerts
// scan mid-stream, and every "Run Now" click afterward silently no-opped
// with "already running" until the stuck row was fixed by hand.
//
// Scoped to triggered_by: "manual" only -- scheduler-triggered jobs run in
// their own one-off Heroku Scheduler dyno, entirely independent of the web
// dyno's lifecycle, so a web restart marking those as interrupted would be
// wrong (and racy against that dyno's own eventual success/failure write).
const shutdownNotifyTimeoutMs = 5_000;

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

export function installShutdownHandler(processName: string): void {
  let shuttingDown = false;

  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const cleanup = db("job_runs")
      .where({ status: "running", triggered_by: "manual" })
      .update({
        status: "failure",
        finished_at: db.fn.now(),
        error_message: "Interrupted by a dyno restart (SIGTERM) before the job could finish.",
      })
      .then((rowsUpdated) => {
        if (rowsUpdated > 0) {
          console.log(`SIGTERM: marked ${rowsUpdated} in-flight manual job run(s) as interrupted.`);
          return notifyTelegram(`⚠️ ${processName}: ${rowsUpdated} manual job run(s) interrupted by a dyno restart mid-run. Safe to retry.`);
        }
      })
      .catch((error) => {
        console.error("SIGTERM cleanup failed:", error);
      });

    withTimeout(cleanup, shutdownNotifyTimeoutMs).finally(() => process.exit(0));
  });
}
