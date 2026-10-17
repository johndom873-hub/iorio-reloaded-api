import type { BacktestBatchCombined, BacktestCurveFigures, BacktestMetrics } from "./backtestTypes.js";
import { computeBacktestMetrics, type AccountDay, type SessionBookFigures } from "./sessionAnalytics.js";

// A batch's combined portfolio (formula F1, approved by Marcelo 2026-10-17): the ticked runs as separate accounts in one
// portfolio, added up day by day. The session's own formulas (computeBacktestMetrics) run on the sum, with the runs' option
// sales and wheel cycles pooled. Buy and hold and SPY are the sums of each run's own lines. The runs share no cash, and
// the per-ticker and per-sector caps do not reach across them. Pure.

/** One run's stored days and book, as the combination reads them. */
export interface CombinedRunInput {
  runNumber: number;
  startingValue: number;
  days: readonly { tradingDate: string; value: number; exposureDollars: number; interestDollars: number; baselineValue: number; spyBaselineValue: number | null }[];
  /** Its option sales and its wheel cycles with their predictions (cycleFiguresOf of its own cycles and sales). */
  book: SessionBookFigures;
}

function curveFigures(metrics: BacktestMetrics): BacktestCurveFigures {
  const { startValue, endValue, totalReturn, cagr, sortino, maxDrawdown, worstMonth } = metrics;
  return { startValue, endValue, totalReturn, cagr, sortino, maxDrawdown, worstMonth };
}

/** The runs added up on the trading days they all have, in date order. */
export function combineBatchRuns(runs: readonly CombinedRunInput[]): BacktestBatchCombined {
  if (runs.length < 2) throw new Error("A combined portfolio needs two or more runs.");
  const dayMaps = runs.map((run) => new Map(run.days.map((day) => [day.tradingDate, day])));
  const everyDate = [...new Set(runs.flatMap((run) => run.days.map((day) => day.tradingDate)))].sort();
  const sharedDates = everyDate.filter((date) => dayMaps.every((days) => days.has(date)));
  const startValue = runs.reduce((sum, run) => sum + run.startingValue, 0);

  const sum = (date: string, pick: (day: CombinedRunInput["days"][number]) => number) => dayMaps.reduce((total, days) => total + pick(days.get(date)!), 0);
  const days: AccountDay[] = sharedDates.map((tradingDate) => ({
    tradingDate,
    value: sum(tradingDate, (day) => day.value),
    exposureDollars: sum(tradingDate, (day) => day.exposureDollars),
    interestDollars: sum(tradingDate, (day) => day.interestDollars),
  }));
  // Buy and hold keeps no exposure or interest per day: only the figures of its value line are given.
  const baselineDays: AccountDay[] = sharedDates.map((tradingDate) => ({ tradingDate, value: sum(tradingDate, (day) => day.baselineValue), exposureDollars: 0, interestDollars: 0 }));
  const hasSpy = sharedDates.length > 0 && sharedDates.every((date) => dayMaps.every((runDays) => runDays.get(date)!.spyBaselineValue !== null));
  const spyDays: AccountDay[] = hasSpy ? sharedDates.map((tradingDate) => ({ tradingDate, value: sum(tradingDate, (day) => day.spyBaselineValue!), exposureDollars: 0, interestDollars: 0 })) : [];

  const book: SessionBookFigures = { optionSales: runs.flatMap((run) => run.book.optionSales), cycles: runs.flatMap((run) => run.book.cycles) };
  return {
    runNumbers: runs.map((run) => run.runNumber),
    metrics: computeBacktestMetrics(days, book, startValue),
    baselineFigures: curveFigures(computeBacktestMetrics(baselineDays, null, startValue)),
    spyBaselineFigures: hasSpy ? curveFigures(computeBacktestMetrics(spyDays, null, startValue)) : null,
    points: sharedDates.map((tradingDate, index) => ({ tradingDate, value: days[index]!.value, baselineValue: baselineDays[index]!.value, spyBaselineValue: hasSpy ? spyDays[index]!.value : null })),
    daysLeftOut: everyDate.length - sharedDates.length,
  };
}
