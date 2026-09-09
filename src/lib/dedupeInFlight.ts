/**
 * Wraps a zero-argument async function so concurrent callers share one
 * in-flight call instead of each triggering their own — not a cache with a
 * staleness window, just "if this exact call is already running, await the
 * same result" so two simultaneous callers get byte-identical data from one
 * real fetch instead of two independent (and potentially phase-shifted)
 * ones. Found 2026-09-09: /dashboard/portfolio and /risk-limits/exposure
 * both call computePositionExposures()/fetchAccountSummary() with no
 * arguments whenever loaded together (the Dashboard's Portfolio and Account
 * Allocation cards), doubling concurrent IBKR market-data-line usage for
 * identical work. Once the shared in-flight call settles, the next caller
 * starts a fresh one — this never serves a stale result.
 */
export function dedupeInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
