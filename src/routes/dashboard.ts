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

  // Latest position_pnl_snapshots row per position, joined to strategy_key,
  // summed — current-state breakdown (no per-strategy daily-delta column
  // to bucket by period).
  const strategyBreakdown = await db.raw(`
    SELECT
      p.strategy_key AS "strategyKey",
      SUM(latest.realized_pnl) AS "realizedPnl",
      SUM(latest.unrealized_pnl) AS "unrealizedPnl",
      SUM(latest.market_value) AS "marketValue"
    FROM (
      SELECT DISTINCT ON (position_id) *
      FROM position_pnl_snapshots
      ORDER BY position_id, snapshot_date DESC
    ) latest
    JOIN positions p ON p.id = latest.position_id
    GROUP BY p.strategy_key
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
