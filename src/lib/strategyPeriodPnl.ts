import { db } from "../db/connection.js";

// Per-strategy Day/WTD/MTD/YTD P&L, computed live at query time rather
// than from a new nightly snapshot table (decided 2026-08-28 — a hard
// nightly delta leaves a permanent gap if that one job run fails, where
// this degrades gracefully by falling back to the nearest prior snapshot).
//
// realized(period) = legs that exited within the period, grouped by the
// parent position's strategy_key.
// unrealized(period) = unrealized_pnl_now − unrealized_pnl_as_of(period
// start), per currently-open position, using the most recent
// position_pnl_snapshots row on or before the period start date (rows
// persist after a position closes, and a position opened after the period
// start simply has no prior row, correctly defaulting to a 0 baseline).
export interface StrategyPeriodPnl {
  strategyKey: string;
  day: number;
  week: number;
  month: number;
  year: number;
}

export async function computeStrategyPeriodPnl(): Promise<StrategyPeriodPnl[]> {
  const result = await db.raw(`
    WITH period_starts AS (
      -- "day_start" anchors on the most recent snapshot actually captured,
      -- not literal CURRENT_DATE — the nightly job runs once after market
      -- close, so mid-day (before tonight's run) "today" has no snapshot
      -- yet and "yesterday" IS the latest available row. Pinning to
      -- CURRENT_DATE made "unrealized now" and "unrealized as of day start"
      -- resolve to that same latest row, making Day always exactly 0
      -- (found 2026-08-28) even on days with a real move — unlike the
      -- account-level Day figure, which stores each day's delta directly
      -- rather than deriving it from two point-in-time lookups.
      SELECT
        COALESCE((SELECT MAX(snapshot_date) FROM position_pnl_snapshots), CURRENT_DATE) AS day_start,
        date_trunc('week', CURRENT_DATE)::date AS week_start,
        date_trunc('month', CURRENT_DATE)::date AS month_start,
        date_trunc('year', CURRENT_DATE)::date AS year_start
    ),
    realized AS (
      SELECT
        p.strategy_key,
        COALESCE(SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
          FILTER (WHERE pl.exit_at >= (SELECT day_start FROM period_starts)), 0) AS realized_day,
        COALESCE(SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
          FILTER (WHERE pl.exit_at >= (SELECT week_start FROM period_starts)), 0) AS realized_week,
        COALESCE(SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
          FILTER (WHERE pl.exit_at >= (SELECT month_start FROM period_starts)), 0) AS realized_month,
        COALESCE(SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
          FILTER (WHERE pl.exit_at >= (SELECT year_start FROM period_starts)), 0) AS realized_year
      FROM position_legs pl
      JOIN positions p ON p.id = pl.position_id
      WHERE pl.exit_price IS NOT NULL
      GROUP BY p.strategy_key
    ),
    latest_snapshot AS (
      SELECT DISTINCT ON (position_id) position_id, unrealized_pnl AS unrealized_now
      FROM position_pnl_snapshots
      ORDER BY position_id, snapshot_date DESC
    ),
    -- Strictly BEFORE each period's start date, not on-or-before: the
    -- baseline has to be the prior day's close, not today's own snapshot.
    -- Using <= here was a real bug (found 2026-08-28) — day_start is
    -- CURRENT_DATE, so once tonight's snapshot job has run for today,
    -- "latest_snapshot" and "asof day_start" resolved to the exact same
    -- row, making the Day column's unrealized component always exactly 0
    -- regardless of any real intraday move, even though the account-level
    -- Day total (sourced independently from account_pnl_snapshots) showed
    -- the real nonzero delta.
    snapshot_asof_day AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s, period_starts ps
      WHERE s.snapshot_date < ps.day_start
      ORDER BY s.position_id, s.snapshot_date DESC
    ),
    snapshot_asof_week AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s, period_starts ps
      WHERE s.snapshot_date < ps.week_start
      ORDER BY s.position_id, s.snapshot_date DESC
    ),
    snapshot_asof_month AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s, period_starts ps
      WHERE s.snapshot_date < ps.month_start
      ORDER BY s.position_id, s.snapshot_date DESC
    ),
    snapshot_asof_year AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s, period_starts ps
      WHERE s.snapshot_date < ps.year_start
      ORDER BY s.position_id, s.snapshot_date DESC
    ),
    unrealized AS (
      SELECT
        p.strategy_key,
        SUM(ls.unrealized_now - COALESCE(sd.unrealized_pnl, 0)) AS unrealized_day,
        SUM(ls.unrealized_now - COALESCE(sw.unrealized_pnl, 0)) AS unrealized_week,
        SUM(ls.unrealized_now - COALESCE(sm.unrealized_pnl, 0)) AS unrealized_month,
        SUM(ls.unrealized_now - COALESCE(sy.unrealized_pnl, 0)) AS unrealized_year
      FROM positions p
      JOIN latest_snapshot ls ON ls.position_id = p.id
      LEFT JOIN snapshot_asof_day sd ON sd.position_id = p.id
      LEFT JOIN snapshot_asof_week sw ON sw.position_id = p.id
      LEFT JOIN snapshot_asof_month sm ON sm.position_id = p.id
      LEFT JOIN snapshot_asof_year sy ON sy.position_id = p.id
      WHERE p.status = 'open'
      GROUP BY p.strategy_key
    )
    SELECT
      COALESCE(r.strategy_key, u.strategy_key) AS "strategyKey",
      COALESCE(r.realized_day, 0) + COALESCE(u.unrealized_day, 0) AS day,
      COALESCE(r.realized_week, 0) + COALESCE(u.unrealized_week, 0) AS week,
      COALESCE(r.realized_month, 0) + COALESCE(u.unrealized_month, 0) AS month,
      COALESCE(r.realized_year, 0) + COALESCE(u.unrealized_year, 0) AS year
    FROM realized r
    FULL OUTER JOIN unrealized u ON u.strategy_key = r.strategy_key
  `);

  return result.rows.map((row: Record<string, string>) => ({
    strategyKey: row.strategyKey,
    day: Number(row.day),
    week: Number(row.week),
    month: Number(row.month),
    year: Number(row.year),
  }));
}

// Daily per-strategy P&L series for the multi-series chart, same live-
// derivation approach as computeStrategyPeriodPnl but per calendar day
// instead of per period: each day's realized delta (legs that exited that
// day) plus each day's unrealized delta (that day's snapshot minus the
// prior day's, per position, via LAG). A day/strategy cell with no
// activity and no open position that day is legitimately 0, not missing.
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
    daily_realized AS (
      SELECT p.strategy_key, pl.exit_at::date AS d,
        SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END)) AS realized
      FROM position_legs pl
      JOIN positions p ON p.id = pl.position_id
      WHERE pl.exit_price IS NOT NULL
      GROUP BY p.strategy_key, pl.exit_at::date
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
