// Outcome rules for scripts/run-daily-screener-scan-job.ts. The scanner and the enrichment both resolve
// with empty results on an IBKR error or timeout instead of throwing, so without these checks a broken
// scan (the zero-result marketCapAbove filter, 2026-09-25) or a timed-out enrichment looks like a success.

import type { JobResult } from "./runJob.js";

export interface EnrichmentQuote {
  lastPrice: number | null;
  avgShareVolume: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  impliedVolatility: number | null;
}

/** True when the enrichment timed out or errored and came back with nothing at all: it must not overwrite stored data. */
export function isEmptyEnrichment(quote: EnrichmentQuote): boolean {
  return [quote.lastPrice, quote.avgShareVolume, quote.callOpenInterest, quote.putOpenInterest, quote.impliedVolatility].every((value) => value === null);
}

/**
 * "PSKY (IBKR 200 No security definition has been found for the request)", or "(no data before the timeout)" when IBKR
 * sent no error. newSymbol, when IBKR now files the contract under another ticker, adds ", now trades as SKYD".
 */
export function describeFailedEnrichment(symbol: string, ibkrError: { code: number; message: string } | null, newSymbol: string | null = null): string {
  const renameNote = newSymbol ? `, now trades as ${newSymbol}` : "";
  if (!ibkrError) return `${symbol} (no data before the timeout${renameNote})`;
  return `${symbol} (IBKR ${ibkrError.code} ${ibkrError.message.replaceAll("): ", ") ")}${renameNote})`;
}

/**
 * How a screener run is recorded: a failure when nothing was refreshed (every scan empty, an empty universe, or every symbol
 * failed enrichment), completed with errors when some scans came back empty or some symbols failed enrichment, neither when
 * clean. Each empty scan and each failed symbol is one error. Free of "): " (Telegram truncation).
 */
export function buildScreenerJobOutcome(input: { scanCounts: Record<string, number>; failedSymbols: string[]; universeSize: number }): Pick<JobResult, "failureMessage" | "completedWithErrors"> {
  const problems: string[] = [];
  const emptyScans = Object.entries(input.scanCounts).filter(([, rowCount]) => rowCount === 0).map(([scanName]) => scanName);
  const everyScanEmpty = emptyScans.length > 0 && emptyScans.length === Object.keys(input.scanCounts).length;
  if (everyScanEmpty) problems.push("every scan returned zero rows, so the screener universe was not refreshed");
  else if (emptyScans.length > 0) problems.push(`scans returned zero rows: ${emptyScans.join(", ")}`);
  if (input.universeSize === 0) problems.push("the screener universe is empty");
  if (input.failedSymbols.length > 0) problems.push(`${input.failedSymbols.length} of ${input.universeSize} symbols failed enrichment and kept their stored values: ${input.failedSymbols.join(", ")}`);
  if (problems.length === 0) return {};
  if (everyScanEmpty || input.universeSize === 0 || input.failedSymbols.length >= input.universeSize) return { failureMessage: problems.join("; ") };
  return { completedWithErrors: { errorCount: emptyScans.length + input.failedSymbols.length, message: problems.join("; ") } };
}
