// Outcome rules for scripts/run-daily-screener-scan-job.ts. The scanner and the enrichment both resolve
// with empty results on an IBKR error or timeout instead of throwing, so without these checks a broken
// scan (the zero-result marketCapAbove filter, 2026-09-25) or a timed-out enrichment looks like a success.

export interface EnrichmentQuote {
  lastPrice: number | null;
  avgShareVolume: number | null;
  avgOptionVolume: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  bidAskSpreadPct: number | null;
  impliedVolatility: number | null;
}

/** True when the enrichment timed out or errored and came back with nothing at all: it must not overwrite stored data. */
export function isEmptyEnrichment(quote: EnrichmentQuote): boolean {
  return Object.values(quote).every((value) => value === null);
}

/** One line for the job alert, or undefined when every scan returned rows and every symbol enriched. Free of "): " (Telegram truncation). */
export function buildScreenerFailureMessage(input: { scanCounts: Record<string, number>; failedSymbols: string[]; universeSize: number }): string | undefined {
  const problems: string[] = [];
  const emptyScans = Object.entries(input.scanCounts).filter(([, rowCount]) => rowCount === 0).map(([scanName]) => scanName);
  if (emptyScans.length > 0 && emptyScans.length === Object.keys(input.scanCounts).length) problems.push("every scan returned zero rows, so the screener universe was not refreshed");
  else if (emptyScans.length > 0) problems.push(`scans returned zero rows: ${emptyScans.join(", ")}`);
  if (input.universeSize === 0) problems.push("the screener universe is empty");
  if (input.failedSymbols.length > 0) problems.push(`${input.failedSymbols.length} of ${input.universeSize} symbols failed enrichment and kept their stored values: ${input.failedSymbols.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
