// Outcome rules for scripts/run-daily-calendar-capture-job.ts. Earnings dates feed the Signals earnings
// exclusion and the order warnings, so a fetch that fails (or a ticker that never resolves) silently lets
// a trade through a report date: every such case is a failed run, on every run it persists.

export interface CalendarFetchFailure {
  /** "earnings", "dividends", or "major macro events, <source>". */
  source: string;
  message: string;
}

export interface UnresolvedTicker {
  symbol: string;
  /** tickers.sector: IBKR labels ETFs "ETF". */
  sector: string | null;
  reason: "no_match" | "lookup_error";
}

/**
 * Which unresolved tickers are worth an alert. A failed lookup always is. "No TradingView match" is normal for an
 * ETF (it has no earnings calendar and TradingView lists it as a fund, not a stock), so only a non-ETF that
 * TradingView cannot match is a problem: its earnings dates would silently never gate a trade. Without this the
 * job would fail every night for the 7 ETFs on the shortlist.
 */
export function selectAlertWorthyUnresolved(unresolved: UnresolvedTicker[]): string[] {
  return unresolved.filter((ticker) => ticker.reason === "lookup_error" || ticker.sector !== "ETF").map((ticker) => ticker.symbol);
}

/** One line for the job alert, or undefined when every fetch worked and every ticker that should resolve did. Free of "): " (Telegram truncation). */
export function buildCalendarCaptureFailureMessage(input: { tickerCount: number; fetchFailures: CalendarFetchFailure[]; unresolvedSymbols: string[] }): string | undefined {
  const problems: string[] = [];
  if (input.tickerCount === 0) problems.push("no tickers to capture (shortlist and open positions are both empty)");
  for (const failure of input.fetchFailures) problems.push(`${failure.source} fetch failed, existing rows are aging - ${failure.message.split("\n")[0]!.slice(0, 200)}`);
  if (input.unresolvedSymbols.length > 0) problems.push(`no TradingView match or lookup error, so no earnings or dividend data for ${input.unresolvedSymbols.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
