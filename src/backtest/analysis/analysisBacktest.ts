import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestBaselineSettings, BacktestMetrics } from "../backtestTypes.js";
import { ladderBasePath, loadAnalysisOrders, tooLargeByYear, yieldGivenUp, type AnalysisTooLargeYear } from "./analysisPotSizing.js";

// The analysis's own backtest (Marcelo 2026-10-15): each saved analysis runs the ticker at its lab values over its whole
// file, as an ordinary session visible in Sessions; its order records give the "When orders are too large" card, and its
// account the pot path the fit over the history checks each day against.

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
}

export async function computeAnalysisBacktestFigures(sessionId: string, symbol: string, connection: Knex = db): Promise<AnalysisBacktestFigures> {
  const session = await connection("backtest_sessions").where({ id: sessionId }).first("name", "status", connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "metrics", "baseline_metrics", "starting_value");
  if (!session) throw new Error(`The analysis backtest session ${sessionId} is gone.`);
  const orders = await loadAnalysisOrders(sessionId, symbol, connection);
  const days: { date: string; account_value: string }[] = await connection("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(connection.raw("trading_date::text as date"), "account_value");
  const cycles: { opened_on: string; closed_on: string | null }[] = await connection("backtest_cycles").where({ session_id: sessionId, symbol }).orderBy("opened_on").select(connection.raw("opened_on::text as opened_on"), connection.raw("closed_on::text as closed_on"));
  const potPath = ladderBasePath(
    days.map((day) => ({ date: day.date, accountValue: Number(day.account_value) })),
    cycles.map((cycle) => ({ openedOn: cycle.opened_on, closedOn: cycle.closed_on })),
    Number(session.starting_value),
  );
  const tooLarge = orders.filter((order) => order.fills.length > 1 || order.unsold > 0);
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
    tooLargeDays: tooLarge.map((order) => [order.date, order.right, order.fills.length > 1 ? yieldGivenUp(order) : null, order.unsold]),
    potPath: potPath.map(([date, pot]) => [date, Math.round(pot * 100) / 100]),
  };
}
