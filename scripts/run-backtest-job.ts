import "dotenv/config";
import { db } from "../src/db/connection.js";
import { sharedReadConnection } from "../src/ibkr/sharedReadConnection.js";
import { executeBacktestJob } from "../src/backtest/jobs/executeBacktestJob.js";
import { enableExactInputCaches } from "../src/lib/exactInputCaches.js";

// One backtest job (a ThetaData download or a backtest run) in its own process (docs/backtesting/DATA-FILES.md). The
// API spawns it detached when the job starts; it also runs from the command line.
//
// Usage: npm run backtest:job -- <jobId>

async function main(): Promise<void> {
  const jobId = process.argv[2]?.trim();
  if (!jobId) throw new Error("Usage: npm run backtest:job -- <jobId>");
  enableExactInputCaches();
  await executeBacktestJob(jobId);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // A new symbol's ticker row is created through the shared read connection, which would otherwise keep the process alive.
    await sharedReadConnection.shutdown();
    await db.destroy();
    // The outcome is written. A detached job process must end even when a library leaves a handle open (an IBKR SSH
    // tunnel that finishes opening after its timeout leaves a listening local server behind).
    process.exit();
  });
