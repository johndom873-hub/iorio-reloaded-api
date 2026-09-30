// Outcome rules for scripts/run-daily-calendar-capture-job.ts. Earnings dates feed the Signals earnings
// exclusion and the order warnings, so a fetch that fails (or a ticker that never resolves) silently lets
// a trade through a report date: every such case is a failed run, on every run it persists.

export interface CalendarFetchFailure {
  source: "earnings" | "dividends" | "economic calendar";
  message: string;
}

/** One line for the job alert, or undefined when every fetch worked and every ticker resolved. Free of "): " (Telegram truncation). */
export function buildCalendarCaptureFailureMessage(input: { tickerCount: number; fetchFailures: CalendarFetchFailure[]; unresolvedSymbols: string[] }): string | undefined {
  const problems: string[] = [];
  if (input.tickerCount === 0) problems.push("no tickers to capture (shortlist and open positions are both empty)");
  for (const failure of input.fetchFailures) problems.push(`${failure.source} fetch failed, existing rows are aging - ${failure.message.split("\n")[0]!.slice(0, 200)}`);
  if (input.unresolvedSymbols.length > 0) problems.push(`no TradingView match or lookup error, so no earnings or dividend data for ${input.unresolvedSymbols.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
