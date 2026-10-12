import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { countBacktestOverrides } from "../backtestSettingsOverrides.js";
import type {
  BacktestCompareResponse,
  BacktestJobStatus,
  BacktestJobView,
  BacktestMetrics,
  BacktestSessionDay,
  BacktestSessionDetail,
  BacktestSessionListItem,
  BacktestSettings,
  BacktestSettingsOverrides,
  BacktestTablesMode,
  BacktestTrade,
} from "../backtestTypes.js";
import { computeAccuracyBands, computeDrawdowns, computeMonthlyReturns, type ClosedTradeFigures } from "../sessionAnalytics.js";
import { BacktestRequestError, insertClaimedBacktestJob, loadBacktestJobView, loadLatestJobViewForSession, startClaimedBacktestJob, stopJobsOfSession } from "./backtestJobStore.js";
import type { ValidatedBacktestSessionRequest } from "./backtestSessionRequest.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { readSplitScheduleCache } from "../engine/splitFactors.js";

// Sessions as the screens read them (backtestTypes.ts), and creating one with its backtest job.

interface SessionRow {
  id: string;
  name: string;
  symbol: string;
  start_date: string;
  end_date: string;
  starting_value: string;
  tables_mode: BacktestTablesMode;
  settings_snapshot: BacktestSettings;
  overrides: BacktestSettingsOverrides;
  status: BacktestJobStatus;
  metrics: BacktestMetrics | null;
  baseline_metrics: BacktestMetrics | null;
  data_last_date: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function selectSessionRows(connection: Knex = db): Knex.QueryBuilder {
  return connection("backtest_sessions").select(
    "id",
    "name",
    "symbol",
    connection.raw("start_date::text as start_date"),
    connection.raw("end_date::text as end_date"),
    "starting_value",
    "tables_mode",
    "settings_snapshot",
    "overrides",
    "status",
    "metrics",
    "baseline_metrics",
    connection.raw("data_last_date::text as data_last_date"),
    "error",
    "created_at",
    "finished_at",
  );
}

function toSessionListItem(row: SessionRow): BacktestSessionListItem {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    startDate: row.start_date,
    endDate: row.end_date,
    startingValue: Number(row.starting_value),
    tablesMode: row.tables_mode,
    status: row.status,
    overrideCount: countBacktestOverrides(row.settings_snapshot, row.overrides),
    metrics: row.metrics,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const nullableNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

export async function listBacktestSessionItems(): Promise<BacktestSessionListItem[]> {
  const rows: SessionRow[] = await selectSessionRows().orderBy("created_at", "desc");
  return rows.map(toSessionListItem);
}

async function loadSessionRow(sessionId: string): Promise<SessionRow> {
  const row = (await selectSessionRows().where({ id: sessionId }).first()) as SessionRow | undefined;
  if (!row) throw new BacktestRequestError("No such session.", 404);
  return row;
}

interface SessionDayRow {
  session_id: string;
  trading_date: string;
  account_value: string;
  cash: string;
  exposure_dollars: string;
  interest_dollars: string;
  daily_return: string | null;
  baseline_value: string;
  baseline_daily_return: string | null;
  decision_summary: string | null;
}

async function loadSessionDayRows(sessionIds: readonly string[]): Promise<SessionDayRow[]> {
  return db("backtest_session_days")
    .whereIn("session_id", sessionIds)
    .orderBy([{ column: "session_id" }, { column: "trading_date" }])
    .select(
      "session_id",
      db.raw("trading_date::text as trading_date"),
      "account_value",
      "cash",
      "exposure_dollars",
      "interest_dollars",
      "daily_return",
      "baseline_value",
      "baseline_daily_return",
      "decision_summary",
    );
}

function toSessionDays(rows: readonly SessionDayRow[]): BacktestSessionDay[] {
  const drawdowns = computeDrawdowns(rows.map((row) => Number(row.account_value)));
  return rows.map((row, index) => ({
    tradingDate: row.trading_date,
    accountValue: Number(row.account_value),
    cash: Number(row.cash),
    exposureDollars: Number(row.exposure_dollars),
    interestDollars: Number(row.interest_dollars),
    dailyReturn: nullableNumber(row.daily_return),
    baselineValue: Number(row.baseline_value),
    baselineDailyReturn: nullableNumber(row.baseline_daily_return),
    drawdown: drawdowns[index]!,
    decisionSummary: row.decision_summary,
  }));
}

function toTrade(row: Record<string, unknown>): BacktestTrade {
  const number = (column: string) => Number(row[column]);
  const optionalNumber = (column: string) => nullableNumber(row[column] as string | null);
  return {
    id: number("id"),
    openedOn: row.opened_on as string,
    strategyKey: row.strategy_key as BacktestTrade["strategyKey"],
    expiry: row.expiry as string,
    strike: number("strike"),
    optionRight: row.option_right as BacktestTrade["optionRight"],
    contracts: number("contracts"),
    bid: number("bid"),
    ask: number("ask"),
    fillPrice: number("fill_price"),
    commissionDollars: number("commission_dollars"),
    spotAtOpen: number("spot_at_open"),
    sharePriceAtOpen: optionalNumber("share_price_at_open"),
    exposureDollars: number("exposure_dollars"),
    dte: number("dte"),
    delta: optionalNumber("delta"),
    grade: row.grade as string,
    edgeMargin: number("edge_margin"),
    expectedPnlDollars: number("expected_pnl_dollars"),
    calibratedExpectedPnlDollars: number("calibrated_expected_pnl_dollars"),
    edgeYield: optionalNumber("edge_yield"),
    histYield: optionalNumber("hist_yield"),
    kellyContracts: optionalNumber("kelly_contracts"),
    stressContracts: optionalNumber("stress_contracts"),
    settledOn: (row.settled_on as string | null) ?? null,
    settlementClose: optionalNumber("settlement_close"),
    inTheMoneyAtExpiry: (row.in_the_money_at_expiry as boolean | null) ?? null,
    pnlDollars: optionalNumber("pnl_dollars"),
  };
}

function toClosedTradeFigures(trade: BacktestTrade): ClosedTradeFigures {
  return {
    openedOn: trade.openedOn,
    settledOn: trade.settledOn,
    exposureDollars: trade.exposureDollars,
    pnlDollars: trade.pnlDollars,
    expectedPnlDollars: trade.expectedPnlDollars,
    calibratedExpectedPnlDollars: trade.calibratedExpectedPnlDollars,
    edgeMargin: trade.edgeMargin,
    inTheMoneyAtExpiry: trade.inTheMoneyAtExpiry,
  };
}

/** The splits the engine found inside the session's period (its cached schedule for the symbol); null before any run analysed the file. */
function detectedSplitsInPeriod(symbol: string, startDateIso: string, endDateIso: string): BacktestSessionDetail["session"]["detectedSplits"] {
  const dataDirectory = readBacktestDataDirectory();
  const cache = dataDirectory ? readSplitScheduleCache(dataDirectory, symbol) : null;
  if (!cache) return null;
  return cache.schedule.splits.filter((split) => split.lastDayBefore >= startDateIso && split.firstDayAfter <= endDateIso);
}

export async function loadBacktestSessionDetail(sessionId: string): Promise<BacktestSessionDetail> {
  const row = await loadSessionRow(sessionId);
  const [dayRows, tradeRows, job] = await Promise.all([
    loadSessionDayRows([sessionId]),
    db("backtest_trades")
      .where({ session_id: sessionId })
      .orderBy([{ column: "backtest_trades.opened_on" }, { column: "backtest_trades.id" }])
      // The date columns as text, listed after "*" so they replace the Date values.
      .select("*", db.raw("opened_on::text as opened_on"), db.raw("expiry::text as expiry"), db.raw("settled_on::text as settled_on")),
    loadLatestJobViewForSession(sessionId),
  ]);
  const days = toSessionDays(dayRows);
  const trades = tradeRows.map(toTrade);
  return {
    session: {
      ...toSessionListItem(row),
      settingsSnapshot: row.settings_snapshot,
      overrides: row.overrides,
      baselineMetrics: row.baseline_metrics,
      detectedSplits: detectedSplitsInPeriod(row.symbol, row.start_date, row.end_date),
      dataLastDate: row.data_last_date,
      error: row.error,
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    },
    job,
    days,
    trades,
    monthlyReturns: computeMonthlyReturns(days, Number(row.starting_value)),
    accuracyByMarginBand: computeAccuracyBands(trades.map(toClosedTradeFigures)),
  };
}

/**
 * Account value curves for the sessions, in the order asked, plus one buy-and-hold curve per distinct symbol, period
 * and starting value (buy and hold depends on nothing else), keyed by the first such session.
 */
export async function loadBacktestComparison(sessionIds: readonly string[]): Promise<BacktestCompareResponse> {
  const rows: SessionRow[] = await selectSessionRows().whereIn("id", sessionIds);
  const rowsInAskedOrder = sessionIds.map((id) => rows.find((row) => row.id === id)).filter((row): row is SessionRow => row !== undefined);
  if (rowsInAskedOrder.length === 0) throw new BacktestRequestError("None of those sessions exist.", 404);

  const daysBySession = new Map<string, SessionDayRow[]>();
  for (const day of await loadSessionDayRows(rowsInAskedOrder.map((row) => row.id))) {
    const sessionDays = daysBySession.get(day.session_id);
    if (sessionDays) sessionDays.push(day);
    else daysBySession.set(day.session_id, [day]);
  }

  const curves: BacktestCompareResponse["curves"] = rowsInAskedOrder.map((row) => ({
    key: row.id,
    label: row.name,
    points: (daysBySession.get(row.id) ?? []).map((day) => ({ tradingDate: day.trading_date, value: Number(day.account_value) })),
  }));
  const baselineKeys = new Set<string>();
  for (const row of rowsInAskedOrder) {
    const baselineIdentity = `${row.symbol}|${row.start_date}|${row.end_date}|${Number(row.starting_value)}`;
    if (baselineKeys.has(baselineIdentity)) continue;
    baselineKeys.add(baselineIdentity);
    curves.push({
      key: `baseline:${row.id}`,
      label: `Buy and hold · ${row.symbol}`,
      points: (daysBySession.get(row.id) ?? []).map((day) => ({ tradingDate: day.trading_date, value: Number(day.baseline_value) })),
    });
  }

  return {
    sessions: rowsInAskedOrder.map((row) => ({ ...toSessionListItem(row), overrides: row.overrides, baselineMetrics: row.baseline_metrics })),
    curves,
  };
}

/** Stores the session (snapshot and changed values only), creates its backtest job and starts the job's process. */
export async function createBacktestSession(request: ValidatedBacktestSessionRequest, snapshot: BacktestSettings): Promise<{ session: BacktestSessionListItem; job: BacktestJobView }> {
  const { sessionId, jobId } = await db.transaction(async (transaction) => {
    const [session] = await transaction("backtest_sessions")
      .insert({
        name: request.name,
        symbol: request.symbol,
        start_date: request.startDate,
        end_date: request.endDate,
        starting_value: request.startingValue,
        tables_mode: request.tablesMode,
        settings_snapshot: JSON.stringify(snapshot),
        overrides: JSON.stringify(request.overrides),
        status: "queued",
      })
      .returning("id");
    const createdJobId = await insertClaimedBacktestJob(session.id as string, request.symbol, transaction);
    return { sessionId: session.id as string, jobId: createdJobId };
  });
  await startClaimedBacktestJob(jobId);
  return { session: toSessionListItem(await loadSessionRow(sessionId)), job: await loadBacktestJobView(jobId) };
}

/** Deletes a session with its days, trades and jobs; an unfinished job is stopped first. */
export async function deleteBacktestSession(sessionId: string): Promise<void> {
  await loadSessionRow(sessionId);
  await stopJobsOfSession(sessionId);
  await db("backtest_sessions").where({ id: sessionId }).del();
}
