import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { countBacktestOverrides } from "../backtestSettingsOverrides.js";
import type {
  BacktestAction,
  BacktestActionsPage,
  BacktestCompareResponse,
  BacktestCycle,
  BacktestFill,
  BacktestFillsPage,
  BacktestJobStatus,
  BacktestJobView,
  BacktestMetrics,
  BacktestPnlBasis,
  BacktestPosition,
  BacktestPositionLeg,
  BacktestRunStatistics,
  BacktestSessionDay,
  BacktestSessionDetail,
  BacktestSessionListItem,
  BacktestSessionRunState,
  BacktestSessionsPage,
  BacktestSettings,
  BacktestSettingsOverrides,
  BacktestSymbolSettings,
  BacktestTablesMode,
  BacktestTrade,
  BacktestBookMode,
} from "../backtestTypes.js";
import { backtestCaptureLookTimeEt } from "../backtestTypes.js";
import { computeCycleAccuracyBands, computeDrawdowns, computeMonthlyReturns, computeTradeAccuracyBands, cycleFiguresOf, type ClosedTradeFigures } from "../sessionAnalytics.js";
import { computeAllSymbolsStatistics, computeTickerStatistics } from "../tickerStatistics.js";
import { BacktestRequestError, insertClaimedBacktestJob, loadBacktestJobView, loadLatestJobViewForSession, loadLatestSessionRunStates, startClaimedBacktestJob, stopJobsOfSession } from "./backtestJobStore.js";
import type { BacktestBookPageFilters, BacktestSessionsPageFilters, ValidatedBacktestSessionRequest } from "./backtestSessionRequest.js";
import { sqlContainsPattern } from "../../lib/sqlContainsPattern.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { readSplitScheduleCache } from "../engine/splitFactors.js";
import { withPositionCycle, type BacktestPositionRecord } from "../engine/backtestSessionRecords.js";

const spyBaselineLabel = "Buy and hold · SPY";
/** "HOOD #12": a symbol's cycle as the screens name it (backtestSessionRecords.ts describeCycle). */
const describeCycle = (symbol: string, cycleNumber: number) => `${symbol} #${cycleNumber}`;

// Sessions as the screens read them (backtestTypes.ts), and creating one with its backtest job. A session's detail
// carries its days, option sales, positions and cycles; its actions and fills, which grow with every look, are read page
// by page.

interface SessionRow {
  id: string;
  name: string;
  /** The symbols as text ("SMCI, HOOD"). */
  symbol: string;
  /** Empty on a row from before sessions took a list. */
  symbols: string[] | null;
  start_date: string;
  end_date: string;
  starting_value: string;
  tables_mode: BacktestTablesMode;
  settings_snapshot: BacktestSettings;
  overrides: BacktestSettingsOverrides;
  book_mode: BacktestBookMode;
  symbol_settings: Record<string, BacktestSymbolSettings> | null;
  status: BacktestJobStatus;
  metrics: BacktestMetrics | null;
  baseline_metrics: BacktestMetrics | null;
  spy_baseline_metrics: BacktestMetrics | null;
  pnl_basis: BacktestPnlBasis;
  data_last_date: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  notes: string[] | null;
  run_statistics: BacktestRunStatistics | null;
  /** Aggregated from the session's backtest_cycles rows. */
  wheel_cycles: { cycleCount: number; closedCycleCount: number; openCycleCount: number; totalPnlDollars: number | string; openCyclePnlDollars: number | string };
}

function selectSessionRows(connection: Knex = db): Knex.QueryBuilder {
  return connection("backtest_sessions").select(
    "id",
    "name",
    "symbol",
    "symbols",
    connection.raw("start_date::text as start_date"),
    connection.raw("end_date::text as end_date"),
    "starting_value",
    "tables_mode",
    "settings_snapshot",
    "overrides",
    "book_mode",
    "symbol_settings",
    "status",
    "metrics",
    "baseline_metrics",
    "spy_baseline_metrics",
    "pnl_basis",
    connection.raw("data_last_date::text as data_last_date"),
    "error",
    "created_at",
    "finished_at",
    "notes",
    "run_statistics",
    connection.raw(`(
      select json_build_object(
        'cycleCount', count(*),
        'closedCycleCount', count(*) filter (where cycle.status = 'closed'),
        'openCycleCount', count(*) filter (where cycle.status = 'open'),
        'totalPnlDollars', coalesce(sum(cycle.total_dollars), 0),
        'openCyclePnlDollars', coalesce(sum(cycle.total_dollars) filter (where cycle.status = 'open'), 0)
      )
      from backtest_cycles cycle where cycle.session_id = backtest_sessions.id
    ) as wheel_cycles`),
  );
}

