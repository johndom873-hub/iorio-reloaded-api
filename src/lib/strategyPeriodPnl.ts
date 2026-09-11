import { db } from "../db/connection.js";

// Per-strategy Day/WTD/MTD/YTD P&L, computed live at query time rather
// than from a new nightly snapshot table (decided 2026-08-28 — a hard
// nightly delta leaves a permanent gap if that one job run fails, where
// this degrades gracefully by falling back to the nearest prior snapshot).
//
// realized(period) = for each position with a leg that exited within the
// period, its full lifetime realized P&L minus whatever unrealized P&L it
// had already accrued (and already been counted in an earlier period) as
// of that period's start — not the raw lifetime P&L on its own, which
// would double-count a multi-day trade's earlier days into the period it
// happens to close in.
// unrealized(period) = unrealized_pnl_now − unrealized_pnl_as_of(period
// start), per currently-open position, using the most recent
// position_pnl_snapshots row on or before the period start date (rows
// persist after a position closes, and a position opened after the period
// start simply has no prior row, correctly defaulting to a 0 baseline).
// Week/Month/Year's "start" is the beginning of the current calendar
// period (this Monday, the 1st, Jan 1st) — Day's "start" is the *end* of
// the last trading day instead (there's no "beginning of today" that means
// anything before the market opens), so its realized/asof comparisons
// below use the opposite boundary (> / <=) from the other three (>= / <).
export interface StrategyPeriodPnl {
  strategyKey: string;
  day: number;
  week: number;
  month: number;
  year: number;
  // Split-out YTD figures, added for /summary's "P&L by Strategy (YTD)"
  // card (2026-09-08) so it can share this query instead of re-deriving
  // YTD realized/unrealized with separate, driftable SQL.
  realizedYear: number;
  unrealizedYear: number;
}

