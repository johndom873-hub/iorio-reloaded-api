import { Router } from "express";
import { db } from "../db/connection.js";
import { previousOpenSessionDate } from "../lib/marketSessionStatus.js";
import { summarizePerformance, type PerformanceSnapshotRow } from "../lib/performanceReturns.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps, computePositionExposures, streamPositionExposures } from "../lib/positionExposure.js";
import { serializeAsyncCalls } from "../lib/serializeAsyncCalls.js";
import { computeStrategyDailyPnlSeries } from "../lib/strategyPeriodPnl.js";
import { computeCyclePeriodPnl } from "../lib/cyclePeriodPnl.js";
import { fetchPositionEvents } from "../lib/positionEvents.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { bookOfPositionAtNightSql, bookOfPositionNowSql, bookPerformanceRows, loadBookDailySeries, loadBookSummary, loadBooksFirstDate, loadOpenPositionBooksNow, loadPositionBooksNow, requestedBook, type BookDailyRow } from "../books/bookDashboard.js";
import { loadBooksLiveState } from "../books/bookFigures.js";
import type { BookKey } from "../books/bookKeys.js";

// The known strategy buckets the Dashboard breaks P&L/allocation down by —
// "unstructured" folds leftover legs that didn't cleanly resolve into a CC
// or CSP, "hedge" is the long Puts bought outside the app (approved
// 2026-10-01), "leaps" the long Calls (Marcelo 2026-10-27), "residual" is whatever's left after subtracting all five known
// buckets from the trusted account-level total (interest, dividends, fees
// not tied to a specific trade, cash deposits/withdrawals — none of which
// this platform captures individually yet, decided 2026-08-28).
const knownStrategyKeys = ["covered_call", "cash_secured_put", "unstructured", "hedge", "leaps"] as const;
// The Dashboard's P&L cards use the fair cycle attribution (cyclePeriodPnl.ts), whose buckets are named differently.
const cycleBucketByStrategyKey = { covered_call: "cc", cash_secured_put: "csp", unstructured: "unstructured", hedge: "hedge", leaps: "leaps" } as const;

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const defaultHistoryDays = 90;

// Calendar-based WTD/MTD/YTD windows (ISO week = Monday start, Postgres
// default) — the standard convention for a business P&L dashboard, not
// arbitrary trailing N-day windows. Sums daily_pnl (already a delta) over
// each window. "day" is the latest snapshot's own daily_pnl, but only when
// the snapshot before it is the previous open session: the nightly job
// diffs against whatever the previous ROW is, so after a missed night the
// next row's delta spans two sessions — right for the window sums (nothing
// is lost), wrong as a one-day figure, so the Day card shows nothing then.
async function loadPeriodPnl() {
  const [sums, latestTwo] = await Promise.all([
    db.raw(`
      SELECT
        (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('week', CURRENT_DATE)) AS week,
        (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('month', CURRENT_DATE)) AS month,
        (SELECT SUM(daily_pnl) FROM account_pnl_snapshots WHERE snapshot_date >= date_trunc('year', CURRENT_DATE)) AS year
    `),
    db.raw(`SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate", daily_pnl AS "dailyPnl" FROM account_pnl_snapshots ORDER BY snapshot_date DESC LIMIT 2`),
  ]);
  const [latest, previous] = latestTwo.rows as { snapshotDate: string; dailyPnl: string | null }[];
  let day: string | null = null;
  if (latest && previous && latest.dailyPnl !== null) {
    const expectedPreviousDate = await previousOpenSessionDate(latest.snapshotDate);
    day = previous.snapshotDate === expectedPreviousDate ? latest.dailyPnl : null;
  }
  return { day, week: sums.rows[0].week, month: sums.rows[0].month, year: sums.rows[0].year };
}

// --- The book switch (Marcelo 2026-11-05; formulas in books/bookDashboard.ts): ?book=pluto|manual answers for that
// book, from the books' first date; no book is All books, the account's own figures as before. ---

const dayMs = 86_400_000;
/** A Postgres date as YYYY-MM-DD: node-postgres reads a date as local midnight, so its local calendar date is the stored one. */
const dateOnlyIso = (value: string | Date) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);
const daysSince = (startIso: string, todayIso: string) => Math.max(1, Math.round((Date.parse(`${todayIso}T12:00:00Z`) - Date.parse(`${startIso}T12:00:00Z`)) / dayMs) + 1);

/** The later of the year's first day and the books' first date (null before the books start). */
function bookYearStart(todayIso: string, booksFirstDate: string | null): string | null {
  if (booksFirstDate === null) return null;
  const yearStart = `${todayIso.slice(0, 4)}-01-01`;
  return booksFirstDate > yearStart ? booksFirstDate : yearStart;
}