/** The symbols on a session's book, in the order given. */
function symbolsOf(row: Pick<SessionRow, "symbol" | "symbols">): string[] {
  return Array.isArray(row.symbols) && row.symbols.length > 0 ? row.symbols : [row.symbol];
}

/** A session's symbols as one text: what `backtest_sessions.symbol` and its job row hold. */
export function describeSessionSymbols(symbols: readonly string[]): string {
  return symbols.join(", ");
}

function toSessionListItem(row: SessionRow, latestRun: BacktestSessionRunState | null = null): BacktestSessionListItem {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    symbols: symbolsOf(row),
    startDate: row.start_date,
    endDate: row.end_date,
    startingValue: Number(row.starting_value),
    tablesMode: row.tables_mode,
    status: row.status,
    overrideCount: countBacktestOverrides(row.settings_snapshot, row.overrides),
    metrics: row.metrics,
    pnlBasis: row.pnl_basis,
    // A finished session measured per cycle; a running one has none stored yet.
    wheelCycles:
      row.pnl_basis === "wheel_cycle" && row.status === "succeeded"
        ? {
            cycleCount: Number(row.wheel_cycles.cycleCount),
            closedCycleCount: Number(row.wheel_cycles.closedCycleCount),
            openCycleCount: Number(row.wheel_cycles.openCycleCount),
            totalPnlDollars: Number(row.wheel_cycles.totalPnlDollars),
            openCyclePnlDollars: Number(row.wheel_cycles.openCyclePnlDollars),
          }
        : null,
    createdAt: new Date(row.created_at).toISOString(),
    latestRun,
  };
}

const nullableNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** The Sessions list's filters: a name search (any part, ignoring case), a symbol on the session's book, a status. */
function whereSessionsMatch(query: Knex.QueryBuilder, filters: BacktestSessionsPageFilters): Knex.QueryBuilder {
  if (filters.search !== null) query.whereILike("backtest_sessions.name", sqlContainsPattern(filters.search));
  const symbol = filters.symbol;
  if (symbol !== null) query.where((inner) => inner.whereRaw("backtest_sessions.symbols @> ?::jsonb", [JSON.stringify([symbol])]).orWhere("backtest_sessions.symbol", symbol));
  if (filters.status !== null) query.whereIn("backtest_sessions.status", filters.status === "running" ? ["queued", "running"] : [filters.status]);
  return query;
}

/** Every symbol any session has, A to Z: the Sessions list's Symbol filter. */
async function listSessionSymbols(): Promise<string[]> {
  const result: { rows: { symbol: string }[] } = await db.raw(`
    SELECT DISTINCT listed.symbol
    FROM backtest_sessions s
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_array_length(s.symbols) > 0 THEN s.symbols ELSE jsonb_build_array(s.symbol) END) AS listed(symbol)
    ORDER BY listed.symbol
  `);
  return result.rows.map((row) => row.symbol);
}

