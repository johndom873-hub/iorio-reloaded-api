// Outcome rules for scripts/run-daily-market-data-job.ts. The daily bars and IV history it writes feed
// the Signals volatility forecast, momentum, previous close and IV rank, so "the job ran" is not enough:
// each ticker must have the completed session's bar, and an IV reading.

export interface TickerProblem {
  symbol: string;
  problem: string;
}

/** The hard problem with a ticker's daily bar (worth a retry), or null when it is the expected session's bar. */
export function assessDailyBar(barTradingDate: string | null, expectedSessionDate: string): string | null {
  if (barTradingDate === null) return "no daily bar returned";
  if (barTradingDate < expectedSessionDate) return `latest bar is ${barTradingDate}, expected ${expectedSessionDate}`;
  return null;
}

/**
 * One line for the job alert, or undefined when every ticker has its bar and IV. Kept free of "): "
 * because telegramFailureSummary truncates the Telegram alert at the first one.
 */
export function buildMarketDataFailureMessage(input: { tickerCount: number; failed: TickerProblem[]; missingIv: TickerProblem[]; attempts: number; bailedOnBudget: boolean }): string | undefined {
  const problems: string[] = [];
  if (input.tickerCount === 0) problems.push("no tickers to capture (shortlist and open positions are both empty)");
  if (input.failed.length > 0) {
    const detail = input.failed.map((entry) => `${entry.symbol} - ${entry.problem}`).join(", ");
    problems.push(`${input.failed.length} of ${input.tickerCount} tickers not captured after ${input.attempts} attempt(s)${input.bailedOnBudget ? " (retries stopped on the time budget)" : ""}, ${detail}`);
  }
  if (input.missingIv.length > 0) problems.push(`no implied volatility for ${input.missingIv.map((entry) => `${entry.symbol} - ${entry.problem}`).join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
