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
  return [quote.lastPrice, quote.avgShareVolume, quote.avgOptionVolume, quote.callOpenInterest, quote.putOpenInterest, quote.bidAskSpreadPct, quote.impliedVolatility].every((value) => value === null);
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
