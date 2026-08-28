import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps, computePositionExposures } from "../lib/positionExposure.js";
import { computeStrategyDailyPnlSeries, computeStrategyPeriodPnl } from "../lib/strategyPeriodPnl.js";
import { fetchPositionEvents } from "../lib/positionEvents.js";

// The known strategy buckets the Dashboard breaks P&L/allocation down by —
// "unstructured" folds leftover legs that didn't cleanly resolve into a CC
// or CSP, "residual" is whatever's left after subtracting all three known
// buckets from the trusted account-level total (interest, dividends, fees
// not tied to a specific trade, cash deposits/withdrawals — none of which
// this platform captures individually yet, decided 2026-08-28).
const knownStrategyKeys = ["covered_call", "cash_secured_put", "unstructured"] as const;

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

  const netLiquidationValue = latestAccountSnapshot?.net_liquidation_value ?? null;
  const dayPnl = periods.day !== null ? Number(periods.day) : null;
  // Prior day's net liq = today's minus today's delta — % is against that
  // baseline, not today's own (already-moved) value.
  const dayPnlPercent =
    netLiquidationValue !== null && dayPnl !== null && Number(netLiquidationValue) - dayPnl !== 0
      ? (dayPnl / (Number(netLiquidationValue) - dayPnl)) * 100
      : null;

  response.json({
    asOf: latestAccountSnapshot?.snapshot_date ?? null,
    netLiquidationValue,
    cumulativeRealizedPnl: latestAccountSnapshot?.realized_pnl ?? null,
    cumulativeUnrealizedPnl: latestAccountSnapshot?.unrealized_pnl ?? null,
    dayPnlPercent,
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

// Live "available cash to trade" breakdown (approved 2026-08-27) -- shown on
// both Order Review (can this specific order be afforded right now) and the
// Dashboard. A genuine live IBKR round trip, unlike /account-value above --
// both call sites are low-frequency (a panel open, a dashboard load), not
// per-keystroke, so the pacing cost is acceptable here the same way it is
// for Risk & Limits' /exposure.
//
// IBKR's TotalCashValue doesn't reflect cash committed to open cash-secured
// puts -- selling a CSP doesn't move any cash out of the account, it just
// requires enough of it to exist to cover assignment, so the raw balance
// alone overstates what's genuinely free to commit to a new trade. Covered
// calls need no such adjustment: buying the stock leg already spent real
// cash, so TotalCashValue already reflects that correctly. Same per-position
// "current option leg" subquery shape as riskLimits.ts's position_exposure
// CTE (handles a rolled CSP's leg history the same way), just summed over
// cash_secured_put positions only instead of grouped by every strategy.
dashboardRouter.get("/available-cash", async (_request, response) => {
  const [account, cashLockedInCsps] = await Promise.all([fetchAccountSummary(), computeCashLockedInCsps()]);

  const totalCashValue = account.totalCashValue;
  const availableCashToTrade = totalCashValue !== null ? totalCashValue - cashLockedInCsps : null;
  response.json({ totalCashValue, cashLockedInCsps, availableCashToTrade });
});

// Portfolio section (2026-08-28): CC / CSP / Unstructured at full market
// value (see project_position_valuation_full_market_value), plus available
// cash. CSP's exposure figure already has the cash-locked collateral baked
// in (positionExposure.ts), so "csp" here already reflects "cash locked in
// CSPs" the way Marcelo asked for.
dashboardRouter.get("/portfolio", async (_request, response) => {
  const [exposures, account, cashLockedInCsps] = await Promise.all([
    computePositionExposures(),
    fetchAccountSummary().catch(() => null),
    computeCashLockedInCsps(),
  ]);

  const byStrategy: Record<string, number> = { covered_call: 0, cash_secured_put: 0, unstructured: 0 };
  for (const row of exposures) {
    if (row.strategyKey in byStrategy) byStrategy[row.strategyKey] = (byStrategy[row.strategyKey] ?? 0) + row.exposure;
  }

  const totalCashValue = account?.totalCashValue ?? null;
  const availableCash = totalCashValue !== null ? totalCashValue - cashLockedInCsps : null;

  response.json({
    coveredCalls: byStrategy.covered_call,
    cashSecuredPuts: byStrategy.cash_secured_put,
    unstructured: byStrategy.unstructured,
    availableCash,
  });
});

// Per-strategy Day/WTD/MTD/YTD P&L table (2026-08-28) — realized+unrealized
// combined, computed live (see strategyPeriodPnl.ts for why: more
// resilient to a missed snapshot night than a hard nightly delta table).
// "residual" is the trusted account-level total minus the three known
// buckets — see knownStrategyKeys comment above.
dashboardRouter.get("/period-pnl-by-strategy", async (_request, response) => {
  const [byStrategy, accountPeriods] = await Promise.all([computeStrategyPeriodPnl(), loadPeriodPnl()]);

  const totals = { day: 0, week: 0, month: 0, year: 0 };
  const rows: Record<string, { day: number; week: number; month: number; year: number }> = {};
  for (const key of knownStrategyKeys) rows[key] = { day: 0, week: 0, month: 0, year: 0 };
  for (const row of byStrategy) {
    if (row.strategyKey in rows) {
      rows[row.strategyKey] = { day: row.day, week: row.week, month: row.month, year: row.year };
    }
    totals.day += row.day;
    totals.week += row.week;
    totals.month += row.month;
    totals.year += row.year;
  }

  const accountTotal = {
    day: Number(accountPeriods.day ?? 0),
    week: Number(accountPeriods.week ?? 0),
    month: Number(accountPeriods.month ?? 0),
    year: Number(accountPeriods.year ?? 0),
  };
  const residual = {
    day: accountTotal.day - totals.day,
    week: accountTotal.week - totals.week,
    month: accountTotal.month - totals.month,
    year: accountTotal.year - totals.year,
  };

  response.json({
    coveredCalls: rows.covered_call,
    cashSecuredPuts: rows.cash_secured_put,
    unstructured: rows.unstructured,
    residual,
    total: accountTotal,
  });
});

// Powers the P&L Over Time chart — account-level daily_pnl/net-liq series
// (unchanged) plus, per day, the CC/CSP/Unstructured/Residual breakdown for
// the multi-series view (2026-08-28). Residual per day = that day's trusted
// account total minus the three known buckets, same plug-figure logic as
// /period-pnl-by-strategy.
dashboardRouter.get("/events", async (request, response) => {
  const limit = Math.min(Number(request.query.limit) || 40, 200);
  const events = await fetchPositionEvents(limit);
  response.json(events);
});

dashboardRouter.get("/history", async (request, response) => {
  const days = Math.min(Number(request.query.days) || defaultHistoryDays, 365);

  const [accountResult, strategySeries] = await Promise.all([
    db.raw(
      `
      SELECT snapshot_date AS "snapshotDate", daily_pnl AS "dailyPnl", net_liquidation_value AS "netLiquidationValue"
      FROM account_pnl_snapshots
      ORDER BY snapshot_date DESC
      LIMIT ?
      `,
      [days],
    ),
    computeStrategyDailyPnlSeries(days),
  ]);

  const byDateAndStrategy = new Map<string, Record<string, number>>();
  for (const row of strategySeries) {
    const dateKey = new Date(row.snapshotDate).toISOString().slice(0, 10);
    if (!byDateAndStrategy.has(dateKey)) byDateAndStrategy.set(dateKey, {});
    byDateAndStrategy.get(dateKey)![row.strategyKey] = row.dailyPnl;
  }

  const rows = accountResult.rows.reverse().map((row: { snapshotDate: string; dailyPnl: string | null; netLiquidationValue: string | null }) => {
    const dateKey = new Date(row.snapshotDate).toISOString().slice(0, 10);
    const strategiesForDay = byDateAndStrategy.get(dateKey) ?? {};
    const coveredCalls = strategiesForDay.covered_call ?? 0;
    const cashSecuredPuts = strategiesForDay.cash_secured_put ?? 0;
    const unstructured = strategiesForDay.unstructured ?? 0;
    const dailyPnl = row.dailyPnl === null ? null : Number(row.dailyPnl);
    return {
      ...row,
      coveredCalls,
      cashSecuredPuts,
      unstructured,
      residual: dailyPnl === null ? null : dailyPnl - coveredCalls - cashSecuredPuts - unstructured,
    };
  });

  response.json(rows);
});
