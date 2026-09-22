import { fitAndStoreSurfacesForDate } from "./optionSurfaceStore.js";
import { runJob } from "./runJob.js";

/** runJob wrapper shared by scripts/run-option-surface-fit-job.ts and the chained nightly capture script. */
export async function runOptionSurfaceFitJob(tradingDate: string, options: { symbols?: string[]; triggeredBy: "scheduler" | "manual" }): Promise<void> {
  await runJob(
    "option_surface_fit",
    async () => {
      const result = await fitAndStoreSurfacesForDate(tradingDate, (event) => console.log(`${event.symbol}: ${event.outcome} (${event.detail})`), options.symbols);
      console.log(`Surface fit ${tradingDate}: ${result.tickersFitted} fitted, ${result.tickersSkipped} skipped, ${result.tickersFailed} failed of ${result.snapshotsConsidered}; ${result.expiriesOk} expiries ok, ${result.expiriesFlagged} flagged.`);
      return { details: { ...result } };
    },
    { triggeredBy: options.triggeredBy },
  );
}
