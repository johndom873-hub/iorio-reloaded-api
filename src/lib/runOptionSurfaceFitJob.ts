import { fitAndStoreSurfacesForDate, type SurfaceFitRunEvent } from "./optionSurfaceStore.js";
import { runJob, type JobResult } from "./runJob.js";

/**
 * How a run is recorded, naming every ticker that got no surface grouped by reason (a skip reason or the error text):
 * a failure when nothing was fitted, completed with errors when some tickers were fitted and others not, neither when
 * every ticker was fitted. Kept free of "): " because telegramFailureSummary truncates the Telegram alert at the first one.
 */
export function buildSurfaceFitJobOutcome(events: SurfaceFitRunEvent[], snapshotsConsidered: number, tradingDate: string): Pick<JobResult, "failureMessage" | "completedWithErrors"> {
  // Nothing to fit is not a healthy run: the capture produced no usable snapshot, so Signals has no surface today.
  if (snapshotsConsidered === 0) return { failureMessage: `no complete or partial snapshots found for ${tradingDate}, so no surfaces were fitted` };
  const symbolsByReason = new Map<string, string[]>();
  for (const event of events) {
    if (event.outcome === "fitted") continue;
    const reason = event.outcome === "skipped" ? (event.skipReason ?? event.detail) : `error - ${event.detail}`;
    symbolsByReason.set(reason, [...(symbolsByReason.get(reason) ?? []), event.symbol]);
  }
  if (symbolsByReason.size === 0) return {};
  const notFittedCount = [...symbolsByReason.values()].reduce((total, symbols) => total + symbols.length, 0);
  const reasonSummary = [...symbolsByReason.entries()].map(([reason, symbols]) => `${reason} (${symbols.join(", ")})`).join("; ");
  const fittedCount = events.filter((event) => event.outcome === "fitted").length;
  if (fittedCount === 0) return { failureMessage: `${notFittedCount} of ${snapshotsConsidered} tickers not fitted, ${reasonSummary}` };
  return { completedWithErrors: { errorCount: notFittedCount, message: `${reasonSummary}; ${fittedCount} of ${snapshotsConsidered} tickers fitted` } };
}

/** runJob wrapper shared by scripts/run-option-surface-fit-job.ts and the chained nightly capture script. */
export async function runOptionSurfaceFitJob(tradingDate: string, options: { symbols?: string[]; triggeredBy: "scheduler" | "manual" }): Promise<void> {
  await runJob(
    "option_surface_fit",
    async () => {
      const events: SurfaceFitRunEvent[] = [];
      const result = await fitAndStoreSurfacesForDate(
        tradingDate,
        (event) => {
          events.push(event);
          console.log(`${event.symbol}: ${event.outcome} (${event.detail})`);
        },
        options.symbols,
      );
      console.log(`Surface fit ${tradingDate}: ${result.tickersFitted} fitted, ${result.tickersSkipped} skipped, ${result.tickersFailed} failed of ${result.snapshotsConsidered}; ${result.expiriesOk} expiries ok, ${result.expiriesFlagged} flagged.`);
      // A run where tickers got no surface is recorded as a failure or as completed with errors (runJob alerts either way), not a "success" that hides it.
      return { details: { ...result }, ...buildSurfaceFitJobOutcome(events, result.snapshotsConsidered, tradingDate) };
    },
    { triggeredBy: options.triggeredBy },
  );
}