/** Each strategy's daily P&L in the book, summed per strategy from `fromIso` (its strategies' series, bookOfPositionAtNightSql). */
async function loadBookStrategySeries(book: BookKey, fromIso: string, todayIso: string) {
  return computeStrategyDailyPnlSeries(daysSince(fromIso, todayIso), { book, booksFromDate: fromIso });
}

/** Each strategy's unrealised P&L in the book since `baselineIso`: the book's own unrealised now (its cost the transfer's mark) less what it held unrealised at the last position snapshot on or before that day (the close before the books started). */
async function loadBookUnrealizedByStrategy(book: BookKey, baselineIso: string): Promise<Map<string, number>> {
  const [now, baseline] = await Promise.all([
    db.raw(
      `SELECT p.strategy_key, SUM(latest.unrealized_pnl - COALESCE((SELECT SUM(blt.realized_dollars) FROM book_leg_transfers blt JOIN position_legs pl ON pl.id = blt.position_leg_id WHERE pl.position_id = p.id AND pl.exit_at IS NULL), 0))::float AS total
       FROM positions p
       JOIN LATERAL (SELECT s.unrealized_pnl FROM position_pnl_snapshots s WHERE s.position_id = p.id ORDER BY s.snapshot_date DESC LIMIT 1) latest ON true
       WHERE p.status = 'open' AND ${bookOfPositionNowSql("p")} = ?
       GROUP BY p.strategy_key`,
      [book],
    ),
    db.raw(
      `SELECT p.strategy_key, SUM(s.unrealized_pnl)::float AS total
       FROM position_pnl_snapshots s JOIN positions p ON p.id = s.position_id
       WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM position_pnl_snapshots WHERE snapshot_date <= ?::date)
         AND ${bookOfPositionAtNightSql("p", "s.snapshot_date")} = ?
       GROUP BY p.strategy_key`,
      [baselineIso, book],
    ),
  ]);
  const totals = new Map<string, number>();
  for (const row of now.rows as { strategy_key: string; total: number }[]) totals.set(row.strategy_key, (totals.get(row.strategy_key) ?? 0) + row.total);
  for (const row of baseline.rows as { strategy_key: string; total: number }[]) totals.set(row.strategy_key, (totals.get(row.strategy_key) ?? 0) - row.total);
  return totals;
}

async function bookSummaryResponse(book: BookKey) {
  const todayIso = easternIsoDate(new Date());
  const [summary, booksFirstDate] = await Promise.all([loadBookSummary(book, todayIso), loadBooksFirstDate()]);
  const fromIso = bookYearStart(todayIso, booksFirstDate);
  const strategyTotals = new Map<string, number>();
  let unrealizedByStrategy = new Map<string, number>();
  if (fromIso !== null) {
    const [series, unrealized] = await Promise.all([loadBookStrategySeries(book, fromIso, todayIso), loadBookUnrealizedByStrategy(book, fromIso === booksFirstDate ? booksFirstDate : fromIso)]);
    for (const row of series) strategyTotals.set(row.strategyKey, (strategyTotals.get(row.strategyKey) ?? 0) + row.dailyPnl);
    unrealizedByStrategy = unrealized;
  }
  const strategyBreakdown = knownStrategyKeys.map((strategyKey) => {
    const total = strategyTotals.get(strategyKey) ?? 0;
    const unrealizedPnl = unrealizedByStrategy.get(strategyKey) ?? 0;
    return { strategyKey, realizedPnl: total - unrealizedPnl, unrealizedPnl };
  });
  const accountUnrealizedYtd = strategyBreakdown.reduce((sum, row) => sum + row.unrealizedPnl, 0);
  return {
    asOf: summary.asOf,
    netLiquidationValue: summary.bookValue,
    accountRealizedYtd: summary.periods.year - accountUnrealizedYtd,
    accountUnrealizedYtd,
    dayPnlPercent: summary.dayPnlPercent,
    periods: summary.periods,
    strategyBreakdown,
  };
}

