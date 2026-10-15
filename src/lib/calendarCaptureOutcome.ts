// Outcome rules for scripts/run-daily-calendar-capture-job.ts. Earnings dates feed the Signals earnings
// exclusion and the order warnings, so a fetch that fails (or a ticker that never resolves) silently lets
// a trade through a report date: every such case alerts, on every run it persists. A failed earnings fetch
// leaves every ticker's report dates aging, so it is a failed run; anything narrower completes with errors.

import { isEtfSector } from "./tickerCalendarRelevance.js";
import type { JobResult } from "./runJob.js";

/** CalendarFetchFailure.source of the earnings fetch, the one whose failure fails the run. */
export const earningsFetchSource = "earnings";

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
  return unresolved.filter((ticker) => ticker.reason === "lookup_error" || !isEtfSector(ticker.sector)).map((ticker) => ticker.symbol);
}

/**
 * How a calendar run is recorded: a failure when there are no tickers or the earnings fetch failed (the trade gate),
 * completed with errors when the dividends or a macro source failed or tickers that should resolve did not, neither when
 * clean. Each failed fetch and each unresolved ticker is one error. Free of "): " (Telegram truncation).
 */
export function buildCalendarCaptureJobOutcome(input: { tickerCount: number; fetchFailures: CalendarFetchFailure[]; unresolvedSymbols: string[] }): Pick<JobResult, "failureMessage" | "completedWithErrors"> {
  if (input.tickerCount === 0) return { failureMessage: "no tickers to capture (shortlist and open positions are both empty)" };
  const problems: string[] = [];
  for (const failure of input.fetchFailures) problems.push(`${failure.source} fetch failed, existing rows are aging - ${failure.message.split("\n")[0]!.slice(0, 200)}`);
  if (input.unresolvedSymbols.length > 0) problems.push(`no TradingView match or lookup error, so no earnings or dividend data for ${input.unresolvedSymbols.join(", ")}`);
  if (problems.length === 0) return {};
  if (input.fetchFailures.some((failure) => failure.source === earningsFetchSource)) return { failureMessage: problems.join("; ") };
  return { completedWithErrors: { errorCount: input.fetchFailures.length + input.unresolvedSymbols.length, message: problems.join("; ") } };
}
