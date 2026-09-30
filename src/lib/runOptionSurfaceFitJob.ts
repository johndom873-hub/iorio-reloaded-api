import { fitAndStoreSurfacesForDate, type SurfaceFitRunEvent } from "./optionSurfaceStore.js";
import { runJob } from "./runJob.js";

/**
 * One line naming every ticker that got no surface, grouped by reason (a skip reason or the
 * error text), or undefined when every ticker was fitted. Kept free of "): " because
 * telegramFailureSummary truncates the Telegram alert at the first one.
 */
export function buildSurfaceFitFailureMessage(events: SurfaceFitRunEvent[], snapshotsConsidered: number): string | undefined {
  const symbolsByReason = new Map<string, string[]>();
  for (const event of events) {
    if (event.outcome === "fitted") continue;
    const reason = event.outcome === "skipped" ? (event.skipReason ?? event.detail) : `error - ${event.detail}`;
    symbolsByReason.set(reason, [...(symbolsByReason.get(reason) ?? []), event.symbol]);
  }
  if (symbolsByReason.size === 0) return undefined;
  const notFittedCount = [...symbolsByReason.values()].reduce((total, symbols) => total + symbols.length, 0);
  const reasonSummary = [...symbolsByReason.entries()].map(([reason, symbols]) => `${reason} (${symbols.join(", ")})`).join("; ");
  return `${notFittedCount} of ${snapshotsConsidered} tickers not fitted, ${reasonSummary}`;
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
      // A run where tickers got no surface is recorded as a failure (runJob alerts), not a "success" that hides it.
      return { details: { ...result }, failureMessage: buildSurfaceFitFailureMessage(events, result.snapshotsConsidered) };
    },
    { triggeredBy: options.triggeredBy },
  );
}
