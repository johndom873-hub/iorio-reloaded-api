import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestBaselineSettings, BacktestMetrics } from "../backtestTypes.js";
import { ladderRungReached, type LadderPutBlock } from "../engine/backtestBaselineLadder.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { ladderBasePath, loadAnalysisOrders, tooLargeByYear, yieldGivenUp, type AnalysisOrder, type AnalysisTooLargeYear } from "./analysisPotSizing.js";

// The analysis's own backtest (Marcelo 2026-10-15): each saved analysis runs the ticker at its lab values over its whole
// file, as an ordinary session visible in Sessions; its order records give the "When orders are too large" card, and its
// account the pot path the fit over the history checks each day against, and its ladder levels and rungs sold the price
// chart's lines and dots.

const formatDelta = (value: number) => value.toFixed(2);
const formatPot = (dollars: number) => (dollars >= 1_000_000 ? `$${+(dollars / 1_000_000).toFixed(2)}M` : `$${+(dollars / 1000).toFixed(1)}k`);

/** "Analysis · HOOD · 50% shares · 5 rungs · |delta| 0.05–0.30 · $200k" (at most 120 characters, as any session name). */
export function analysisSessionName(symbol: string, potDollars: number, baseline: Pick<BacktestBaselineSettings, "ladderSharesPct" | "ladderRungs" | "minAbsDelta" | "maxAbsDelta">): string {
  return `Analysis · ${symbol} · ${baseline.ladderSharesPct}% shares · ${baseline.ladderRungs} rung${baseline.ladderRungs === 1 ? "" : "s"} · |delta| ${formatDelta(baseline.minAbsDelta)}–${formatDelta(baseline.maxAbsDelta)} · ${formatPot(potDollars)}`;
}