/** One page of the Sessions list, newest first, each session with its latest job's run: the overview lists only the latest jobs. */
export async function loadBacktestSessionsPage(filters: BacktestSessionsPageFilters): Promise<BacktestSessionsPage> {
  const [rows, total, symbols]: [SessionRow[], number, string[]] = await Promise.all([
    whereSessionsMatch(selectSessionRows(), filters)
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(filters.limit)
      .offset(filters.offset),
    countRows(whereSessionsMatch(db("backtest_sessions"), filters)),
    listSessionSymbols(),
  ]);
  const latestRuns = await loadLatestSessionRunStates(rows.map((row) => row.id));
  return { sessions: rows.map((row) => toSessionListItem(row, latestRuns.get(row.id) ?? null)), total, limit: filters.limit, offset: filters.offset, symbols };
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
  spy_baseline_value: string | null;
  spy_baseline_daily_return: string | null;
  decision_summary: string | null;
  looks_run: number | null;
  actions_taken: number | null;
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
      "spy_baseline_value",
      "spy_baseline_daily_return",
      "decision_summary",
      "looks_run",
      "actions_taken",
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
    spyBaselineValue: nullableNumber(row.spy_baseline_value),
    spyBaselineDailyReturn: nullableNumber(row.spy_baseline_daily_return),
    drawdown: drawdowns[index]!,
    decisionSummary: row.decision_summary,
    looksRun: row.looks_run === null ? null : Number(row.looks_run),
    actionsTaken: row.actions_taken === null ? null : Number(row.actions_taken),
  }));
}

