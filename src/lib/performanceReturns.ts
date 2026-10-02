// Time-weighted account performance from the nightly account_pnl_snapshots rows (formula approved 2026-10-02).
//
// Daily return = (NAV today - NAV previous - net external cash flow today) / NAV previous. External flows
// (deposits, withdrawals, transfers between linked accounts) are assumed to land at the close, so they never
// count as performance and never enlarge the base the day's gain is measured against. Periods are the daily
// returns chained: (1 + r1) * (1 + r2) * ... - 1. CAGR annualises the whole history: (1 + R) ^ (365 / days) - 1.

export interface PerformanceSnapshotRow {
  snapshotDate: string; // YYYY-MM-DD
  netLiquidationValue: number | null;
  netCashFlow: number | null;
}

export interface DailyPerformancePoint {
  snapshotDate: string;
  returnFraction: number;
  profitDollars: number;
}

export interface PeriodPerformance {
  percent: number;
  profitDollars: number;
}

export interface MonthPerformance extends PeriodPerformance {
  year: number;
  month: number; // 1-12
}

export interface YearPerformance extends PeriodPerformance {
  year: number;
}

export interface PerformanceSummary {
  /** The first usable snapshot: the starting point of every figure. No return exists for this day itself. */
  trackingSince: string | null;
  asOf: string | null;
  /** Calendar days from trackingSince to asOf: the span CAGR is annualised over. */
  trackingSpanDays: number | null;
  monthToDate: PeriodPerformance | null;
  months: MonthPerformance[];
  years: YearPerformance[];
  sinceInceptionPercent: number | null;
  compoundAnnualGrowthRatePercent: number | null;
}

const daysPerYear = 365;

/**
 * One point per snapshot after the first usable one. A row without a net liquidation value is skipped and its cash
 * flow carries into the next usable row, so the flow is not lost. A day whose previous NAV is zero or negative has
 * no meaningful return and yields no point (the series simply restarts from that row).
 */
export function computeDailyPerformancePoints(snapshotRows: PerformanceSnapshotRow[]): DailyPerformancePoint[] {
  const orderedRows = [...snapshotRows].sort((first, second) => first.snapshotDate.localeCompare(second.snapshotDate));
  const points: DailyPerformancePoint[] = [];
  let previousNetLiquidationValue: number | null = null;
  let carriedCashFlow = 0;

  for (const row of orderedRows) {
    if (row.netLiquidationValue === null) {
      carriedCashFlow += row.netCashFlow ?? 0;
      continue;
    }
    if (previousNetLiquidationValue === null) {
      previousNetLiquidationValue = row.netLiquidationValue;
      carriedCashFlow = 0;
      continue;
    }
    const netCashFlow = carriedCashFlow + (row.netCashFlow ?? 0);
    const profitDollars = row.netLiquidationValue - previousNetLiquidationValue - netCashFlow;
    if (previousNetLiquidationValue > 0) {
      points.push({ snapshotDate: row.snapshotDate, returnFraction: profitDollars / previousNetLiquidationValue, profitDollars });
    }
    previousNetLiquidationValue = row.netLiquidationValue;
    carriedCashFlow = 0;
  }
  return points;
}

/** Compounds daily returns into one period return (a fraction); null when there are no days. */
export function chainReturnFractions(returnFractions: number[]): number | null {
  if (returnFractions.length === 0) return null;
  return returnFractions.reduce((growth, returnFraction) => growth * (1 + returnFraction), 1) - 1;
}

function summarizePoints(points: DailyPerformancePoint[]): PeriodPerformance | null {
  const chained = chainReturnFractions(points.map((point) => point.returnFraction));
  if (chained === null) return null;
  return { percent: chained * 100, profitDollars: points.reduce((sum, point) => sum + point.profitDollars, 0) };
}

function calendarDaysBetween(earlierIsoDate: string, laterIsoDate: string): number {
  return Math.round((Date.parse(`${laterIsoDate}T00:00:00Z`) - Date.parse(`${earlierIsoDate}T00:00:00Z`)) / 86_400_000);
}

/** Annualised rate for a total return over a span of days; null when the span is under a day or the total return is -100% or worse. */
export function annualiseReturnPercent(totalReturnPercent: number, spanInDays: number): number | null {
  const growth = 1 + totalReturnPercent / 100;
  if (spanInDays < 1 || growth <= 0) return null;
  return (Math.pow(growth, daysPerYear / spanInDays) - 1) * 100;
}

/** currentIsoDate is today's Eastern date; it decides which month "month to date" means. */
export function summarizePerformance(snapshotRows: PerformanceSnapshotRow[], currentIsoDate: string): PerformanceSummary {
  const usableRows = snapshotRows.filter((row) => row.netLiquidationValue !== null).sort((first, second) => first.snapshotDate.localeCompare(second.snapshotDate));
  const trackingSince = usableRows[0]?.snapshotDate ?? null;
  const asOf = usableRows[usableRows.length - 1]?.snapshotDate ?? null;
  const points = computeDailyPerformancePoints(snapshotRows);

  const pointsByMonthKey = new Map<string, DailyPerformancePoint[]>();
  const pointsByYear = new Map<number, DailyPerformancePoint[]>();
  for (const point of points) {
    const monthKey = point.snapshotDate.slice(0, 7);
    pointsByMonthKey.set(monthKey, [...(pointsByMonthKey.get(monthKey) ?? []), point]);
    const year = Number(point.snapshotDate.slice(0, 4));
    pointsByYear.set(year, [...(pointsByYear.get(year) ?? []), point]);
  }

  const months: MonthPerformance[] = [];
  for (const [monthKey, monthPoints] of [...pointsByMonthKey].sort(([first], [second]) => first.localeCompare(second))) {
    const performance = summarizePoints(monthPoints);
    if (performance) months.push({ year: Number(monthKey.slice(0, 4)), month: Number(monthKey.slice(5, 7)), ...performance });
  }
  const years: YearPerformance[] = [];
  for (const [year, yearPoints] of [...pointsByYear].sort(([first], [second]) => first - second)) {
    const performance = summarizePoints(yearPoints);
    if (performance) years.push({ year, ...performance });
  }

  const sinceInception = summarizePoints(points);
  const trackingSpanDays = trackingSince && asOf ? calendarDaysBetween(trackingSince, asOf) : null;
  const currentMonthKey = currentIsoDate.slice(0, 7);
  const monthToDate = summarizePoints(pointsByMonthKey.get(currentMonthKey) ?? []);

  return {
    trackingSince,
    asOf,
    trackingSpanDays,
    monthToDate,
    months,
    years,
    sinceInceptionPercent: sinceInception?.percent ?? null,
    compoundAnnualGrowthRatePercent:
      sinceInception && trackingSpanDays !== null ? annualiseReturnPercent(sinceInception.percent, trackingSpanDays) : null,
  };
}
