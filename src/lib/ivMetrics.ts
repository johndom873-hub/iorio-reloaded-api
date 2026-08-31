import { db } from "../db/connection.js";

// Two implied-volatility history metrics, both sourced from the same
// daily_price_bars.implied_volatility series (IBKR OPTION_IMPLIED_VOLATILITY,
// one blended value per day for the underlying, not per-strike/expiry —
// confirmed available for every ticker actually shortlisted/held via
// tmp/checkHistoricalIvCoverage.ts, 2026-08-31) so the two numbers can never
// silently disagree about what "today" or "the history" means, even though
// they're shown on different screens (Screener, Trade Alerts).
//
// Deliberately one shared source, not two: Screener's IV Rank originally
// read market_data_snapshots (a different table, populated by the live
// generic-tick capture) — migrated here 2026-08-31 when IV Percentile was
// added to Trade Alerts, specifically to close that drift risk rather than
// ship two IV numbers that could quietly diverge.
//
// - IV Rank = (today's IV − window min) / (window max − window min) × 100.
//   Approved formula (see PROGRESS.md "Decisions made"), unchanged — only
//   its data source moved. Skewed by a single outlier day (e.g. an old
//   earnings spike sets the low/high forever).
// - IV Percentile = % of the window's other days whose IV closed below
//   today's. Approved 2026-08-31 specifically because it isn't skewed the
//   same way — the practical answer to "is today rich relative to normal,"
//   which Rank can misstate for a long time after one spike.
const lookbackTradingDays = 252;
const minDaysForRank = 2;
const minDaysForPercentile = 20;

export interface IvMetrics {
  ivRank: number | null;
  ivPercentile: number | null;
  ivWindowDays: number;
}

const emptyMetrics: IvMetrics = { ivRank: null, ivPercentile: null, ivWindowDays: 0 };

export async function computeIvMetrics(tickerId: string): Promise<IvMetrics> {
  const rows: { implied_volatility: string }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereNotNull("implied_volatility")
    .orderBy("trading_date", "desc")
    .limit(lookbackTradingDays);

  if (rows.length === 0) return emptyMetrics;

  const values = rows.map((row) => Number(row.implied_volatility));
  const todayIv = values[0]!;
  const windowDays = values.length;

  let ivRank: number | null = null;
  if (windowDays >= minDaysForRank) {
    const minIv = Math.min(...values);
    const maxIv = Math.max(...values);
    if (maxIv > minIv) ivRank = ((todayIv - minIv) / (maxIv - minIv)) * 100;
  }

  let ivPercentile: number | null = null;
  const history = values.slice(1);
  if (history.length >= minDaysForPercentile) {
    const belowCount = history.filter((iv) => iv < todayIv).length;
    ivPercentile = (belowCount / history.length) * 100;
  }

  return { ivRank, ivPercentile, ivWindowDays: windowDays };
}