function toTrade(row: Record<string, unknown>): BacktestTrade {
  const number = (column: string) => Number(row[column]);
  const optionalNumber = (column: string) => nullableNumber(row[column] as string | null);
  const cycleNumber = (row.cycle_number as number | null) ?? null;
  return {
    id: number("id"),
    symbol: row.symbol as string,
    legId: (row.leg_id as string | null) ?? null,
    endedBy: (row.ended_by as BacktestTrade["endedBy"]) ?? null,
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
    grade: (row.grade as string | null) ?? null,
    edgeMargin: optionalNumber("edge_margin"),
    expectedPnlDollars: optionalNumber("expected_pnl_dollars"),
    calibratedExpectedPnlDollars: optionalNumber("calibrated_expected_pnl_dollars"),
    edgeYield: optionalNumber("edge_yield"),
    histYield: optionalNumber("hist_yield"),
    kellyContracts: optionalNumber("kelly_contracts"),
    stressContracts: optionalNumber("stress_contracts"),
    settledOn: (row.settled_on as string | null) ?? null,
    settlementClose: optionalNumber("settlement_close"),
    inTheMoneyAtExpiry: (row.in_the_money_at_expiry as boolean | null) ?? null,
    pnlDollars: optionalNumber("pnl_dollars"),
    positionId: (row.position_id as string | null) ?? null,
    positionStatus: (row.position_status as BacktestTrade["positionStatus"]) ?? null,
    positionPnlDollars: optionalNumber("position_pnl_dollars"),
    cycleNumber: cycleNumber === null ? null : Number(cycleNumber),
    cycleLabel: cycleNumber === null ? null : describeCycle(row.symbol as string, Number(cycleNumber)),
    cycleStatus: (row.cycle_status as BacktestTrade["cycleStatus"]) ?? null,
    cycleTotalDollars: optionalNumber("cycle_total_dollars"),
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

/** The splits the engine found for the session's symbols inside its period (its cached schedule per symbol); null before any run analysed one of the files. */
function detectedSplitsInPeriod(symbols: readonly string[], startDateIso: string, endDateIso: string): BacktestSessionDetail["session"]["detectedSplits"] {
  const dataDirectory = readBacktestDataDirectory();
  const caches = symbols.flatMap((symbol) => {
    const cache = dataDirectory ? readSplitScheduleCache(dataDirectory, symbol) : null;
    return cache ? [{ symbol, cache }] : [];
  });
  if (caches.length === 0) return null;
  return caches.flatMap(({ symbol, cache }) => cache.schedule.splits.filter((split) => split.lastDayBefore >= startDateIso && split.firstDayAfter <= endDateIso).map((split) => ({ symbol, ...split })));
}

const isoTime = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The session's simulated positions with their legs, in the order the simulated book created them. */
async function loadSessionPositions(sessionId: string): Promise<BacktestPositionRecord[]> {
  const [positionRows, legRows]: [Record<string, unknown>[], Record<string, unknown>[]] = await Promise.all([
    db("backtest_positions").where({ session_id: sessionId }).orderBy("sequence"),
    db("backtest_position_legs").where({ session_id: sessionId }).orderBy("sequence").select("*", db.raw("expiry_date::text as expiry_date")),
  ]);
  const legsByPositionId = new Map<string, BacktestPositionLeg[]>();
  for (const row of legRows) {
    const leg: BacktestPositionLeg = {
      legId: row.leg_id as string,
      parentLegId: (row.parent_leg_id as string | null) ?? null,
      legType: row.leg_type as BacktestPositionLeg["legType"],
      side: row.side as BacktestPositionLeg["side"],
      quantity: Number(row.quantity),
      optionType: (row.option_type as BacktestPositionLeg["optionType"]) ?? null,
      strike: nullableNumber(row.strike_price as string | null),
      expiry: (row.expiry_date as string | null) ?? null,
      multiplier: Number(row.multiplier),
      entryPrice: Number(row.entry_price),
      entryAt: isoTime(row.entry_at as Date)!,
      exitPrice: nullableNumber(row.exit_price as string | null),
      exitAt: isoTime(row.exit_at as Date | null),
      settledAs: (row.settled_as as BacktestPositionLeg["settledAs"]) ?? null,
      expiryClose: nullableNumber(row.expiry_close as string | null),
      dteAtEntry: nullableNumber(row.dte_at_entry as number | null),
      realizedPnlDollars: nullableNumber(row.realized_pnl_dollars as string | null),
      priceScale: Number(row.price_scale),
    };
    const positionId = row.position_id as string;
    legsByPositionId.set(positionId, [...(legsByPositionId.get(positionId) ?? []), leg]);
  }
  return positionRows.map((row) => ({
    positionId: row.position_id as string,
    symbol: row.symbol as string,
    strategyKey: row.strategy_key as BacktestPosition["strategyKey"],
    status: row.status as BacktestPosition["status"],
    openedAt: isoTime(row.opened_at as Date)!,
    closedAt: isoTime(row.closed_at as Date | null),
    closeReason: (row.close_reason as string | null) ?? null,
    unstructuredReason: (row.unstructured_reason as string | null) ?? null,
    capitalAtRiskDollars: nullableNumber(row.capital_at_risk_dollars as string | null),
    capitalDeployedDollars: nullableNumber(row.capital_deployed_dollars as string | null),
    realizedPnlDollars: Number(row.realized_pnl_dollars),
    realizedPremiumPnlDollars: Number(row.realized_premium_pnl_dollars),
    realizedStockPnlDollars: Number(row.realized_stock_pnl_dollars),
    unrealizedPnlDollars: nullableNumber(row.unrealized_pnl_dollars as string | null),
    shareSourcePositionIds: row.share_source_position_ids as string[],
    legs: legsByPositionId.get(row.position_id as string) ?? [],
  }));
}

function toFill(row: Record<string, unknown>): BacktestFill {
  return {
    fillId: row.fill_id as string,
    positionId: row.position_id as string,
    legId: row.leg_id as string,
    symbol: row.symbol as string,
    instrument: row.instrument as BacktestFill["instrument"],
    side: row.side as BacktestFill["side"],
    quantity: Number(row.quantity),
    multiplier: Number(row.multiplier),
    price: Number(row.price),
    priceScale: Number(row.price_scale),
    commissionDollars: Number(row.commission_dollars),
    executedAt: isoTime(row.executed_at as Date)!,
    tradingDate: row.trading_date as string,
    isClosing: row.is_closing as boolean,
    actionId: (row.action_id as string | null) ?? null,
  };
}

function toAction(row: Record<string, unknown>): BacktestAction {
  return {
    actionId: row.action_id as string,
    tradingDate: row.trading_date as string,
    at: isoTime(row.at as Date)!,
    // A session run before looks were replayed has only the 10:00 look.
    lookTimeEt: (row.look_time as string | null) ?? backtestCaptureLookTimeEt,
    passNumber: Number(row.pass_number),
    symbol: row.symbol as string,
    kind: row.kind as BacktestAction["kind"],
    candidateId: row.candidate_id as string,
    description: row.description as string,
    automatic: row.automatic as boolean,
    chosenBecause: row.chosen_because as string,
    outcome: row.outcome as BacktestAction["outcome"],
    blockReason: (row.block_reason as string | null) ?? null,
    gateResults: row.gate_results as BacktestAction["gateResults"],
    contract: (row.contract as BacktestAction["contract"]) ?? null,
    candidateScores: (row.candidate_scores as Record<string, unknown> | null) ?? null,
    quantity: nullableNumber(row.quantity as string | null),
    limitPrice: nullableNumber(row.limit_price as string | null),
    fillPrice: nullableNumber(row.fill_price as string | null),
    positionIds: row.position_ids as string[],
  };
}

/** The session's rows of one book table that the filters match, in the order the simulated book wrote them. */
function filteredBookRows(table: "backtest_actions" | "backtest_fills", sessionId: string, filters: BacktestBookPageFilters): Knex.QueryBuilder {
  const query = db(table).where({ session_id: sessionId });
  if (filters.from !== null) void query.where("trading_date", ">=", filters.from);
  if (filters.to !== null) void query.where("trading_date", "<=", filters.to);
  if (filters.symbol !== null) void query.where({ symbol: filters.symbol });
  if (filters.outcome !== null && table === "backtest_actions") void query.where({ outcome: filters.outcome });
  return query;
}

async function requireSessionExists(sessionId: string): Promise<void> {
  if (!(await db("backtest_sessions").where({ id: sessionId }).first("id"))) throw new BacktestRequestError("No such session.", 404);
}

async function countRows(query: Knex.QueryBuilder): Promise<number> {
  const rows: { count: string | number }[] = await query.count("* as count");
  return Number(rows[0]?.count ?? 0);
}

/** One page of the actions a session took or was refused, oldest first. */
export async function loadBacktestSessionActions(sessionId: string, filters: BacktestBookPageFilters): Promise<BacktestActionsPage> {
  await requireSessionExists(sessionId);
  const [rows, total]: [Record<string, unknown>[], number] = await Promise.all([
    filteredBookRows("backtest_actions", sessionId, filters).orderBy("sequence").limit(filters.limit).offset(filters.offset).select("*", db.raw("trading_date::text as trading_date")),
    countRows(filteredBookRows("backtest_actions", sessionId, filters)),
  ]);
  return { actions: rows.map(toAction), total, limit: filters.limit, offset: filters.offset };
}

/** One page of a session's fills, oldest first. */
export async function loadBacktestSessionFills(sessionId: string, filters: BacktestBookPageFilters): Promise<BacktestFillsPage> {
  await requireSessionExists(sessionId);
  const [rows, total]: [Record<string, unknown>[], number] = await Promise.all([
    filteredBookRows("backtest_fills", sessionId, filters).orderBy("sequence").limit(filters.limit).offset(filters.offset).select("*", db.raw("trading_date::text as trading_date")),
    countRows(filteredBookRows("backtest_fills", sessionId, filters)),
  ]);
  return { fills: rows.map(toFill), total, limit: filters.limit, offset: filters.offset };
}

async function loadSessionBookCounts(sessionId: string): Promise<BacktestSessionDetail["bookCounts"]> {
  const [filledActions, blockedActions, fills] = await Promise.all([
    countRows(db("backtest_actions").where({ session_id: sessionId, outcome: "filled" })),
    countRows(db("backtest_actions").where({ session_id: sessionId, outcome: "blocked" })),
    countRows(db("backtest_fills").where({ session_id: sessionId })),
  ]);
  return { filledActions, blockedActions, fills };
}

async function loadSessionCycles(sessionId: string): Promise<BacktestCycle[]> {
  const rows: Record<string, unknown>[] = await db("backtest_cycles")
    .where({ session_id: sessionId })
    .orderBy([{ column: "symbol" }, { column: "cycle_number" }])
    .select("*", db.raw("opened_on::text as opened_on"), db.raw("closed_on::text as closed_on"), db.raw("assigned_on::text as assigned_on"));
  return rows.map((row) => ({
    symbol: row.symbol as string,
    cycleNumber: Number(row.cycle_number),
    status: row.status as BacktestCycle["status"],
    openedAt: isoTime(row.opened_at as Date)!,
    closedAt: isoTime(row.closed_at as Date | null),
    openedOn: row.opened_on as string,
    closedOn: (row.closed_on as string | null) ?? null,
    assignedOn: (row.assigned_on as string | null) ?? null,
    recoverySessions: nullableNumber(row.recovery_sessions as number | null),
    ageSessions: nullableNumber(row.age_sessions as number | null),
    totalDollars: Number(row.total_dollars),
    netPremiumDollars: Number(row.net_premium_dollars),
    sharesHeld: Number(row.shares_held),
    breakEvenPerShare: nullableNumber(row.break_even_per_share as string | null),
    buckets: row.buckets as BacktestCycle["buckets"],
    dataFlags: row.data_flags as string[],
  }));
}

/** Per ticker in its turn order (alphabetical), the looks and days at which the cash cut one of its orders (backtest_look_shortfalls). */
async function loadCashBoundBySymbol(sessionId: string, symbols: readonly string[]): Promise<{ symbol: string; looks: number; days: number }[]> {
  const rows: { symbol: string; looks: string; days: string }[] = await db("backtest_look_shortfalls")
    .where({ session_id: sessionId, reason: "cash" })
    .groupBy("symbol")
    .select("symbol", db.raw("sum(look_count) as looks"), db.raw("count(distinct trading_date) as days"));
  return [...symbols].sort().map((symbol) => {
    const found = rows.find((entry) => entry.symbol === symbol);
    return { symbol, looks: Number(found?.looks ?? 0), days: Number(found?.days ?? 0) };
  });
}

/**
 * A session as its screen reads it. With `onlySymbol` the option sales, positions, cycles and statistics are that
 * symbol's alone (the account's days and metrics are always the whole book's).
 */
export async function loadBacktestSessionDetail(sessionId: string, onlySymbol: string | null = null): Promise<BacktestSessionDetail> {
  const row = await loadSessionRow(sessionId);
  const ofSymbol = <Row extends { symbol: string }>(rows: Row[]): Row[] => (onlySymbol === null ? rows : rows.filter((entry) => entry.symbol === onlySymbol));
  const [dayRows, tradeRows, job, everyPositionRecord, everyCycle, bookCounts, cashBoundBySymbol] = await Promise.all([
    loadSessionDayRows([sessionId]),
    db("backtest_trades")
      .where({ session_id: sessionId })
      .orderBy([{ column: "backtest_trades.opened_on" }, { column: "backtest_trades.id" }])
      // The date columns as text, listed after "*" so they replace the Date values.
      .select("*", db.raw("opened_on::text as opened_on"), db.raw("expiry::text as expiry"), db.raw("settled_on::text as settled_on")),
    loadLatestJobViewForSession(sessionId),
    loadSessionPositions(sessionId),
    loadSessionCycles(sessionId),
    loadSessionBookCounts(sessionId),
    row.book_mode === "pots" ? loadCashBoundBySymbol(sessionId, symbolsOf(row)) : null,
  ]);
  const days = toSessionDays(dayRows);
  // A row stored before trades named their symbol belongs to the session's one symbol.
  const trades = ofSymbol(tradeRows.map((tradeRow: Record<string, unknown>) => toTrade({ ...tradeRow, symbol: tradeRow.symbol ?? row.symbol })));
  const positions = ofSymbol(everyPositionRecord.map((position) => withPositionCycle(position, everyCycle)));
  const cycles = ofSymbol(everyCycle);
  return {
    session: {
      ...toSessionListItem(row),
      settingsSnapshot: row.settings_snapshot,
      overrides: row.overrides,
      bookMode: row.book_mode,
      symbolSettings: row.symbol_settings,
      cashBoundBySymbol,
      pnlBasis: row.pnl_basis,
      baselineMetrics: row.baseline_metrics,
      baselineLabel: `Buy and hold · ${row.symbol}`,
      spyBaselineMetrics: row.spy_baseline_metrics,
      spyBaselineLabel: spyBaselineLabel,
      detectedSplits: detectedSplitsInPeriod(symbolsOf(row), row.start_date, row.end_date),
      dataLastDate: row.data_last_date,
      error: row.error,
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      notes: row.notes ?? [],
      runStatistics: row.run_statistics,
    },
    job,
    days,
    trades,
    monthlyReturns: computeMonthlyReturns(days, Number(row.starting_value)),
    // Measured on the wheel cycles; a session run before cycles carried the P&L keeps its per-option table.
    accuracyByMarginBand: row.pnl_basis === "wheel_cycle" ? computeCycleAccuracyBands(cycleFiguresOf(cycles, trades)) : computeTradeAccuracyBands(trades.map(toClosedTradeFigures)),
    positions,
    cycles,
    tickerStatistics: computeTickerStatistics(positions, cycles),
    allSymbolsStatistics: computeAllSymbolsStatistics(positions, cycles),
    bookCounts,
  };
}

/**
 * Account value curves for the sessions, in the order asked, plus one buy-and-hold curve per distinct set of symbols
 * with their dollars (pots, or equal parts of the starting value) and period (buy and hold depends on nothing else),
 * keyed by the first such session.
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
    // Each symbol's dollars: its pot, or an equal part of the starting value.
    const dollarsBySymbol = symbolsOf(row).map((symbol) => `${symbol}:${row.symbol_settings?.[symbol]?.potDollars ?? Number(row.starting_value) / symbolsOf(row).length}`);
    const baselineIdentity = `${dollarsBySymbol.sort().join(",")}|${row.start_date}|${row.end_date}`;
    if (baselineKeys.has(baselineIdentity)) continue;
    baselineKeys.add(baselineIdentity);
    curves.push({
      key: `baseline:${row.id}`,
      label: `Buy and hold · ${row.symbol}`,
      points: (daysBySession.get(row.id) ?? []).map((day) => ({ tradingDate: day.trading_date, value: Number(day.baseline_value) })),
    });
  }
  // Buy and hold of SPY depends only on the period and the starting value: one curve for the sessions that share them.
  const spyBaselineKeys = new Set<string>();
  for (const row of rowsInAskedOrder) {
    const days = daysBySession.get(row.id) ?? [];
    if (days.length === 0 || days.some((day) => day.spy_baseline_value === null)) continue;
    const spyIdentity = `${row.start_date}|${row.end_date}|${Number(row.starting_value)}`;
    if (spyBaselineKeys.has(spyIdentity)) continue;
    spyBaselineKeys.add(spyIdentity);
    curves.push({ key: `spy:${row.id}`, label: spyBaselineLabel, points: days.map((day) => ({ tradingDate: day.trading_date, value: Number(day.spy_baseline_value) })) });
  }

  return {
    sessions: rowsInAskedOrder.map((row) => ({ ...toSessionListItem(row), overrides: row.overrides, baselineMetrics: row.baseline_metrics, spyBaselineMetrics: row.spy_baseline_metrics })),
    curves,
  };
}

/** Stores the session (snapshot and changed values only), creates its backtest job and starts the job's process. */
export async function createBacktestSession(request: ValidatedBacktestSessionRequest, snapshot: BacktestSettings): Promise<{ session: BacktestSessionListItem; job: BacktestJobView }> {
  const { sessionId, jobId } = await db.transaction(async (transaction) => {
    const [session] = await transaction("backtest_sessions")
      .insert({
        name: request.name,
        symbol: describeSessionSymbols(request.symbols),
        symbols: JSON.stringify(request.symbols),
        start_date: request.startDate,
        end_date: request.endDate,
        starting_value: request.startingValue,
        tables_mode: request.tablesMode,
        settings_snapshot: JSON.stringify(snapshot),
        overrides: JSON.stringify(request.overrides),
        book_mode: request.bookMode,
        symbol_settings: request.symbolSettings === null ? null : JSON.stringify(request.symbolSettings),
        status: "queued",
      })
      .returning("id");
    const createdJobId = await insertClaimedBacktestJob(session.id as string, describeSessionSymbols(request.symbols), transaction);
    return { sessionId: session.id as string, jobId: createdJobId };
  });
  await startClaimedBacktestJob(jobId);
  return { session: toSessionListItem(await loadSessionRow(sessionId)), job: await loadBacktestJobView(jobId) };
}

/** Deletes a session with its days, trades, simulated book and jobs; an unfinished job is stopped first. */
export async function deleteBacktestSession(sessionId: string): Promise<void> {
  await loadSessionRow(sessionId);
  await stopJobsOfSession(sessionId);
  await db("backtest_sessions").where({ id: sessionId }).del();
}
