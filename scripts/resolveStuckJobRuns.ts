// One-off cleanup: marks orphaned job_runs rows stuck in status='running'
// as 'failure' with an explanatory error_message. These 5 rows (4x
// trade_alert_generation, 1x ibkr_health_check, all 2026-08-24) were left
// behind when the web dyno was briefly on Eco and its 30-min idle-sleep
// SIGTERM'd in-flight Heroku Scheduler one-off dynos mid-run — root-caused
// and fixed by switching back to Basic on 2026-08-25 (see PROGRESS.md).
// runJob() only updates job_runs from inside its own try/catch, so an
// external SIGTERM leaves the row "running" forever with nothing to ever
// resolve it — the daily watchdog job was re-alerting on these same 2-day
// stale rows every run. Not meant to be a reusable script; delete after use.
//
// Usage (prod, via heroku run):
//   node dist/scripts/resolveStuckJobRuns.js

import { db } from "../src/db/connection.js";

const errorMessage =
  "Orphaned by an external process kill (web dyno was briefly on Eco, whose 30-min idle-sleep SIGTERM'd in-flight Heroku Scheduler dynos mid-run) — root cause fixed 2026-08-25 by switching back to Basic. Manually resolved 2026-08-26, see PROGRESS.md.";

async function main(): Promise<void> {
  const stuckRows = await db("job_runs").select("id", "job_name", "started_at").where("status", "running");

  console.log(`Found ${stuckRows.length} row(s) stuck in status='running':`);
  console.log(JSON.stringify(stuckRows, null, 2));

  if (stuckRows.length === 0) {
    console.log("Nothing to resolve.");
    return;
  }

  const updated = await db("job_runs")
    .where("status", "running")
    .update({ status: "failure", finished_at: db.fn.now(), error_message: errorMessage });

  console.log(`Marked ${updated} row(s) as 'failure'.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
