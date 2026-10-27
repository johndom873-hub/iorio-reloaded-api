import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { applyBacktestOverrides, countBacktestOverrides } from "../backtestSettingsOverrides.js";
import { combineBatchRuns, type CombinedRunInput } from "../batchCombined.js";
import type {
  BacktestAction,
  BacktestActionsPage,
  BacktestBatchCombined,
  BacktestBatchDetail,
  BacktestBatchSummary,
  BacktestCompareResponse,
  BacktestCycle,
  BacktestCycleTimelineRow,
  BacktestLadderRungRecord,
  BacktestCycleDetail,
  BacktestCycleGap,
  BacktestFill,
  BacktestFillsPage,
  BacktestJobStatus,
  BacktestJobView,
  BacktestMetrics,
  BacktestNoCallRun,
  BacktestNoSaleDays,
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
  BacktestSettingsSource,
  BacktestSymbolSettings,
  BacktestTablesMode,
  BacktestTrade,
  BacktestBookMode,
} from "../backtestTypes.js";
import { ladderRungReached } from "../engine/backtestBaselineLadder.js";
import { hedgePutCostYield } from "../engine/baselineSaleSteps.js";
import { optionCommissionDollars } from "../engine/ledger/ledgerFills.js";
import { loadLadderRungs } from "../analysis/analysisBacktest.js";
import { loadSessionFreeCash } from "../analysis/sessionFreeCash.js";
import { backtestCaptureLookTimeEt, backtestEngineVersion } from "../backtestTypes.js";
import { computeCycleAccuracyBands, computeDrawdowns, computeMonthlyReturns, computePnlSources, computeTradeAccuracyBands, cycleFiguresOf, type ClosedTradeFigures } from "../sessionAnalytics.js";
import { computeAllSymbolsStatistics, computeTickerStatistics } from "../tickerStatistics.js";
import { BacktestRequestError, insertQueuedBacktestJob, kickBacktestQueue, loadBacktestJobView, loadLatestJobViewForSession, loadLatestSessionRunStates, stopJobsOfSession } from "./backtestJobStore.js";
import type { BacktestBookPageFilters, BacktestSessionsPageFilters, ValidatedBacktestSessionRequest } from "./backtestSessionRequest.js";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { sqlContainsPattern } from "../../lib/sqlContainsPattern.js";
import { readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { cachedSplitsBetween, readSplitScheduleCache, splitFactorOn } from "../engine/splitFactors.js";
import { withPositionCycle, type BacktestPositionRecord } from "../engine/backtestSessionRecords.js";
import { cashBreakEvenBeforeEachRow, cycleCashBreakEven, sharesHeldAfterEachMoment, sharesHeldAtInstant, sharesHeldAtMarks, type CashBreakEvenOptions, type SplitFactorOfDay } from "../cycleCashBreakEven.js";
import { withHedgeMarkedAtHandOvers, type HedgePutMarkOf } from "../cycleHedgeHandOvers.js";
import { cycleNoCallDays, recordedRunReasons, volFarmerNoteOn, volFarmerRunReasons } from "../cycleNoCallDays.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";

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
  settings_source: BacktestSettingsSource | null;
  pots_from_starting_value: boolean | null;
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
  batch_id: string | null;
  run_number: number | null;
  batch_name: string | null;
  batch_run_count: number | string;
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
    "settings_source",
    "pots_from_starting_value",
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
    "batch_id",
    "run_number",
    connection.raw("(select batch.name from backtest_batches batch where batch.id = backtest_sessions.batch_id) as batch_name"),
    connection.raw("(select count(*) from backtest_sessions run where run.batch_id = backtest_sessions.batch_id) as batch_run_count"),
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
    batch: row.batch_id === null ? null : { id: row.batch_id, name: row.batch_name ?? "", runNumber: Number(row.run_number), runCount: Number(row.batch_run_count) },
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

/**
 * The sessions the filters match, each with its Sessions list entry: a batch of two or more runs is one entry ("b:<id>"),
 * any other session its own ("s:<id>").
 */
function matchedSessionEntries(filters: BacktestSessionsPageFilters): Knex.QueryBuilder {
  return whereSessionsMatch(db("backtest_sessions"), filters).select(
    "backtest_sessions.id",
    "backtest_sessions.created_at",
    db.raw(`CASE WHEN backtest_sessions.batch_id IS NOT NULL AND (SELECT count(*) FROM backtest_sessions run WHERE run.batch_id = backtest_sessions.batch_id) > 1
      THEN 'b:' || backtest_sessions.batch_id ELSE 's:' || backtest_sessions.id END AS entry_key`),
  );
}

/**
 * One page of the Sessions list, newest entry first: a session, or a batch with its matching runs by run number. Each
 * session carries its latest job's run: the overview lists only the latest jobs.
 */
export async function loadBacktestSessionsPage(filters: BacktestSessionsPageFilters): Promise<BacktestSessionsPage> {
  const [entries, totalRows, symbols] = await Promise.all([
    db
      .from(matchedSessionEntries(filters).as("matched"))
      .groupBy("entry_key")
      .select("entry_key", db.raw("max(created_at) as latest"))
      .orderBy([
        { column: "latest", order: "desc" },
        { column: "entry_key", order: "desc" },
      ])
      .limit(filters.limit)
      .offset(filters.offset) as Promise<{ entry_key: string }[]>,
    db.from(matchedSessionEntries(filters).as("matched")).countDistinct("entry_key as count") as Promise<{ count: string | number }[]>,
    listSessionSymbols(),
  ]);
  const entryKeys = entries.map((entry) => entry.entry_key);
  const members: { id: string; entry_key: string }[] = entryKeys.length === 0 ? [] : await db.from(matchedSessionEntries(filters).as("matched")).whereIn("entry_key", entryKeys).select("id", "entry_key");
  const rows: SessionRow[] = members.length === 0 ? [] : await selectSessionRows().whereIn("id", members.map((member) => member.id));
  const entryOf = new Map(members.map((member) => [member.id, member.entry_key]));
  const entryOrder = new Map(entryKeys.map((key, index) => [key, index]));
  const ordered = [...rows].sort((a, b) => entryOrder.get(entryOf.get(a.id)!)! - entryOrder.get(entryOf.get(b.id)!)! || (a.run_number ?? 0) - (b.run_number ?? 0));
  const latestRuns = await loadLatestSessionRunStates(ordered.map((row) => row.id));
  return { sessions: ordered.map((row) => toSessionListItem(row, latestRuns.get(row.id) ?? null)), total: Number(totalRows[0]?.count ?? 0), limit: filters.limit, offset: filters.offset, symbols };
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
  const found = symbols.flatMap((symbol) => {
    const splits = cachedSplitsBetween(dataDirectory, symbol, startDateIso, endDateIso);
    return splits ? [{ symbol, splits }] : [];
  });
  if (found.length === 0) return null;
  return found.flatMap(({ symbol, splits }) => splits.map((split) => ({ symbol, ...split })));
}

const isoTime = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The session's simulated positions with their legs, in the order the simulated book created them. */
/** The session's positions with their legs; with `symbol`, that symbol's only. */
async function loadSessionPositions(sessionId: string, symbol: string | null = null): Promise<BacktestPositionRecord[]> {
  const symbolPositionIds = () => db("backtest_positions").where({ session_id: sessionId, symbol }).select("position_id");
  const [positionRows, legRows]: [Record<string, unknown>[], Record<string, unknown>[]] = await Promise.all([
    db("backtest_positions")
      .where({ session_id: sessionId })
      .modify((query) => (symbol === null ? query : query.where({ symbol })))
      .orderBy("sequence"),
    db("backtest_position_legs")
      .where({ session_id: sessionId })
      .modify((query) => (symbol === null ? query : query.whereIn("position_id", symbolPositionIds())))
      .orderBy("sequence")
      .select("*", db.raw("expiry_date::text as expiry_date")),
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

/** A session's option sales, in the order sold. */
async function loadSessionTradeRows(sessionId: string): Promise<Record<string, unknown>[]> {
  return db("backtest_trades")
    .where({ session_id: sessionId })
    .orderBy([{ column: "backtest_trades.opened_on" }, { column: "backtest_trades.id" }])
    // The date columns as text, listed after "*" so they replace the Date values.
    .select("*", db.raw("opened_on::text as opened_on"), db.raw("expiry::text as expiry"), db.raw("settled_on::text as settled_on"));
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

// A cycle's timeline and stock-only stretches are read only when its row is opened (loadBacktestCycleDetail).
const cycleSummaryColumns = ["symbol", "cycle_number", "status", "opened_at", "closed_at", "recovery_sessions", "age_sessions", "total_dollars", "net_premium_dollars", "shares_held", "break_even_per_share", "buckets", "data_flags"];

/** Whether a session counts its hedge's realized P&L in its cycles' break-even (baseline hedgeInBreakEven "included"). */
/** True for a session run by the Vol Farmer: its cycles mark the hedge at every hand-over of the shares (cycleHedgeHandOvers.ts). */
async function isVolFarmerSession(sessionId: string): Promise<boolean> {
  const row: { settings_snapshot: BacktestSettings; overrides: BacktestSettingsOverrides | null } | undefined = await db("backtest_sessions").where({ id: sessionId }).first("settings_snapshot", "overrides");
  return row !== undefined && applyBacktestOverrides(row.settings_snapshot, row.overrides ?? {}).decisionMaker === "vol_farmer";
}

/** A symbol's Put prices from its data file's end-of-day quotes: the closing mid, else the last trade, else the intrinsic value at the stock's close. Close it when done. */
function hedgePutMarksFromFile(symbol: string): { markOf: HedgePutMarkOf; close(): void } {
  const file = openBacktestDataFileReadOnly(symbol);
  const statement = file?.prepare("SELECT bid, ask, close FROM eod WHERE trading_date = ? AND expiry = ? AND option_right = 'P' AND abs(strike - ?) < 0.0005") ?? null;
  return {
    markOf: (tradingDate, expiry, strikeAsTraded, stockCloseAsTraded) => {
      const quote = statement?.get(tradingDate, expiry, strikeAsTraded) as { bid: number | null; ask: number | null; close: number | null } | undefined;
      if (quote && quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask >= quote.bid) return (quote.bid + quote.ask) / 2;
      if (quote && quote.close !== null && quote.close > 0) return quote.close;
      return stockCloseAsTraded === null ? null : Math.max(0, strikeAsTraded - stockCloseAsTraded);
    },
    close: () => file?.close(),
  };
}

/**
 * How the session's Wheel cycles read the break-even: a Vol Farmer's as its hedge rule does (Marcelo 2026-10-27), the
 * hedge's realized P&L in and the Calls' premium only where the rule counts it; any other with the baseline's
 * hedgeInBreakEven.
 */
async function breakEvenOptionsOf(sessionId: string): Promise<CashBreakEvenOptions> {
  const row: { settings_snapshot: BacktestSettings; overrides: BacktestSettingsOverrides | null } | undefined = await db("backtest_sessions").where({ id: sessionId }).first("settings_snapshot", "overrides");
  if (row === undefined) return {};
  const settings = applyBacktestOverrides(row.settings_snapshot, row.overrides ?? {});
  if (settings.decisionMaker === "vol_farmer") return { hedgeRealizedPnlIncluded: true, optionPremiumsIncluded: settings.volFarmer.hedgeRuleCallPremiums === "included" };
  return { hedgeRealizedPnlIncluded: settings.baseline.hedgeInBreakEven === "included" };
}

async function loadSessionCycles(sessionId: string): Promise<BacktestCycle[]> {
  const breakEvenOptions = await breakEvenOptionsOf(sessionId);
  const rows: Record<string, unknown>[] = await db("backtest_cycles")
    .where({ session_id: sessionId })
    .orderBy([{ column: "symbol" }, { column: "cycle_number" }])
    .select(...cycleSummaryColumns, db.raw("opened_on::text as opened_on"), db.raw("closed_on::text as closed_on"), db.raw("assigned_on::text as assigned_on"), db.raw("case when status = 'open' then timeline end as open_timeline"));
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
    cashBreakEvenPerShare: row.open_timeline ? (breakEvenOptions.hedgeRealizedPnlIncluded ? cycleCashBreakEven(row.open_timeline as BacktestCycleTimelineRow[], splitFactorOfDayFor(row.symbol as string), breakEvenOptions) : cycleCashBreakEven(row.open_timeline as BacktestCycleTimelineRow[])) : null,
    sharesHeldNow: row.open_timeline ? sharesHeldAtMarks(row.open_timeline as BacktestCycleTimelineRow[]) : null,
    buckets: row.buckets as BacktestCycle["buckets"],
    dataFlags: row.data_flags as string[],
  }));
}

/** Each symbol's stretches with no cycle open, symbol by symbol, oldest first. */
async function loadSessionCycleGaps(sessionId: string): Promise<BacktestCycleGap[]> {
  const rows: Record<string, unknown>[] = await db("backtest_cycle_gaps")
    .where({ session_id: sessionId })
    .orderBy([{ column: "symbol" }, { column: "backtest_cycle_gaps.first_idle_day" }])
    .select("symbol", "after_cycle_number", "before_cycle_number", "idle_sessions", "stock_move", "no_sale_days", "entry_filter_limits", "no_candidate", db.raw("first_idle_day::text as first_idle_day"), db.raw("last_idle_day::text as last_idle_day"));
  return rows.map((row) => ({
    symbol: row.symbol as string,
    afterCycleNumber: nullableNumber(row.after_cycle_number as number | null),
    beforeCycleNumber: nullableNumber(row.before_cycle_number as number | null),
    firstIdleDay: row.first_idle_day as string,
    lastIdleDay: row.last_idle_day as string,
    idleSessions: Number(row.idle_sessions),
    stockMove: nullableNumber(row.stock_move as string | null),
    noSaleDays: row.no_sale_days as BacktestNoSaleDays,
    entryFilterLimits: row.entry_filter_limits as BacktestCycleGap["entryFilterLimits"],
    noCandidate: (row.no_candidate as BacktestCycleGap["noCandidate"] | null) ?? null,
  }));
}

/**
 * A symbol's split factor by day from the engine's cached schedule, to put a timeline's shares on one scale: a day the
 * schedule leaves unresolved takes its segment's factor, and without a schedule every day is 1 (no split known).
 */
function splitFactorOfDayFor(symbol: string): SplitFactorOfDay {
  const dataDirectory = readBacktestDataDirectory();
  const schedule = dataDirectory ? (readSplitScheduleCache(dataDirectory, symbol)?.schedule ?? null) : null;
  if (!schedule || schedule.segments.length === 0) return () => 1;
  return (tradingDate) => splitFactorOn(schedule, tradingDate) ?? schedule.segments.findLast((segment) => segment.fromDateIso <= tradingDate)?.factor ?? schedule.segments[0]!.factor;
}

/** A cycle's timeline and stock-only stretches; null for a session run before cycles kept them. Throws 404 for a cycle the session does not have. */
export async function loadBacktestCycleDetail(sessionId: string, symbol: string, cycleNumber: number): Promise<BacktestCycleDetail | null> {
  await requireSessionExists(sessionId);
  const row: { timeline: BacktestCycleDetail["timeline"] | null; stock_only_stretches: BacktestCycleDetail["stockOnlyStretches"] | null } | undefined = await db("backtest_cycles")
    .where({ session_id: sessionId, symbol, cycle_number: cycleNumber })
    .first("timeline", "stock_only_stretches");
  if (!row) throw new BacktestRequestError(`The session has no cycle ${symbol} #${cycleNumber}.`, 404);
  if (row.timeline === null) return null;
  const sales = await loadSaleRecords(sessionId, symbol, row.timeline);
  const hedgePurchases = await loadHedgePurchaseRecords(sessionId, symbol, row.timeline);
  const crossingInstants = await loadVolFarmerCrossingInstants(sessionId, symbol, row.timeline);
  const splitFactorOf = splitFactorOfDayFor(symbol);
  const breakEvens = cashBreakEvenBeforeEachRow(row.timeline, splitFactorOf, await breakEvenOptionsOf(sessionId));
  const sharesHeld = sharesHeldAfterEachMoment(row.timeline, splitFactorOf);
  // A Vol Farmer cycle shows its hedge marked at every hand-over of the shares; what the cycle reads per moment (break-even,
  // shares held) stays the stored timeline's, through each shown row's source row.
  let shown: { rows: BacktestCycleDetail["timeline"]; sourceIndexes: number[] } = { rows: row.timeline, sourceIndexes: row.timeline.map((_, index) => index) };
  const volFarmer = await isVolFarmerSession(sessionId);
  if (volFarmer) {
    const marks = hedgePutMarksFromFile(symbol);
    try {
      shown = withHedgeMarkedAtHandOvers(row.timeline, marks.markOf, splitFactorOf);
    } finally {
      marks.close();
    }
  }
  const stretches = row.stock_only_stretches ?? [];
  const dates = [...row.timeline.map((entry) => entry.tradingDate), ...stretches.map((stretch) => stretch.firstIdleDay)].sort();
  const freeCash = dates.length > 0 ? await loadSessionFreeCash(sessionId, dates[0]!, dates.at(-1)!) : null;
  return {
    timeline: shown.rows.map((entry, shownIndex) => {
      const index = shown.sourceIndexes[shownIndex]!;
      const isSourceRow = row.timeline![index] === entry;
      // A hedge's "Sold put" or a LEAPS' "Sold call" closes a long option: not a sale held to the break-even, with no yield or delta recorded.
      const sold = entry.bucket === "hedge" || entry.bucket === "leaps" ? null : /^Sold (put|call) @/.exec(entry.label);
      const freeCashShare = freeCash?.shareAfter(entry.tradingDate, entry.at) ?? null;
      const crossing = entry.at !== null && crossingInstants.has(Date.parse(entry.at)) ? { crossing: true } : {};
      // A hedge Put's purchase (a Vol Farmer cycle shows a copy of it, its cost moved to the hand-over marks).
      if (entry.bucket === "hedge" && entry.instrument === "option" && /^Bought put @/.test(entry.label)) return { ...entry, hedgeCostYield: hedgePurchases.costYieldOf(entry.tradingDate, entry.strike, entry.expiryDate), sharesHeld: sharesHeld[index]!, freeCashShare, ...crossing };
      if (!sold || entry.instrument !== "option" || !isSourceRow) return { ...entry, sharesHeld: sharesHeld[index]!, freeCashShare, ...crossing };
      const { premiumYield, delta, ladderRung, positionBreakEvens } = sales.recordedOf(entry.tradingDate, sold[1] === "put" ? "P" : "C", entry.strike, entry.expiryDate, entry.at);
      return { ...entry, premiumYield, delta, breakEvenAtSale: breakEvens[index]!, ...(positionBreakEvens ? { positionBreakEvens } : {}), sharesHeld: sharesHeld[index]!, ...(sold[1] === "put" ? { ladderRung } : {}), freeCashShare, ...crossing };
    }),
    // Stretches stored before their no-candidate detail was kept have none.
    // A stretch's shares from the cycle's own trades: stored before 2026-10-21 they came from the ledger's stock legs, which
    // count shares a later assignment added to a lot from the lot's start (NFLX #33: 200 shown from January, 100 held).
    stockOnlyStretches: stretches.map((stretch) => ({
      ...stretch,
      sharesHeld: sharesHeldAtInstant(row.timeline!, easternInstant(stretch.firstIdleDay, 0, 0).getTime(), stretch.firstIdleDay, splitFactorOf),
      noCandidate: stretch.noCandidate ?? null,
      freeCashShareAtStart: freeCash?.shareAtMark(stretch.firstIdleDay) ?? null,
    })),
    noCallRuns: await loadCycleNoCallRuns({ sessionId, symbol, cycleNumber, volFarmer, timeline: row.timeline, stretches, splitFactorOf }),
  };
}

/**
 * A cycle's No Call runs (cycleNoCallDays.ts): its days with shares and no Call from its positions' legs, the shares from
 * its own trades, and why no Call was sold from a Vol Farmer's day summaries, else the session's records of the calls on
 * the free shares and the cycle's stock-only stretches.
 */
async function loadCycleNoCallRuns(input: { sessionId: string; symbol: string; cycleNumber: number; volFarmer: boolean; timeline: readonly BacktestCycleTimelineRow[]; stretches: BacktestCycleDetail["stockOnlyStretches"]; splitFactorOf: SplitFactorOfDay }): Promise<BacktestNoCallRun[]> {
  const { sessionId, symbol, cycleNumber } = input;
  const cycleRows: Record<string, unknown>[] = await db("backtest_cycles").where({ session_id: sessionId, symbol }).select("cycle_number", "opened_at", "closed_at", db.raw("opened_on::text as opened_on"), db.raw("closed_on::text as closed_on"));
  const cycles = cycleRows.map((row) => ({ symbol, cycleNumber: Number(row.cycle_number), openedAt: isoTime(row.opened_at as Date)!, closedAt: isoTime(row.closed_at as Date | null), openedOn: row.opened_on as string, closedOn: (row.closed_on as string | null) ?? null }));
  const cycle = cycles.find((entry) => entry.cycleNumber === cycleNumber);
  if (!cycle) return [];
  const [positionRecords, dayRows]: [BacktestPositionRecord[], { trading_date: string; decision_summary: string | null }[]] = await Promise.all([
    loadSessionPositions(sessionId, symbol),
    db("backtest_session_days")
      .where({ session_id: sessionId })
      .where("trading_date", ">=", cycle.openedOn)
      .modify((query) => (cycle.closedOn === null ? query : query.where("trading_date", "<=", cycle.closedOn)))
      .orderBy("trading_date")
      .select(db.raw("trading_date::text as trading_date"), "decision_summary"),
  ]);
  const positions = positionRecords.map((position) => withPositionCycle(position, cycles)).filter((position) => position.cycleNumber === cycleNumber);
  const coverage = cycleNoCallDays({ sessionDays: dayRows.map((day) => day.trading_date), cycle, positions });
  const runDays = coverage.runs.flat();
  if (runDays.length === 0) return [];
  let reasonsOf: (days: string[]) => BacktestNoCallRun["reasons"];
  if (input.volFarmer) {
    const summaryOn = new Map(dayRows.map((day) => [day.trading_date, day.decision_summary]));
    reasonsOf = (days) => volFarmerRunReasons(days.map((date) => ({ date, note: volFarmerNoteOn(summaryOn.get(date) ?? null, symbol) })));
  } else {
    const recorded = await loadHeldCallReasonsByDay(sessionId, symbol, runDays[0]!, runDays.at(-1)!);
    reasonsOf = (days) => recordedRunReasons({ days, stretches: input.stretches, reasonsOn: (date) => [...(recorded.get(date) ?? [])] });
  }
  return coverage.runs.map((days) => {
    const firstDay = days[0]!;
    const lastDay = days.at(-1)!;
    const sharesAt = (hour: number, minute: number) => sharesHeldAtInstant(input.timeline, easternInstant(firstDay, hour, minute).getTime(), firstDay, input.splitFactorOf);
    return {
      firstDay,
      lastDay,
      sessions: days.length,
      sharesHeld: Math.max(sharesAt(0, 0), sharesAt(23, 59)),
      hedgePutDays: days.filter((day) => coverage.hedgePutDays.has(day)).length,
      reasons: reasonsOf(days),
      noCandidate: input.stretches.find((stretch) => stretch.firstIdleDay >= firstDay && stretch.lastIdleDay <= lastDay && stretch.noCandidate)?.noCandidate ?? null,
    };
  });
}

/**
 * Per day, what a session's looks recorded about the calls on a symbol's free shares, as backtestIdleStretches.ts reads
 * them while the session runs: their shortfalls, and a ladder put sold in their place (its reason, as baselineSaleSteps.ts
 * words it: "its yield … beats the best call's …", or "no call qualifies").
 */
async function loadHeldCallReasonsByDay(sessionId: string, symbol: string, fromDate: string, toDate: string): Promise<Map<string, Set<Exclude<keyof BacktestNoSaleDays, "unrecorded">>>> {
  const [shortfalls, ladderPuts]: [{ trading_date: string; reason: "cash" | "volume" | "no_candidate" }[], { trading_date: string; chosen_because: string }[]] = await Promise.all([
    db("backtest_look_shortfalls").where({ session_id: sessionId, symbol, step: "held_calls" }).whereBetween("trading_date", [fromDate, toDate]).select(db.raw("trading_date::text as trading_date"), "reason"),
    db("backtest_actions")
      .where({ session_id: sessionId, symbol, kind: "open_cash_secured_put", outcome: "filled" })
      .whereBetween("trading_date", [fromDate, toDate])
      .where((query) => query.where("chosen_because", "like", "%beats the best call's%").orWhere("chosen_because", "like", "%(no call qualifies)%"))
      .select(db.raw("trading_date::text as trading_date"), "chosen_because"),
  ]);
  const byDay = new Map<string, Set<Exclude<keyof BacktestNoSaleDays, "unrecorded">>>();
  const add = (date: string, reason: Exclude<keyof BacktestNoSaleDays, "unrecorded">) => byDay.set(date, (byDay.get(date) ?? new Set()).add(reason));
  const shortfallReason = { cash: "cash", volume: "volume", no_candidate: "noCandidate" } as const;
  for (const row of shortfalls) add(row.trading_date, shortfallReason[row.reason]);
  for (const row of ladderPuts) add(row.trading_date, row.chosen_because.includes("(no call qualifies)") ? "noCandidate" : "ladderPutInstead");
  return byDay;
}

/**
 * What the engine recorded at a symbol's option sales over a cycle's days, per day and contract: the annualised yield and
 * the delta (contract-weighted).
 */
type RecordedSale = { premiumYield: number | null; delta: number | null; ladderRung: BacktestLadderRungRecord | null; positionBreakEvens: { first: number | null; second: number | null } | null };

const ladderScoreKeys = ["ladderCap", "ladderTop", "ladderBreakEven", "ladderFloor", "ladderAverageCost", "ladderShock", "ladderCommitted", "ladderRungCollateral", "ladderReserve", "ladderBase", "premiumYield", "rank", "eligibleCount", "bestCandidateStrike", "bestCandidatePremiumYield"] as const;

/** A rung sale's reason (baselineSaleSteps.ts sellLadderPuts): the call it was preferred to, and whether the volume limit of the puts before it led to it. */
function ladderSaleReasonOf(chosenBecause: string | null): Pick<BacktestLadderRungRecord, "callComparison" | "afterVolumeLimit"> {
  const beat = chosenBecause ? /its yield ([\d.]+)% beats the best call's ([\d.]+)% by more than ([\d.]+)%/.exec(chosenBecause) : null;
  return {
    callComparison: beat ? { putYield: Number(beat[1]) / 100, callYield: Number(beat[2]) / 100, marginPct: Number(beat[3]) } : null,
    afterVolumeLimit: chosenBecause?.includes("next in order: the volume limit") ?? false,
  };
}

/** A ladder put's rung from its sale's scores; null for a put that was not a rung (or recorded no reserve). */
function ladderRungOf(scores: Partial<Record<(typeof ladderScoreKeys)[number], number | null>>, rungs: number | null): BacktestLadderRungRecord | null {
  const { ladderCommitted: committed, ladderRungCollateral: rungCollateral, ladderReserve: reserve, ladderBase: base } = scores;
  if (rungs === null || committed == null || rungCollateral == null || reserve == null || base == null) return null;
  const reached = ladderRungReached({ committed, rungCollateral, reserve, rungs });
  if (!reached) return null;
  return {
    rungNumber: reached.rungNumber,
    rungs,
    slices: reached.slices,
    cap: scores.ladderCap ?? null,
    top: scores.ladderTop ?? null,
    breakEven: scores.ladderBreakEven ?? null,
    floor: scores.ladderFloor ?? null,
    averageCost: scores.ladderAverageCost ?? null,
    shock: scores.ladderShock ?? 0,
    committed,
    rungCollateral,
    reserve,
    base,
    saleYield: scores.premiumYield ?? null,
    rank: scores.rank ?? null,
    eligibleCount: scores.eligibleCount ?? null,
    bestStrike: scores.bestCandidateStrike ?? null,
    bestYield: scores.bestCandidatePremiumYield ?? null,
  };
}

/** The options sold in the cycle's days, as their sales recorded them, read by day, right, strike and expiry. */
/**
 * The instants of a symbol's Vol Farmer crossings over a cycle's days (backtestVolFarmerLook.ts): the automatic unwind
 * actions, each stamped with the moment the stock reached the Call's strike, which is also when its rows were written.
 */
async function loadVolFarmerCrossingInstants(sessionId: string, symbol: string, timeline: readonly BacktestCycleTimelineRow[]): Promise<Set<number>> {
  const dates = timeline.map((entry) => entry.tradingDate).sort();
  if (dates.length === 0) return new Set();
  const rows: { at: Date }[] = await db("backtest_actions")
    .where({ session_id: sessionId, symbol, outcome: "filled", automatic: true })
    .where("candidate_id", "like", `${symbol}:vol_farmer_unwind:%`)
    .whereBetween("trading_date", [dates[0]!, dates.at(-1)!])
    .distinct("at");
  return new Set(rows.map((row) => new Date(row.at).getTime()));
}

async function loadSaleRecords(sessionId: string, symbol: string, timeline: readonly BacktestCycleTimelineRow[]): Promise<{ recordedOf: (date: string, right: "C" | "P", strike: number | null, expiry: string | null, at: string | null) => RecordedSale }> {
  const dates = timeline.map((entry) => entry.tradingDate).sort();
  if (dates.length === 0) return { recordedOf: () => ({ premiumYield: null, delta: null, ladderRung: null, positionBreakEvens: null }) };
  const sales: { date: string; at: Date; kind: string; contract: { strike: number; expiry: string }; quantity: string; premium_yield: string | null; delta: string | null; break_even_first: string | null; break_even_second: string | null; chosen_because: string | null; ladder: Partial<Record<(typeof ladderScoreKeys)[number], number | null>> | null }[] = await db("backtest_actions")
    .where({ session_id: sessionId, symbol, outcome: "filled" })
    .whereIn("kind", ["open_cash_secured_put", "open_covered_call"])
    .whereBetween("trading_date", [dates[0]!, dates.at(-1)!])
    .whereNotNull("candidate_scores")
    .orderBy("sequence")
    .select(
      db.raw("trading_date::text as date"),
      "at",
      "kind",
      "contract",
      "quantity",
      "chosen_because",
      db.raw("candidate_scores->>'premiumYield' as premium_yield"),
      db.raw("candidate_scores->>'delta' as delta"),
      db.raw("candidate_scores->>'breakEvenFirst' as break_even_first"),
      db.raw("candidate_scores->>'breakEvenSecond' as break_even_second"),
      db.raw(`case when jsonb_exists(candidate_scores, 'ladderCap') then jsonb_build_object(${ladderScoreKeys.map((key) => `'${key}', candidate_scores->'${key}'`).join(", ")}) end as ladder`),
    );
  const rungs = sales.some((sale) => sale.ladder !== null) ? await loadLadderRungs(sessionId, symbol) : null;
  const keyOf = (date: string, right: "C" | "P", strike: number, expiry: string) => `${date}|${right}|${Math.round(strike * 10_000)}|${expiry}`;
  const totals = new Map<string, { weightedYield: number; yieldContracts: number; weightedDelta: number; deltaContracts: number }>();
  // A rung is one look's order: read by the sale's instant, as the timeline's row is (a contract sold again at a later look is another rung).
  const rungByMoment = new Map<string, BacktestLadderRungRecord | null>();
  const collateralUsedByRung = new Map<string, number>();
  // Vol Farmer v2: the position break-evens its sale of the contract recorded (one order per contract and look).
  const positionBreakEvensByKey = new Map<string, { first: number | null; second: number | null }>();
  for (const sale of sales) {
    const right = sale.kind === "open_covered_call" ? "C" : "P";
    const key = keyOf(sale.date, right, Number(sale.contract.strike), sale.contract.expiry);
    const total = totals.get(key) ?? { weightedYield: 0, yieldContracts: 0, weightedDelta: 0, deltaContracts: 0 };
    if (sale.premium_yield !== null) {
      total.weightedYield += Number(sale.premium_yield) * Number(sale.quantity);
      total.yieldContracts += Number(sale.quantity);
    }
    if (sale.delta !== null) {
      total.weightedDelta += Number(sale.delta) * Number(sale.quantity);
      total.deltaContracts += Number(sale.quantity);
    }
    const momentKey = `${new Date(sale.at).toISOString()}|${key}`;
    if (sale.ladder !== null && !rungByMoment.has(momentKey)) {
      // The rung's collateral left before this put: its order's earlier fills (one look, one cap) used the rest.
      const rungKey = `${new Date(sale.at).toISOString()}|${sale.ladder.ladderCap}`;
      const usedBefore = collateralUsedByRung.get(rungKey) ?? 0;
      const rung = ladderRungOf(sale.ladder, rungs);
      rungByMoment.set(momentKey, rung && { ...rung, ...ladderSaleReasonOf(sale.chosen_because), collateralLeft: rung.rungCollateral - usedBefore });
    }
    if (sale.ladder !== null) {
      const rungKey = `${new Date(sale.at).toISOString()}|${sale.ladder.ladderCap}`;
      collateralUsedByRung.set(rungKey, (collateralUsedByRung.get(rungKey) ?? 0) + Number(sale.contract.strike) * 100 * Number(sale.quantity));
    }
    totals.set(key, total);
    if ((sale.break_even_first !== null || sale.break_even_second !== null) && !positionBreakEvensByKey.has(key)) {
      positionBreakEvensByKey.set(key, { first: sale.break_even_first === null ? null : Number(sale.break_even_first), second: sale.break_even_second === null ? null : Number(sale.break_even_second) });
    }
  }
  return {
    recordedOf: (date, right, strike, expiry, at) => {
      const key = strike === null || expiry === null ? null : keyOf(date, right, strike, expiry);
      const total = key === null ? undefined : totals.get(key);
      return {
        premiumYield: total && total.yieldContracts > 0 ? total.weightedYield / total.yieldContracts : null,
        delta: total && total.deltaContracts > 0 ? total.weightedDelta / total.deltaContracts : null,
        ladderRung: key === null || at === null ? null : (rungByMoment.get(`${at}|${key}`) ?? null),
        positionBreakEvens: key === null ? null : (positionBreakEvensByKey.get(key) ?? null),
      };
    },
  };
}

/** The hedge Puts bought in the cycle's days, read by day, strike and expiry: their yearly cost (hedgePutCostYield) from what each purchase recorded, contract-weighted. */
async function loadHedgePurchaseRecords(sessionId: string, symbol: string, timeline: readonly BacktestCycleTimelineRow[]): Promise<{ costYieldOf: (date: string, strike: number | null, expiry: string | null) => number | null }> {
  const dates = timeline.map((entry) => entry.tradingDate).sort();
  if (dates.length === 0) return { costYieldOf: () => null };
  const purchases: { date: string; contract: { strike: number; expiry: string }; quantity: string; fill_price: string; stock_price: string | null; dte: string | null }[] = await db("backtest_actions")
    .where({ session_id: sessionId, symbol, outcome: "filled", kind: "buy_hedge" })
    .whereBetween("trading_date", [dates[0]!, dates.at(-1)!])
    .select(db.raw("trading_date::text as date"), "contract", "quantity", "fill_price", db.raw("candidate_scores->>'stockPrice' as stock_price"), db.raw("candidate_scores->>'dte' as dte"));
  const keyOf = (date: string, strike: number, expiry: string) => `${date}|${Math.round(strike * 10_000)}|${expiry}`;
  const totals = new Map<string, { weightedCostYield: number; contracts: number }>();
  for (const purchase of purchases) {
    if (purchase.stock_price === null || purchase.dte === null) continue;
    const costYield = hedgePutCostYield({ fillPrice: Number(purchase.fill_price), strike: Number(purchase.contract.strike), stockPrice: Number(purchase.stock_price), dte: Number(purchase.dte), commissionDollarsPerContract: optionCommissionDollars(1) });
    if (costYield === null) continue;
    const key = keyOf(purchase.date, Number(purchase.contract.strike), purchase.contract.expiry);
    const total = totals.get(key) ?? { weightedCostYield: 0, contracts: 0 };
    total.weightedCostYield += costYield * Number(purchase.quantity);
    total.contracts += Number(purchase.quantity);
    totals.set(key, total);
  }
  return {
    costYieldOf: (date, strike, expiry) => {
      const total = strike === null || expiry === null ? undefined : totals.get(keyOf(date, strike, expiry));
      return total && total.contracts > 0 ? total.weightedCostYield / total.contracts : null;
    },
  };
}

/** Every symbol's yearly yields recorded at each Call sale (premiumYield) and yearly costs of each hedge Put bought (hedgePutCostYield), for the session tiles. */
async function loadQuotedYields(sessionId: string): Promise<{ callSaleYields: number[]; hedgeCostYields: number[] }> {
  const rows: { kind: string; premium_yield: string | null; fill_price: string | null; strike: string | null; stock_price: string | null; dte: string | null }[] = await db("backtest_actions")
    .where({ session_id: sessionId, outcome: "filled" })
    .whereIn("kind", ["open_covered_call", "buy_hedge"])
    .select("kind", db.raw("candidate_scores->>'premiumYield' as premium_yield"), "fill_price", db.raw("contract->>'strike' as strike"), db.raw("candidate_scores->>'stockPrice' as stock_price"), db.raw("candidate_scores->>'dte' as dte"));
  const callSaleYields = rows.flatMap((row) => (row.kind === "open_covered_call" && row.premium_yield !== null ? [Number(row.premium_yield)] : []));
  const hedgeCostYields = rows.flatMap((row) => {
    if (row.kind !== "buy_hedge" || row.fill_price === null || row.strike === null || row.stock_price === null || row.dte === null) return [];
    const costYield = hedgePutCostYield({ fillPrice: Number(row.fill_price), strike: Number(row.strike), stockPrice: Number(row.stock_price), dte: Number(row.dte), commissionDollarsPerContract: optionCommissionDollars(1) });
    return costYield === null ? [] : [costYield];
  });
  return { callSaleYields, hedgeCostYields };
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
  const [dayRows, tradeRows, job, everyPositionRecord, everyCycle, everyCycleGap, bookCounts, cashBoundBySymbol, quotedYields] = await Promise.all([
    loadSessionDayRows([sessionId]),
    loadSessionTradeRows(sessionId),
    loadLatestJobViewForSession(sessionId),
    loadSessionPositions(sessionId),
    loadSessionCycles(sessionId),
    loadSessionCycleGaps(sessionId),
    loadSessionBookCounts(sessionId),
    row.book_mode === "pots" ? loadCashBoundBySymbol(sessionId, symbolsOf(row)) : null,
    loadQuotedYields(sessionId),
  ]);
  const days = toSessionDays(dayRows);
  // A row stored before trades named their symbol belongs to the session's one symbol.
  const trades = ofSymbol(tradeRows.map((tradeRow: Record<string, unknown>) => toTrade({ ...tradeRow, symbol: tradeRow.symbol ?? row.symbol })));
  const positions = ofSymbol(everyPositionRecord.map((position) => withPositionCycle(position, everyCycle)));
  // The Wheel cycles' Cash: a cycle at its end, a gap at its first day's marks (the whole account's free cash).
  const lastDay = days.at(-1)?.tradingDate ?? null;
  const freeCash = days.length > 0 ? await loadSessionFreeCash(sessionId, days[0]!.tradingDate, lastDay!) : null;
  // A closed cycle's row shows the most shares it held and its lowest Cash (Marcelo 2026-10-21), read from its trades; an
  // open one the latest of each.
  const closedTimelines: { symbol: string; cycle_number: number; timeline: BacktestCycleTimelineRow[] | null }[] = await db("backtest_cycles")
    .where({ session_id: sessionId, status: "closed" })
    .whereNotNull("timeline")
    .modify((query) => (onlySymbol === null ? query : query.where({ symbol: onlySymbol })))
    .select("symbol", "cycle_number", "timeline");
  const timelineOf = new Map(closedTimelines.map((entry) => [`${entry.symbol}#${entry.cycle_number}`, entry.timeline ?? []]));
  const splitFactorBySymbol = new Map<string, SplitFactorOfDay>();
  // Each cycle's days with shares and no Call, from its positions' legs (Marcelo 2026-10-27).
  const sessionDates = days.map((day) => day.tradingDate);
  const positionsByCycle = new Map<string, BacktestPosition[]>();
  for (const position of positions) if (position.cycleNumber !== null) positionsByCycle.set(`${position.symbol}#${position.cycleNumber}`, [...(positionsByCycle.get(`${position.symbol}#${position.cycleNumber}`) ?? []), position]);
  const noCallDaysOf = (cycle: BacktestCycle) => {
    const coverage = cycleNoCallDays({ sessionDays: sessionDates, cycle, positions: positionsByCycle.get(`${cycle.symbol}#${cycle.cycleNumber}`) ?? [] });
    return { days: coverage.runs.reduce((sum, run) => sum + run.length, 0), shareDays: coverage.shareDays };
  };
  const cycles = ofSymbol(everyCycle).map((cycle) => {
    if (cycle.status === "open") return { ...cycle, freeCashShareNow: freeCash === null || lastDay === null ? null : freeCash.shareAfter(lastDay, null), sharesHeldMost: null, freeCashShareLowest: null, noCallDays: noCallDaysOf(cycle) };
    const timeline = timelineOf.get(`${cycle.symbol}#${cycle.cycleNumber}`) ?? [];
    if (!splitFactorBySymbol.has(cycle.symbol)) splitFactorBySymbol.set(cycle.symbol, splitFactorOfDayFor(cycle.symbol));
    const splitFactorOf = splitFactorBySymbol.get(cycle.symbol)!;
    const shares = sharesHeldAfterEachMoment(timeline, splitFactorOf);
    let most: { shares: number; on: string; adjusted: number } | null = null;
    shares.forEach((held, index) => {
      const adjusted = held * splitFactorOf(timeline[index]!.tradingDate);
      if (held > 0 && (most === null || adjusted > most.adjusted + 1e-9)) most = { shares: held, on: timeline[index]!.tradingDate, adjusted };
    });
    const moments = timeline.flatMap((row) => (row.at === null ? [] : [{ tradingDate: row.tradingDate, at: row.at }]));
    return {
      ...cycle,
      freeCashShareNow: null,
      sharesHeldMost: most === null ? null : { shares: (most as { shares: number }).shares, on: (most as { on: string }).on },
      freeCashShareLowest: freeCash === null || cycle.closedOn === null ? null : freeCash.lowestShareBetween(cycle.openedOn, cycle.closedOn, moments),
      noCallDays: noCallDaysOf(cycle),
    };
  });
  const cycleGaps = ofSymbol(everyCycleGap).map((gap) => ({ ...gap, freeCashShareAtStart: freeCash?.shareAtMark(gap.firstIdleDay) ?? null }));
  return {
    session: {
      ...toSessionListItem(row),
      settingsSnapshot: row.settings_snapshot,
      overrides: row.overrides,
      bookMode: row.book_mode,
      symbolSettings: row.symbol_settings,
      settingsSource: row.settings_source,
      potsFromStartingValue: row.pots_from_starting_value,
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
    cycleGaps,
    tickerStatistics: computeTickerStatistics(positions, cycles),
    allSymbolsStatistics: computeAllSymbolsStatistics(positions, cycles),
    // The whole account's, like the metrics, whichever symbol is shown.
    pnlSources: row.metrics ? computePnlSources({ metrics: row.metrics, tradingDates: days.map((day) => day.tradingDate), cycles: everyCycle, positions: everyPositionRecord, ...quotedYields }) : null,
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

/** Stores a session (snapshot and changed values only) as a run of its batch, with its backtest job in the queue. */
async function insertSessionWithQueuedJob(transaction: Knex.Transaction, request: ValidatedBacktestSessionRequest, snapshot: BacktestSettings, batchId: string, runNumber: number): Promise<{ sessionId: string; jobId: string }> {
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
      settings_source: request.settingsSource,
      pots_from_starting_value: request.potsFromStartingValue,
      engine_version: backtestEngineVersion,
      status: "queued",
      batch_id: batchId,
      run_number: runNumber,
    })
    .returning("id");
  const jobId = await insertQueuedBacktestJob(session.id as string, describeSessionSymbols(request.symbols), transaction);
  return { sessionId: session.id as string, jobId };
}

async function insertBatch(transaction: Knex.Transaction, name: string): Promise<string> {
  const [batch] = await transaction("backtest_batches").insert({ name }).returning("id");
  return batch.id as string;
}

/** Stores the session as a batch of one run, queues its backtest job and kicks the queue. */
export async function createBacktestSession(request: ValidatedBacktestSessionRequest, snapshot: BacktestSettings): Promise<{ session: BacktestSessionListItem; job: BacktestJobView }> {
  const { sessionId, jobId } = await db.transaction(async (transaction) => insertSessionWithQueuedJob(transaction, request, snapshot, await insertBatch(transaction, request.name), 1));
  await kickBacktestQueue();
  return { session: toSessionListItem(await loadSessionRow(sessionId)), job: await loadBacktestJobView(jobId) };
}

/** Stores the batch and its runs (run numbers in the order given), each session's job in the queue, all or none; then kicks the queue. */
export async function createBacktestBatch(name: string, runs: readonly { value: ValidatedBacktestSessionRequest; snapshot: BacktestSettings }[]): Promise<{ batch: BacktestBatchSummary; runs: { session: BacktestSessionListItem; job: BacktestJobView }[] }> {
  const { batchId, created } = await db.transaction(async (transaction) => {
    const insertedBatchId = await insertBatch(transaction, name);
    const inserted: { sessionId: string; jobId: string }[] = [];
    for (const [index, run] of runs.entries()) inserted.push(await insertSessionWithQueuedJob(transaction, run.value, run.snapshot, insertedBatchId, index + 1));
    return { batchId: insertedBatchId, created: inserted };
  });
  await kickBacktestQueue();
  const batchRow: { id: string; name: string; created_at: Date } = await db("backtest_batches").where({ id: batchId }).first("id", "name", "created_at");
  return {
    batch: { id: batchRow.id, name: batchRow.name, createdAt: new Date(batchRow.created_at).toISOString(), runCount: created.length },
    runs: await Promise.all(created.map(async ({ sessionId, jobId }) => ({ session: toSessionListItem(await loadSessionRow(sessionId)), job: await loadBacktestJobView(jobId) }))),
  };
}

/** Deletes a session with its days, trades, simulated book and jobs; an unfinished job is stopped first. A batch left without runs goes too. */
export async function deleteBacktestSession(sessionId: string): Promise<void> {
  const row = await loadSessionRow(sessionId);
  await stopJobsOfSession(sessionId);
  await db("backtest_sessions").where({ id: sessionId }).del();
  if (row.batch_id !== null && !(await db("backtest_sessions").where({ batch_id: row.batch_id }).first("id"))) await db("backtest_batches").where({ id: row.batch_id }).del();
}

/** Deletes a batch and every run's session, their unfinished jobs stopped first. */
export async function deleteBacktestBatch(batchId: string): Promise<void> {
  if (!(await db("backtest_batches").where({ id: batchId }).first("id"))) throw new BacktestRequestError("No such batch.", 404);
  const sessions: { id: string }[] = await db("backtest_sessions").where({ batch_id: batchId }).select("id");
  for (const session of sessions) await stopJobsOfSession(session.id);
  await db("backtest_batches").where({ id: batchId }).del();
}

interface BatchRow {
  id: string;
  name: string;
  created_at: Date;
}

async function loadBatchWithRuns(batchId: string): Promise<{ batch: BatchRow; rows: SessionRow[] }> {
  const batch = (await db("backtest_batches").where({ id: batchId }).first("id", "name", "created_at")) as BatchRow | undefined;
  if (!batch) throw new BacktestRequestError("No such batch.", 404);
  const rows: SessionRow[] = await selectSessionRows().where({ batch_id: batchId }).orderBy("run_number");
  if (rows.length === 0) throw new BacktestRequestError("This batch has no runs left.", 404);
  return { batch, rows };
}

/** Each session's days, by session id. */
async function loadDayRowsBySession(sessionIds: readonly string[]): Promise<Map<string, SessionDayRow[]>> {
  const bySession = new Map<string, SessionDayRow[]>();
  if (sessionIds.length === 0) return bySession;
  for (const day of await loadSessionDayRows(sessionIds)) bySession.set(day.session_id, [...(bySession.get(day.session_id) ?? []), day]);
  return bySession;
}

/** A batch's page: its runs in run order, each with its job, and once finished its account value points and per-symbol figures. */
export async function loadBacktestBatchDetail(batchId: string): Promise<BacktestBatchDetail> {
  const { batch, rows } = await loadBatchWithRuns(batchId);
  const finishedIds = rows.filter((row) => row.status === "succeeded").map((row) => row.id);
  const [daysBySession, latestRuns, jobs, statistics] = await Promise.all([
    loadDayRowsBySession(finishedIds),
    loadLatestSessionRunStates(rows.map((row) => row.id)),
    Promise.all(rows.map((row) => loadLatestJobViewForSession(row.id))),
    Promise.all(
      rows.map(async (row) => {
        if (row.status !== "succeeded") return [];
        const [positionRecords, cycles] = await Promise.all([loadSessionPositions(row.id), loadSessionCycles(row.id)]);
        return computeTickerStatistics(
          positionRecords.map((position) => withPositionCycle(position, cycles)),
          cycles,
        );
      }),
    ),
  ]);
  const first = rows[0]!;
  return {
    batch: {
      id: batch.id,
      name: batch.name,
      createdAt: new Date(batch.created_at).toISOString(),
      runCount: rows.length,
      startDate: first.start_date,
      endDate: first.end_date,
      tablesMode: first.tables_mode,
      decisionMaker: applyBacktestOverrides(first.settings_snapshot, first.overrides).decisionMaker,
    },
    runs: rows.map((row, index) => ({
      runNumber: Number(row.run_number),
      session: toSessionListItem(row, latestRuns.get(row.id) ?? null),
      overrides: row.overrides,
      settingsSource: row.settings_source,
      symbolSettings: row.symbol_settings,
      baselineMetrics: row.baseline_metrics,
      spyBaselineMetrics: row.spy_baseline_metrics,
      job: jobs[index] ?? null,
      points: (daysBySession.get(row.id) ?? []).map((day) => ({ tradingDate: day.trading_date, value: Number(day.account_value), baselineValue: Number(day.baseline_value), spyBaselineValue: nullableNumber(day.spy_baseline_value) })),
      tickerStatistics: statistics[index]!,
    })),
  };
}

/** The batch's runs with these numbers added up (formula F1, batchCombined.ts); every one must have finished. */
export async function loadBacktestBatchCombined(batchId: string, runNumbers: readonly number[]): Promise<BacktestBatchCombined> {
  const { rows } = await loadBatchWithRuns(batchId);
  const picked = runNumbers.map((runNumber) => {
    const row = rows.find((candidate) => Number(candidate.run_number) === runNumber);
    if (!row) throw new BacktestRequestError(`This batch has no Run ${runNumber}.`, 404);
    if (row.status !== "succeeded") throw new BacktestRequestError(`Run ${runNumber} has not finished: only finished runs combine.`, 409);
    return row;
  });
  const daysBySession = await loadDayRowsBySession(picked.map((row) => row.id));
  const inputs = await Promise.all(
    picked.map(async (row): Promise<CombinedRunInput> => {
      const [tradeRows, cycles] = await Promise.all([
        loadSessionTradeRows(row.id),
        loadSessionCycles(row.id),
      ]);
      const trades = tradeRows.map((tradeRow: Record<string, unknown>) => toTrade({ ...tradeRow, symbol: tradeRow.symbol ?? row.symbol }));
      return {
        runNumber: Number(row.run_number),
        startingValue: Number(row.starting_value),
        days: (daysBySession.get(row.id) ?? []).map((day) => ({
          tradingDate: day.trading_date,
          value: Number(day.account_value),
          exposureDollars: Number(day.exposure_dollars),
          interestDollars: Number(day.interest_dollars),
          baselineValue: Number(day.baseline_value),
          spyBaselineValue: nullableNumber(day.spy_baseline_value),
        })),
        book: { optionSales: trades, cycles: cycleFiguresOf(cycles, trades) },
      };
    }),
  );
  return combineBatchRuns(inputs);
}