dashboardRouter.get("/summary", async (request, response) => {
  const book = requestedBook(request.query);
  if (book) {
    response.json(await bookSummaryResponse(book));
    return;
  }
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

// Time-weighted performance (MTD, per calendar month and year, since inception, CAGR) from the nightly snapshots,
// with deposits, withdrawals and transfers between linked accounts removed via net_cash_flow. Formula in
// lib/performanceReturns.ts. Computed per request: a few hundred rows a year, no stored figures to drift.
dashboardRouter.get("/performance", async (request, response) => {
  const book = requestedBook(request.query);
  if (book) {
    response.json(summarizePerformance(bookPerformanceRows(await loadBookDailySeries(book)), easternIsoDate(new Date())));
    return;
  }
  const snapshotRows: { snapshotDate: string; netLiquidationValue: string | null; netCashFlow: string | null }[] = await db
    .raw(
      `
      SELECT
        to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate",
        net_liquidation_value AS "netLiquidationValue",
        net_cash_flow AS "netCashFlow"
      FROM account_pnl_snapshots
      ORDER BY snapshot_date ASC
      `,
    )
    .then((result) => result.rows);
  const performanceRows: PerformanceSnapshotRow[] = snapshotRows.map((snapshotRow) => ({
    snapshotDate: snapshotRow.snapshotDate,
    netLiquidationValue: snapshotRow.netLiquidationValue === null ? null : Number(snapshotRow.netLiquidationValue),
    netCashFlow: snapshotRow.netCashFlow === null ? null : Number(snapshotRow.netCashFlow),
  }));
  response.json(summarizePerformance(performanceRows, easternIsoDate(new Date())));
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
  response.json({ totalCashValue, cashLockedInCsps, availableCashToTrade, netLiquidationValue: account.netLiquidationValue ?? null });
});

// Portfolio section (2026-08-28): CC / CSP / Unstructured at full market
// value (see project_position_valuation_full_market_value), plus available
// cash. CSP's exposure figure already has the cash-locked collateral baked
// in (positionExposure.ts), so "csp" here already reflects "cash locked in
// CSPs" the way Marcelo asked for.
dashboardRouter.get("/portfolio", async (request, response) => {
  const book = requestedBook(request.query);
  const [allExposures, account, cashLockedInCsps, positionBooks, books] = await Promise.all([
    computePositionExposures(),
    fetchAccountSummary().catch(() => null),
    computeCashLockedInCsps(),
    book ? loadOpenPositionBooksNow() : Promise.resolve(null),
    book ? loadBooksLiveState().catch(() => null) : Promise.resolve(null),
  ]);
  const exposures = positionBooks === null ? allExposures : allExposures.filter((row) => positionBooks.get(row.positionId) === book);

  const byStrategy: Record<string, number> = { covered_call: 0, cash_secured_put: 0, unstructured: 0, hedge: 0, leaps: 0 };
  for (const row of exposures) {
    if (row.strategyKey in byStrategy) byStrategy[row.strategyKey] = (byStrategy[row.strategyKey] ?? 0) + row.exposure;
  }

  const totalCashValue = account?.totalCashValue ?? null;
  const availableCash = book ? (books?.ready ? books.books[book].availableCash : null) : totalCashValue !== null ? totalCashValue - cashLockedInCsps : null;

  response.json({
    coveredCalls: byStrategy.covered_call,
    cashSecuredPuts: byStrategy.cash_secured_put,
    unstructured: byStrategy.unstructured,
    hedge: byStrategy.hedge,
    leaps: byStrategy.leaps,
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
  const book = requestedBook(request.query);
  const [account, cashLockedInCsps, positionBooks, books] = await Promise.all([
    fetchAccountSummary().catch(() => null),
    computeCashLockedInCsps(),
    book ? loadOpenPositionBooksNow() : Promise.resolve(null),
    book ? loadBooksLiveState().catch(() => null) : Promise.resolve(null),
  ]);
  const totalCashValue = account?.totalCashValue ?? null;
  const availableCash = book ? (books?.ready ? books.books[book].availableCash : null) : totalCashValue !== null ? totalCashValue - cashLockedInCsps : null;

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
      serializeAsyncCalls(async (allExposures) => {
        const exposures = positionBooks === null ? allExposures : allExposures.filter((row) => positionBooks.get(row.positionId) === book);
        const byStrategy: Record<string, number> = { covered_call: 0, cash_secured_put: 0, unstructured: 0, hedge: 0, leaps: 0 };
        for (const row of exposures) {
          if (row.strategyKey in byStrategy) byStrategy[row.strategyKey] = (byStrategy[row.strategyKey] ?? 0) + row.exposure;
        }
        send({
          coveredCalls: byStrategy.covered_call,
          cashSecuredPuts: byStrategy.cash_secured_put,
          unstructured: byStrategy.unstructured,
          hedge: byStrategy.hedge,
          leaps: byStrategy.leaps,
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
dashboardRouter.get("/period-pnl-by-strategy", async (request, response) => {
  const book = requestedBook(request.query);
  if (book) {
    response.json(await bookPeriodPnlByStrategy(book));
    return;
  }
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
    hedge: rows.hedge,
    leaps: rows.leaps,
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
  const limit = Math.min(Math.max(Number(request.query.limit) || 40, 1), 200);
  const book = requestedBook(request.query);
  if (!book) {
    response.json(await fetchPositionEvents(limit));
    return;
  }
  // A book's: the latest events of the positions now in it, read from a wider window and cut to the limit.
  const events = await fetchPositionEvents(200);
  const positionBooks = await loadPositionBooksNow([...new Set(events.map((event) => event.positionId))]);
  response.json(events.filter((event) => positionBooks.get(event.positionId) === book).slice(0, limit));
});

dashboardRouter.get("/history", async (request, response) => {
  const days = Math.min(Math.max(Number(request.query.days) || defaultHistoryDays, 1), 365);
  const book = requestedBook(request.query);
  if (book) {
    response.json(await bookHistory(book, days));
    return;
  }

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
    const hedge = strategiesForDay.hedge ?? 0;
    const leaps = strategiesForDay.leaps ?? 0;
    const dailyPnl = row.dailyPnl === null ? null : Number(row.dailyPnl);
    return {
      ...row,
      coveredCalls,
      cashSecuredPuts,
      unstructured,
      hedge,
      leaps,
      residual: dailyPnl === null ? null : dailyPnl - coveredCalls - cashSecuredPuts - unstructured - hedge - leaps,
    };
  });

  response.json(rows);
});

/** Day, week, month and year to date of each strategy in the book (its daily series), Residual the book's own P&L less them. */
async function bookPeriodPnlByStrategy(book: BookKey) {
  const todayIso = easternIsoDate(new Date());
  const [summary, booksFirstDate] = await Promise.all([loadBookSummary(book, todayIso), loadBooksFirstDate()]);
  const zero = () => ({ day: 0, week: 0, month: 0, year: 0 });
  const rows: Record<string, { day: number; week: number; month: number; year: number }> = Object.fromEntries(knownStrategyKeys.map((key) => [key, zero()]));
  const fromIso = bookYearStart(todayIso, booksFirstDate);
  if (fromIso !== null) {
    const date = new Date(`${todayIso}T12:00:00Z`);
    const weekStart = new Date(date);
    weekStart.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const starts = { week: weekStart.toISOString().slice(0, 10), month: `${todayIso.slice(0, 7)}-01` };
    const latestDate = summary.asOf;
    for (const row of await loadBookStrategySeries(book, fromIso, todayIso)) {
      const target = rows[row.strategyKey];
      if (!target) continue;
      const dateIso = dateOnlyIso(row.snapshotDate);
      target.year += row.dailyPnl;
      if (dateIso >= starts.month) target.month += row.dailyPnl;
      if (dateIso >= starts.week) target.week += row.dailyPnl;
      if (summary.periods.day !== null && dateIso === latestDate) target.day += row.dailyPnl;
    }
  }
  const total = { day: summary.periods.day ?? 0, week: summary.periods.week, month: summary.periods.month, year: summary.periods.year };
  const sum = (period: "day" | "week" | "month" | "year") => knownStrategyKeys.reduce((acc, key) => acc + rows[key]![period], 0);
  return {
    coveredCalls: rows.covered_call,
    cashSecuredPuts: rows.cash_secured_put,
    unstructured: rows.unstructured,
    hedge: rows.hedge,
    leaps: rows.leaps,
    residual: { day: total.day - sum("day"), week: total.week - sum("week"), month: total.month - sum("month"), year: total.year - sum("year") },
    total,
  };
}

/** The book's P&L Over Time: its nightly values and days (from the cut-over), its strategies' daily P&L, Residual the rest. */
async function bookHistory(book: BookKey, days: number) {
  const todayIso = easternIsoDate(new Date());
  const [series, booksFirstDate] = await Promise.all([loadBookDailySeries(book), loadBooksFirstDate()]);
  const recent: BookDailyRow[] = series.slice(-days);
  const byDateAndStrategy = new Map<string, Record<string, number>>();
  if (booksFirstDate !== null) {
    for (const row of await computeStrategyDailyPnlSeries(Math.min(days, daysSince(booksFirstDate, todayIso)), { book, booksFromDate: booksFirstDate })) {
      const dateKey = dateOnlyIso(row.snapshotDate);
      if (!byDateAndStrategy.has(dateKey)) byDateAndStrategy.set(dateKey, {});
      byDateAndStrategy.get(dateKey)![row.strategyKey] = row.dailyPnl;
    }
  }
  return recent.map((row) => {
    const strategies = byDateAndStrategy.get(row.snapshotDate) ?? {};
    const coveredCalls = strategies.covered_call ?? 0;
    const cashSecuredPuts = strategies.cash_secured_put ?? 0;
    const unstructured = strategies.unstructured ?? 0;
    const hedge = strategies.hedge ?? 0;
    const leaps = strategies.leaps ?? 0;
    return {
      snapshotDate: row.snapshotDate,
      dailyPnl: row.dailyPnl,
      netLiquidationValue: row.bookValue,
      coveredCalls,
      cashSecuredPuts,
      unstructured,
      hedge,
      leaps,
      residual: row.dailyPnl === null ? null : row.dailyPnl - coveredCalls - cashSecuredPuts - unstructured - hedge - leaps,
    };
  });
}
