// Scheduled job (Marcelo 2026-11-23): measures the IBKR login's market-data line allocation once a night, to learn how IBKR
// works out its formula, max(100, monthly commissions ÷ $8, equity × 100 ÷ $1M): which equity, which month's commissions,
// how often it changes. Subscribes to stock quotes until IBKR refuses one (src/ibkr/probeMarketDataLineCeiling.ts) and
// stores what it held, what the app held before and after, the live net liquidation and our own budget
// (ibkr_market_data_line_ceiling_probes). Market data only, no orders.
//
// Heroku Scheduler, daily at 23:30 UTC: after every nightly job, and a slot the 10-minute health check does not use. The
// job still waits for the gap between two health checks if it starts late, and skips the night while the market quote
// loop or Pluto hold priority lines (the market is open then) or on a day the market was closed.
//
// Usage (dev):
//   npm run job:market-data-line-ceiling-probe
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-market-data-line-ceiling-probe-job.js

import "dotenv/config";
import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { marketDataLineCeilingProbeJobName, runMarketDataLineCeilingProbe } from "../src/ibkr/marketDataLineCeilingProbeJob.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log(`Skipping ${marketDataLineCeilingProbeJobName}: market closed today.`);
    return;
  }
  await runJob(marketDataLineCeilingProbeJobName, runMarketDataLineCeilingProbe);
}

runScript("run-market-data-line-ceiling-probe-job", main, () => db.destroy());