export interface AnalysisBacktestFigures {
  sessionId: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  metrics: BacktestMetrics | null;
  buyAndHoldMetrics: BacktestMetrics | null;
  orderCount: number;
  saleDays: number;
  /** Orders that needed more than one strike, and orders partly unsold. */
  ordersOverOneStrike: number;
  ordersPartlyUnsold: number;
  byYear: Record<string, AnalysisTooLargeYear>;
  /** Days an order needed more than one strike or went partly unsold: the price chart's shading. [date, right, yield given up, unsold]. */
  tooLargeDays: [string, "C" | "P", number | null, number][];
  /** Each backtest day's pot as the ladder sizes from it: [date, max(account at the open cycle's start, last night's account)]. */
  potPath: [string, number][];
  /**
   * Each day the cycle held shares (the day's first look, before its orders), split-adjusted as the price chart: [date, the
   * next ladder put's cap (null: none fits), the floor, why no ladder put could be sold (null: one could)]. Empty for a
   * session run before the levels were recorded.
   */
  ladderLevels: [string, number | null, number | null, LadderPutBlock | null][];
  /**
   * Each rung sold, split-adjusted: [date, its highest strike, its fills [strike, expiry, contracts], the rung it reaches
   * [its number, the ticker's rungs, the reserve's slices it fills up to, the reserve committed before it in dollars] (null
   * when its sale recorded no reserve; absent in analysis figures stored before it)].
   */
  ladderRungsSold: [string, number, [number, string, number][], [number, number, number, number] | null][];
  /**
   * Each backtest day, at the 10:00 marks before its orders: [date, the shares held at those marks (null: a session run
   * before they were recorded), the account value]. The price chart's account in shares = the one ÷ the other.
   */
  accountInShares: [string, number | null, number][];
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** The orders that needed more than one strike or went partly unsold, as the price chart shades them. */
export function tooLargeDaysOf(orders: readonly AnalysisOrder[]): AnalysisBacktestFigures["tooLargeDays"] {
  return orders.filter((order) => order.fills.length > 1 || order.unsold > 0).map((order) => [order.date, order.right, order.fills.length > 1 ? yieldGivenUp(order) : null, order.unsold]);
}

type SessionDayShares = { date: string; account_value: string; shares_value_dollars: string | null };

async function loadSessionDayShares(sessionId: string, connection: Knex): Promise<SessionDayShares[]> {
  return connection("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(connection.raw("trading_date::text as date"), "account_value", "shares_value_dollars");
}

const accountInSharesOf = (days: readonly SessionDayShares[]): AnalysisBacktestFigures["accountInShares"] => days.map((day) => [day.date, day.shares_value_dollars === null ? null : Number(day.shares_value_dollars), Number(day.account_value)]);

/** The account in shares of every session day (the whole book's shares: one symbol's only in a one-symbol session). */
export async function loadAccountInShares(sessionId: string, connection: Knex = db): Promise<AnalysisBacktestFigures["accountInShares"]> {
  return accountInSharesOf(await loadSessionDayShares(sessionId, connection));
}

/** The ladder's rung count a session ran a symbol with: its own pot's value in a session of pots, else the session's. */
async function loadLadderRungs(sessionId: string, symbol: string, connection: Knex): Promise<number | null> {
  const session = await connection("backtest_sessions").where({ id: sessionId }).first("settings_snapshot", "overrides", "book_mode", "symbol_settings");
  if (!session) return null;
  const tickerRungs = session.book_mode === "pots" ? session.symbol_settings?.[symbol]?.baseline?.ladderRungs : undefined;
  return tickerRungs ?? applyBacktestOverrides(session.settings_snapshot, session.overrides ?? {}).baseline.ladderRungs;
}

/** The ladder's levels and rungs sold of a symbol in a session, split-adjusted by each day's recorded factor. */
export async function loadAnalysisLadder(sessionId: string, symbol: string, connection: Knex = db): Promise<Pick<AnalysisBacktestFigures, "ladderLevels" | "ladderRungsSold">> {
  const levels: { date: string; split_factor: string; next_put_cap: string | null; floor: string | null; blocked_because: LadderPutBlock | null }[] = await connection("backtest_ladder_levels")
    .where({ session_id: sessionId, symbol })
    .orderBy("trading_date")
    .select(connection.raw("trading_date::text as date"), "split_factor", "next_put_cap", "floor", "blocked_because");
  const factorByDate = new Map(levels.map((level) => [level.date, Number(level.split_factor)]));
  const adjusted = (value: string | number | null, date: string) => (value === null ? null : cents(Number(value) / (factorByDate.get(date) ?? 1)));
  // A rung's order: the fills of one look under one cap (the next in order after the volume limit shares it).
  const sales: { date: string; at: Date; contract: { strike: number; expiry: string }; quantity: string; cap: string; committed: string | null; rung_collateral: string | null; reserve: string | null }[] = await connection("backtest_actions")
    .where({ session_id: sessionId, symbol, kind: "open_cash_secured_put", outcome: "filled" })
    .whereRaw("jsonb_exists(candidate_scores, 'ladderCap')")
    .orderBy("sequence")
    .select(
      connection.raw("trading_date::text as date"),
      "at",
      "contract",
      "quantity",
      connection.raw("candidate_scores->>'ladderCap' as cap"),
      connection.raw("candidate_scores->>'ladderCommitted' as committed"),
      connection.raw("candidate_scores->>'ladderRungCollateral' as rung_collateral"),
      connection.raw("candidate_scores->>'ladderReserve' as reserve"),
    );
  const rungs = sales.length > 0 ? await loadLadderRungs(sessionId, symbol, connection) : null;
  const rungsSold = new Map<string, AnalysisBacktestFigures["ladderRungsSold"][number]>();
  for (const sale of sales) {
    const key = `${new Date(sale.at).toISOString()}|${sale.cap}`;
    const strike = adjusted(sale.contract.strike, sale.date)!;
    let rung = rungsSold.get(key);
    if (!rung) {
      const reached = rungs === null || sale.committed === null || sale.rung_collateral === null || sale.reserve === null ? null : ladderRungReached({ committed: Number(sale.committed), rungCollateral: Number(sale.rung_collateral), reserve: Number(sale.reserve), rungs });
      rung = [sale.date, strike, [], reached === null ? null : [reached.rungNumber, rungs!, reached.slices, Number(sale.committed)]];
      rungsSold.set(key, rung);
    }
    rung[1] = Math.max(rung[1], strike);
    rung[2].push([strike, sale.contract.expiry, Number(sale.quantity)]);
  }
  return {
    ladderLevels: levels.map((level) => [level.date, adjusted(level.next_put_cap, level.date), adjusted(level.floor, level.date), level.blocked_because]),
    ladderRungsSold: [...rungsSold.values()],
  };
}

export async function computeAnalysisBacktestFigures(sessionId: string, symbol: string, connection: Knex = db): Promise<AnalysisBacktestFigures> {
  const session = await connection("backtest_sessions").where({ id: sessionId }).first("name", "status", connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "metrics", "baseline_metrics", "starting_value");
  if (!session) throw new Error(`The analysis backtest session ${sessionId} is gone.`);
  const orders = await loadAnalysisOrders(sessionId, symbol, connection);
  const days = await loadSessionDayShares(sessionId, connection);
  const cycles: { opened_on: string; closed_on: string | null }[] = await connection("backtest_cycles").where({ session_id: sessionId, symbol }).orderBy("opened_on").select(connection.raw("opened_on::text as opened_on"), connection.raw("closed_on::text as closed_on"));
  const potPath = ladderBasePath(
    days.map((day) => ({ date: day.date, accountValue: Number(day.account_value) })),
    cycles.map((cycle) => ({ openedOn: cycle.opened_on, closedOn: cycle.closed_on })),
    Number(session.starting_value),
  );
  const ladder = await loadAnalysisLadder(sessionId, symbol, connection);
  return {
    sessionId,
    name: session.name,
    status: session.status,
    startDate: session.start_date,
    endDate: session.end_date,
    metrics: session.metrics,
    buyAndHoldMetrics: session.baseline_metrics,
    orderCount: orders.length,
    saleDays: new Set(orders.filter((order) => order.fills.length > 0).map((order) => order.date)).size,
    ordersOverOneStrike: orders.filter((order) => order.fills.length > 1).length,
    ordersPartlyUnsold: orders.filter((order) => order.unsold > 0).length,
    byYear: tooLargeByYear(orders),
    tooLargeDays: tooLargeDaysOf(orders),
    potPath: potPath.map(([date, pot]) => [date, Math.round(pot * 100) / 100]),
    ...ladder,
    accountInShares: accountInSharesOf(days),
  };
}
