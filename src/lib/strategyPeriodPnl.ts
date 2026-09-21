import { db } from "../db/connection.js";
import { legRealizedPnlSql } from "./legRealizedPnlSql.js";

// The Dashboard's per-strategy Day/WTD/MTD/YTD table and YTD card moved to the fair cycle attribution
// (cyclePeriodPnl.ts, 2026-09-21). What remains here is the daily series behind the P&L Over Time chart, still on
// the older per-position strategy_key attribution.
//
// Daily per-strategy P&L series for the multi-series chart, derived live
// per calendar day: each day's realized delta (a closing position's
// full lifetime realized P&L minus whatever it had already accrued as of
// the prior day's snapshot — not the raw lifetime P&L on the day it
// happens to close) plus
// each day's unrealized delta (that day's snapshot minus the prior day's,
// per position, via LAG). A day/strategy cell with no activity and no open
// position that day is legitimately 0, not missing.
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
    closed_positions_pnl AS (
      SELECT
        p.id AS position_id,
        p.strategy_key,
        MAX(pl.exit_at)::date AS exit_date,
        SUM(${legRealizedPnlSql("pl")}) AS lifetime_realized_pnl
      FROM position_legs pl
      JOIN positions p ON p.id = pl.position_id
      WHERE pl.exit_price IS NOT NULL
      GROUP BY p.id, p.strategy_key
    ),
    prior_snapshot AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s
      JOIN closed_positions_pnl cp ON cp.position_id = s.position_id AND s.snapshot_date < cp.exit_date
      ORDER BY s.position_id, s.snapshot_date DESC
    ),
    daily_realized AS (
      SELECT cp.strategy_key, cp.exit_date AS d,
        SUM(cp.lifetime_realized_pnl - COALESCE(ps.unrealized_pnl, 0)) AS realized
      FROM closed_positions_pnl cp
      LEFT JOIN prior_snapshot ps ON ps.position_id = cp.position_id
      GROUP BY cp.strategy_key, cp.exit_date
    ),
    snapshot_with_prev AS (
      SELECT
        p.strategy_key,
        s.snapshot_date AS d,
        s.unrealized_pnl - LAG(s.unrealized_pnl) OVER (PARTITION BY s.position_id ORDER BY s.snapshot_date) AS delta
      FROM position_pnl_snapshots s
      JOIN positions p ON p.id = s.position_id
    ),
    daily_unrealized AS (
      SELECT strategy_key, d, SUM(delta) AS unrealized
      FROM snapshot_with_prev
      WHERE delta IS NOT NULL
      GROUP BY strategy_key, d
    )
    SELECT
      days.d AS "snapshotDate",
      strategies.strategy_key AS "strategyKey",
      COALESCE(dr.realized, 0) + COALESCE(du.unrealized, 0) AS "dailyPnl"
    FROM days
    CROSS JOIN strategies
    LEFT JOIN daily_realized dr ON dr.strategy_key = strategies.strategy_key AND dr.d = days.d
    LEFT JOIN daily_unrealized du ON du.strategy_key = strategies.strategy_key AND du.d = days.d
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
