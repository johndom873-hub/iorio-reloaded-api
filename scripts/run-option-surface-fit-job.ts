// Fits the SVI surface (Formula 3b) for every chain snapshot of a trading date
// and stores it in option_surface_fits. Derived data, safe to re-run (each
// snapshot's fits are replaced). Normally chained after the nightly chain
// capture (run-option-chain-capture-job.ts); this script is for re-fits and
// for dates the chain job missed.
//
// Usage: npm run job:option-surface-fit [-- --date YYYY-MM-DD] [-- SYMBOL ...]
// Default date = today's Eastern date. Prod: node dist/scripts/run-option-surface-fit-job.js

import { db } from "../src/db/connection.js";
import { easternDateIso } from "../src/lib/marketSessionStatus.js";
import { runOptionSurfaceFitJob } from "../src/lib/runOptionSurfaceFitJob.js";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const dateFlagIndex = arguments_.indexOf("--date");
  const tradingDate = dateFlagIndex >= 0 ? (arguments_[dateFlagIndex + 1] ?? "") : easternDateIso(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) throw new Error(`--date must be YYYY-MM-DD, got "${tradingDate}"`);
  const symbols = arguments_.filter((argument, index) => !argument.startsWith("--") && index !== dateFlagIndex + 1).map((symbol) => symbol.toUpperCase());

  await runOptionSurfaceFitJob(tradingDate, { symbols, triggeredBy: "manual" });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
