import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const defaultHistoryDays = 90;

// Calendar-based WTD/MTD/YTD windows (ISO week = Monday start, Postgres
// default) — the standard convention for a business P&L dashboard, not
// arbitrary trailing N-day windows. Sums daily_pnl (already a delta) over
// each window; "day" is just the latest snapshot's own daily_pnl.
async function loadPeriodPnl() {
  const result = await db.raw(`
    SELECT
      (SELECT daily_pnl FROM account_pnl_snapshots ORDER BY snapshot_date DESC LIMIT 1) AS day,
      (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('week', CURRENT_DATE)) AS week,
      (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('month', CURRENT_DATE)) AS month,
      (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('year', CURRENT_DATE)) AS year
  `);
  return result.rows[0];
}

dashboardRouter.get("/summary", async (_request, response) => {
  const latestAccountSnapshot = await db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first();
  const periods = await loadPeriodPnl();

  // Realized P&L must come straight from position_legs (every closed leg,
  // both open and closed positions) rather than position_pnl_snapshots —
  // that snapshot table is a running mark-to-market of *open* positions
  // only (written nightly for the P&L-over-time chart) and never gets a
  // row once a position closes. Sourcing realized P&L from it silently
  // dropped any gain/loss from a position that had already closed (found
  // 2026-08-25: a closed HOOD position with +$419.19 realized was missing
  // entirely from this breakdown while the account-level cumulative
  // figure, sourced differently, included it — the two numbers disagreed
  // on the Dashboard). Unrealized P&L is legitimately snapshot-sourced,
  // since only open positions have any unrealized P&L to report.
  const strategyBreakdown = await db.raw(`
    SELECT
      strategy_key AS "strategyKey",
      COALESCE(SUM(realized_pnl), 0) AS "realizedPnl",
      COALESCE(SUM(unrealized_pnl), 0) AS "unrealizedPnl"
    FROM (
      SELECT
        p.strategy_key,
        p.id AS position_id,
        (
          SELECT SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
          FROM position_legs pl
          WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL
        ) AS realized_pnl,
        0 AS unrealized_pnl
      FROM positions p

      UNION ALL

      SELECT
        p.strategy_key,
        p.id AS position_id,
        0 AS realized_pnl,
        latest.unrealized_pnl
      FROM (
        SELECT DISTINCT ON (position_id) *
        FROM position_pnl_snapshots
        ORDER BY position_id, snapshot_date DESC
      ) latest
      JOIN positions p ON p.id = latest.position_id
      WHERE p.status = 'open'
    ) per_position
    GROUP BY strategy_key
  `);

  response.json({
    asOf: latestAccountSnapshot?.snapshot_date ?? null,
    netLiquidationValue: latestAccountSnapshot?.net_liquidation_value ?? null,
    cumulativeRealizedPnl: latestAccountSnapshot?.realized_pnl ?? null,
    cumulativeUnrealizedPnl: latestAccountSnapshot?.unrealized_pnl ?? null,
    periods: {
      day: periods.day ?? null,
      week: periods.week ?? null,
      month: periods.month ?? null,
      year: periods.year ?? null,
    },
    strategyBreakdown: strategyBreakdown.rows,
  });
});

// Lightweight shared source for "total account value" used by EXP%
// calculations outside Risk & Limits (Positions table, order-confirmation
// preview) — reads last night's snapshot rather than a live IBKR round
// trip, since those call sites fetch far more often than Risk & Limits
// and IBKR's pacing limits make a live call per positions-list load or
// per contract-count keystroke a bad trade. Risk & Limits itself still
// uses live data via /risk-limits/exposure, since that page is
// specifically about current live exposure.
dashboardRouter.get("/account-value", async (_request, response) => {
  const latestAccountSnapshot = await db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first();
  response.json({
    netLiquidationValue: latestAccountSnapshot?.net_liquidation_value ?? null,
    asOf: latestAccountSnapshot?.snapshot_date ?? null,
  });
});

dashboardRouter.get("/history", async (request, response) => {
  const days = Math.min(Number(request.query.days) || defaultHistoryDays, 365);

  const result = await db.raw(
    `
    SELECT snapshot_date AS "snapshotDate", daily_pnl AS "dailyPnl", net_liquidation_value AS "netLiquidationValue"
    FROM account_pnl_snapshots
    ORDER BY snapshot_date DESC
    LIMIT ?
    `,
    [days],
  );

  response.json(result.rows.reverse());
});
