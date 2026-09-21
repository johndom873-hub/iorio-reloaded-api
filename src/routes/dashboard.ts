import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps, computePositionExposures, streamPositionExposures } from "../lib/positionExposure.js";
import { serializeAsyncCalls } from "../lib/serializeAsyncCalls.js";
import { computeStrategyDailyPnlSeries } from "../lib/strategyPeriodPnl.js";
import { computeCyclePeriodPnl } from "../lib/cyclePeriodPnl.js";
import { fetchPositionEvents } from "../lib/positionEvents.js";

// The known strategy buckets the Dashboard breaks P&L/allocation down by —
// "unstructured" folds leftover legs that didn't cleanly resolve into a CC
// or CSP, "residual" is whatever's left after subtracting all three known
// buckets from the trusted account-level total (interest, dividends, fees
// not tied to a specific trade, cash deposits/withdrawals — none of which
// this platform captures individually yet, decided 2026-08-28).
const knownStrategyKeys = ["covered_call", "cash_secured_put", "unstructured"] as const;
// The Dashboard's P&L cards use the fair cycle attribution (cyclePeriodPnl.ts), whose buckets are named differently.
const cycleBucketByStrategyKey = { covered_call: "cc", cash_secured_put: "csp", unstructured: "unstructured" } as const;

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
  const [latestAccountSnapshot, periods, strategyPeriodPnl] = await Promise.all([
    db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first(),
    loadPeriodPnl(),
    computeCyclePeriodPnl(),
  ]);

  // "P&L by Strategy" is YTD-scoped (matches "P&L by Period"'s YTD column
  // — rescoped 2026-09-08, was previously all-time realized/all-time-open
  // unrealized, which made its Residual figure incomparable to the Period
  // card's and left Total's REALIZED column disagreeing wildly with the
  // sum of the visible strategy rows). Sourced from the same
  // computeCyclePeriodPnl() query as the Period card rather than
  // separate SQL, so the two can't drift apart again.
  const strategyBreakdown = knownStrategyKeys.map((strategyKey) => ({
    strategyKey,
    realizedPnl: strategyPeriodPnl.buckets[cycleBucketByStrategyKey[strategyKey]].realizedYear,
    unrealizedPnl: strategyPeriodPnl.buckets[cycleBucketByStrategyKey[strategyKey]].unrealizedYear,
  }));

  // Account-level YTD unrealized: IBKR's $LEDGER-UnrealizedPnL is a live
  // mark-to-market on currently-open positions (a point-in-time *stock*,
  // like this app's own position_pnl_snapshots), so "current minus the
  // snapshot as of Dec 31 last year" is the correct way to isolate this
  // year's move — same pattern cyclePeriodPnl.ts already uses
  // per-position for its own "year" column. Confirmed reliable: it
  // reconciles with this app's own known-strategy unrealized total to
  // within cents.
  //
  // Account-level YTD realized is NOT sourced from $LEDGER-RealizedPnL at
  // all (found 2026-09-08: this account's P&L is ~90% option
  // expirations/assignments, not closing trades, and $LEDGER-RealizedPnL
  // only reflects a *closing trade's* execution same-day -- an expiring
  // short option's gain was already fully captured days earlier via its
  // eroding unrealized mark-to-market, so its expiry-day
  // unrealized-to-realized *reclassification* posts to IBKR's ledger on
  // whatever schedule IBKR's own overnight settlement uses, not
  // same-day, silently starving any daily-reset-based sum of this
  // account's dominant P&L driver -- e.g. four CSPs expired worthless
  // worth $5,169 on 2026-09-03 alone while that day's $LEDGER-RealizedPnL
  // read $0). Deriving it as a plug against the already-correct,
  // lag-free `periods.year` (SUM(daily_pnl), net-liq-based, same trusted
  // total "P&L by Period" uses) instead avoids that gap entirely and
  // guarantees this card's Total ties out to Period's YTD Total exactly.
  const snapshotBeforeYearStart = await db("account_pnl_snapshots")
    .where("snapshot_date", "<", db.raw("date_trunc('year', CURRENT_DATE)"))
    .orderBy("snapshot_date", "desc")
    .first();
  const accountTotalYtd = Number(periods.year ?? 0);
  const accountUnrealizedYtd =
    Number(latestAccountSnapshot?.unrealized_pnl ?? 0) - Number(snapshotBeforeYearStart?.unrealized_pnl ?? 0);
  const accountRealizedYtd = accountTotalYtd - accountUnrealizedYtd;

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
    accountRealizedYtd,
    accountUnrealizedYtd,
    dayPnlPercent,
    periods: {
      day: periods.day ?? null,
      week: periods.week ?? null,
      month: periods.month ?? null,
      year: periods.year ?? null,
    },
    strategyBreakdown,
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

// SSE live-upgrading sibling of GET /portfolio (approved 2026-09-09). Fetches
// account summary once up front (already fast/reliable on its own — no
// FROZEN/live concept applies to reqAccountSummary the way it does to
// reqMktData), then streams exposure rows: a FROZEN-priced reading first,
// recomputed and re-sent every time streamPositionExposures reports newer
// prices, until the client disconnects.
dashboardRouter.get("/portfolio/stream", async (request, response) => {
  const [account, cashLockedInCsps] = await Promise.all([fetchAccountSummary().catch(() => null), computeCashLockedInCsps()]);
  const totalCashValue = account?.totalCashValue ?? null;
  const availableCash = totalCashValue !== null ? totalCashValue - cashLockedInCsps : null;

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  try {
    await streamPositionExposures(
      serializeAsyncCalls(async (exposures) => {
        const byStrategy: Record<string, number> = { covered_call: 0, cash_secured_put: 0, unstructured: 0 };
        for (const row of exposures) {
          if (row.strategyKey in byStrategy) byStrategy[row.strategyKey] = (byStrategy[row.strategyKey] ?? 0) + row.exposure;
        }
        send({
          coveredCalls: byStrategy.covered_call,
          cashSecuredPuts: byStrategy.cash_secured_put,
          unstructured: byStrategy.unstructured,
          availableCash,
        });
      }),
      abortController.signal,
    );
  } catch (error) {
    console.error("dashboard/portfolio/stream: streamPositionExposures failed", error);
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

// Per-strategy Day/WTD/MTD/YTD P&L table (2026-08-28) — realized+unrealized
// combined, computed live on the fair cycle attribution (cyclePeriodPnl.ts,
// switched 2026-09-21; the same buckets as the Positions strategy scoreboard).
// "residual" is the trusted account-level total minus the three known
// buckets — see knownStrategyKeys comment above.
dashboardRouter.get("/period-pnl-by-strategy", async (_request, response) => {
  const [cyclePeriodPnl, accountPeriods] = await Promise.all([computeCyclePeriodPnl(), loadPeriodPnl()]);

  const totals = { day: 0, week: 0, month: 0, year: 0 };
  const rows: Record<string, { day: number; week: number; month: number; year: number }> = {};
  for (const key of knownStrategyKeys) {
    const { day, week, month, year } = cyclePeriodPnl.buckets[cycleBucketByStrategyKey[key]];
    rows[key] = { day, week, month, year };
    totals.day += day;
    totals.week += week;
    totals.month += month;
    totals.year += year;
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
