// Scheduled job: each option contract's full-session volume after the close, on every shortlisted ticker, for both
// strategies' 20% rule (src/ibkr/runOptionSessionVolumeCapture.ts). IBKR's quote volume holds the whole day only after the close and reads 0
// again by 04:00 ET (measured 2026-10-15), so the job runs at 21:30 UTC: 17:30 ET in summer, 16:30 ET in winter, both
// after the ~16:20 ET final volume, and before the 22:00 UTC market data job.
//
// One fixed-UTC Scheduler entry, market days only (skipped on a closed day before any job_runs row).
//
// Usage (dev):  npm run job:option-session-volume
// Usage (prod): node dist/scripts/run-option-session-volume-capture-job.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";
import { describeSessionVolumeCaptureOutcome, optionSessionVolumeCaptureJobName, runOptionSessionVolumeCapture } from "../src/ibkr/runOptionSessionVolumeCapture.js";

// The first night quotes every contract of the universe (no IV known yet): up to ~35 minutes for 20 tickers.
const staleRunningJobThresholdMs = 75 * 60_000;

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log(`Skipping ${optionSessionVolumeCaptureJobName} — market closed today.`);
    return;
  }
  await runJob(
    optionSessionVolumeCaptureJobName,
    async () => {
      const result = await runOptionSessionVolumeCapture();
      const requested = result.tickers.reduce((sum, ticker) => sum + ticker.requested, 0);
      const withVolume = result.tickers.reduce((sum, ticker) => sum + ticker.withVolume, 0);
      console.log(`Option session volume ${result.sessionDateIso} (for ${result.nextSessionIso}): ${result.tickers.length} tickers, ${requested} contracts quoted, ${withVolume} with volume, ${result.concurrency} lines, ${result.elapsedSeconds} s.`);
      return { details: { ...result }, ...describeSessionVolumeCaptureOutcome(result) };
    },
    { triggeredBy: "scheduler", staleRunningJobThresholdMs },
  );
}

runScript("run-option-session-volume-capture-job", main, () => db.destroy());