export async function computeStrategyPeriodPnl(): Promise<StrategyPeriodPnl[]> {
  const result = await db.raw(`
    WITH period_starts AS (
      -- "day_start" anchors on the last actual trading day (from
      -- market_calendar, synced from MarketData.app — see
      -- scripts/sync-market-calendar.ts), not on whatever snapshot happens
      -- to exist. It used to be MAX(snapshot_date) (fixed 2026-08-28 for a
      -- different bug — see git history), but that ties Day's boundary to
      -- the snapshot job's own health: on a normal Monday, before that
      -- day's snapshot has run, MAX(snapshot_date) is last Friday, which
      -- falls *before* week_start (this Monday) — an inverted, wider-than-
      -- the-week Day window that also silently balloons for every day the
      -- job has been failing. Falls back to a plain weekday check (Mon -> 3
      -- days back, else 1 day back) if market_calendar hasn't been synced
      -- for the relevant range, which ignores holidays but never inverts
      -- past the week boundary.
      SELECT
        COALESCE(
          (SELECT MAX(calendar_date) FROM market_calendar WHERE calendar_date < CURRENT_DATE AND is_open = true),
          (CASE EXTRACT(ISODOW FROM CURRENT_DATE) WHEN 1 THEN CURRENT_DATE - 3 ELSE CURRENT_DATE - 1 END)
        ) AS day_start,
        date_trunc('week', CURRENT_DATE)::date AS week_start,
        date_trunc('month', CURRENT_DATE)::date AS month_start,
        date_trunc('year', CURRENT_DATE)::date AS year_start
    ),
    -- Per-position (not per-leg) lifetime realized P&L for every position
    -- that has at least one closed leg. A position's legs all close
    -- together in practice (assignment/expiration/manual close all share
    -- one exit_at; a roll closes the position outright and opens a new
    -- one), so grouping by position and taking that single closing moment
    -- is safe.
    closed_positions_pnl AS (
      SELECT
        p.id AS position_id,
        p.strategy_key,
        MAX(pl.exit_at) AS exit_at,
        SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END)) AS lifetime_realized_pnl
      FROM position_legs pl
      JOIN positions p ON p.id = pl.position_id
      WHERE pl.exit_price IS NOT NULL
      GROUP BY p.id, p.strategy_key
    ),
    latest_snapshot AS (
      SELECT DISTINCT ON (position_id) position_id, unrealized_pnl AS unrealized_now
      FROM position_pnl_snapshots
      ORDER BY position_id, snapshot_date DESC
    ),
    -- ON OR BEFORE day_start here, unlike week/month/year (strictly
    -- before): day_start is the last *completed* trading day's own date
    -- (see period_starts above), so its own snapshot IS the correct
    -- baseline close, not the day before it. "latest_snapshot" (unbounded,
    -- always the freshest row per position) naturally resolves to the same
    -- row when nothing newer has been captured yet, correctly showing $0
    -- rather than misattributing older data as today's move.
    snapshot_asof_day AS (
      SELECT DISTINCT ON (s.position_id) s.position_id, s.unrealized_pnl
      FROM position_pnl_snapshots s, period_starts ps
      WHERE s.snapshot_date <= ps.day_start
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
    -- Realized P&L attributed to a period = the position's full lifetime
    -- realized P&L minus whatever it had already accrued (and already been
    -- counted, via "unrealized" below, in earlier periods) as of that
    -- period's start — not the raw lifetime amount. Otherwise a multi-day
    -- trade that closes today dumps its ENTIRE history into today's "Day"
    -- figure, double-counting the portion already reported on earlier days
    -- (bug found 2026-09-11 via a negative Residual: MU's covered put had
    -- +$1,541 of already-recognized unrealized P&L as of the prior close,
    -- then contributed its full +$1,542 lifetime gain to "Day" on exit).
    -- Mirrors the same day/week/month/year boundary conventions as
    -- "unrealized" below (day: exclusive >, baseline "as of or before"
    -- day_start; week/month/year: inclusive >=, baseline strictly before
    -- period start).
    realized AS (
      SELECT
        cp.strategy_key,
        COALESCE(SUM(cp.lifetime_realized_pnl - COALESCE(sd.unrealized_pnl, 0))
          FILTER (WHERE cp.exit_at > (SELECT day_start FROM period_starts)), 0) AS realized_day,
        COALESCE(SUM(cp.lifetime_realized_pnl - COALESCE(sw.unrealized_pnl, 0))
          FILTER (WHERE cp.exit_at >= (SELECT week_start FROM period_starts)), 0) AS realized_week,
        COALESCE(SUM(cp.lifetime_realized_pnl - COALESCE(sm.unrealized_pnl, 0))
          FILTER (WHERE cp.exit_at >= (SELECT month_start FROM period_starts)), 0) AS realized_month,
        COALESCE(SUM(cp.lifetime_realized_pnl - COALESCE(sy.unrealized_pnl, 0))
          FILTER (WHERE cp.exit_at >= (SELECT year_start FROM period_starts)), 0) AS realized_year
      FROM closed_positions_pnl cp
      LEFT JOIN snapshot_asof_day sd ON sd.position_id = cp.position_id
      LEFT JOIN snapshot_asof_week sw ON sw.position_id = cp.position_id
      LEFT JOIN snapshot_asof_month sm ON sm.position_id = cp.position_id
      LEFT JOIN snapshot_asof_year sy ON sy.position_id = cp.position_id
      GROUP BY cp.strategy_key
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
      COALESCE(r.realized_year, 0) + COALESCE(u.unrealized_year, 0) AS year,
      COALESCE(r.realized_year, 0) AS "realizedYear",
      COALESCE(u.unrealized_year, 0) AS "unrealizedYear"
    FROM realized r
    FULL OUTER JOIN unrealized u ON u.strategy_key = r.strategy_key
  `);

  return result.rows.map((row: Record<string, string>) => ({
    strategyKey: row.strategyKey,
    day: Number(row.day),
    week: Number(row.week),
    month: Number(row.month),
    year: Number(row.year),
    realizedYear: Number(row.realizedYear),
    unrealizedYear: Number(row.unrealizedYear),
  }));
}

// Daily per-strategy P&L series for the multi-series chart, same live-
// derivation approach as computeStrategyPeriodPnl but per calendar day
// instead of per period: each day's realized delta (a closing position's
// full lifetime realized P&L minus whatever it had already accrued as of
// the prior day's snapshot — same double-counting fix as realized(period)
// above, not the raw lifetime P&L on the day it happens to close) plus
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
        SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END)) AS lifetime_realized_pnl
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
