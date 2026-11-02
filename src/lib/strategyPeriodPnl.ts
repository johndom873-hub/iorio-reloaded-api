import { db } from "../db/connection.js";
import { legRealizedPnlSql } from "./legRealizedPnlSql.js";

// The Dashboard's per-strategy Day/WTD/MTD/YTD table and YTD card moved to the fair cycle attribution
// (cyclePeriodPnl.ts, 2026-09-21). What remains here is the daily series behind the P&L Over Time chart, still on
// the older per-position strategy_key attribution.
//
// Daily per-strategy P&L series for the multi-series chart (formula approved by Marcelo 2026-11-02). Per position, a day's
// P&L is the change in its total P&L since its previous point, counted from 0 before its first:
//   total P&L(d) = realized P&L of its legs closed on or before d + its unrealized snapshot of d   (a snapshot date)
//   total P&L(d) = its lifetime realized P&L                                                      (the day it closed)
// The points are a position's snapshot dates and the day it closed, so over its life the days add up to exactly its P&L:
// the opening day counts (from entry to that close), and a partial close's realized P&L is not netted against the whole
// position's unrealized. Closes are dated in New York time, like the snapshots (lastCompletedSessionDate). A day/strategy
// cell with no activity and no open position that day is legitimately 0, not missing.
export interface StrategyDailyPnl {
  snapshotDate: string;
  strategyKey: string;
  dailyPnl: number;
}

export async function computeStrategyDailyPnlSeries(days: number): Promise<StrategyDailyPnl[]> {
  const result = await db.raw(
    `
    WITH days AS (
      SELECT generate_series((CURRENT_DATE - (? - 1)::int), CURRENT_DATE, interval '1 day')::date AS d
    ),
    strategies AS (
      SELECT DISTINCT strategy_key FROM positions
    ),
    leg_realized AS (
      SELECT pl.position_id, (pl.exit_at AT TIME ZONE 'America/New_York')::date AS exit_date, ${legRealizedPnlSql("pl")} AS realized
      FROM position_legs pl
      WHERE pl.exit_price IS NOT NULL
    ),
    closed_positions AS (
      SELECT lr.position_id, MAX(lr.exit_date) AS close_date, SUM(lr.realized) AS lifetime_realized
      FROM leg_realized lr
      JOIN positions p ON p.id = lr.position_id
      WHERE p.status = 'closed'
      GROUP BY lr.position_id
    ),
    points AS (
      SELECT s.position_id, s.snapshot_date AS d,
        s.unrealized_pnl + COALESCE((SELECT SUM(lr.realized) FROM leg_realized lr WHERE lr.position_id = s.position_id AND lr.exit_date <= s.snapshot_date), 0) AS total_pnl
      FROM position_pnl_snapshots s
      LEFT JOIN closed_positions cp ON cp.position_id = s.position_id
      WHERE cp.close_date IS NULL OR s.snapshot_date < cp.close_date
      UNION ALL
      SELECT position_id, close_date, lifetime_realized FROM closed_positions
    ),
    position_daily AS (
      SELECT position_id, d, total_pnl - COALESCE(LAG(total_pnl) OVER (PARTITION BY position_id ORDER BY d), 0) AS daily_pnl
      FROM points
    ),
    strategy_daily AS (
      SELECT p.strategy_key, pd.d, SUM(pd.daily_pnl) AS daily_pnl
      FROM position_daily pd
      JOIN positions p ON p.id = pd.position_id
      GROUP BY p.strategy_key, pd.d
    )
    SELECT
      days.d AS "snapshotDate",
      strategies.strategy_key AS "strategyKey",
      COALESCE(sd.daily_pnl, 0) AS "dailyPnl"
    FROM days
    CROSS JOIN strategies
    LEFT JOIN strategy_daily sd ON sd.strategy_key = strategies.strategy_key AND sd.d = days.d
    ORDER BY days.d, strategies.strategy_key
    `,
    [days],
  );

  return result.rows.map((row: Record<string, string>) => ({
    snapshotDate: row.snapshotDate,
    strategyKey: row.strategyKey,
    dailyPnl: Number(row.dailyPnl),
  }));
}
