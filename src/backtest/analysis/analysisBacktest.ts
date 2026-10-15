import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestBaselineSettings, BacktestMetrics } from "../backtestTypes.js";
import { largestPotOfOrder, loadAnalysisOrders, tooLargeByYear, yieldGivenUp, type AnalysisTooLargeYear } from "./analysisPotSizing.js";

// The analysis's own backtest (Marcelo 2026-10-15): each saved analysis runs the ticker at its lab values over its whole
// file, as an ordinary session visible in Sessions; its order records give the "When orders are too large" card and the
// largest pot.

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
  /** Each sale day's largest pot, the smallest over that day's orders: [date, pot, right]. */
  dailyLargestPot: [string, number, "C" | "P"][];
  /** Days an order needed more than one strike or went partly unsold: the price chart's shading. [date, right, yield given up, unsold]. */
  tooLargeDays: [string, "C" | "P", number | null, number][];
  /** Call orders whose largest pot could not be computed: the engine did not record the shares' average cost. */
  callOrdersWithoutCost: number;
  /** Each order with a best contract: [date, right, its volume limit, its strike, the shares' cost (Calls; null for Puts)], so the window recomputes the largest pot at other values. */
  orders: [string, "C" | "P", number, number, number | null][];
}

export async function computeAnalysisBacktestFigures(sessionId: string, symbol: string, baseline: Pick<BacktestBaselineSettings, "ladderSharesPct" | "ladderRungs">, connection: Knex = db): Promise<AnalysisBacktestFigures> {
  const session = await connection("backtest_sessions").where({ id: sessionId }).first("name", "status", connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "metrics", "baseline_metrics");
  if (!session) throw new Error(`The analysis backtest session ${sessionId} is gone.`);
  const orders = await loadAnalysisOrders(sessionId, symbol, connection);
  const values = { shares: baseline.ladderSharesPct / 100, rungs: baseline.ladderRungs };
  const largestByDay = new Map<string, { pot: number; right: "C" | "P" }>();
  let callOrdersWithoutCost = 0;
  for (const order of orders) {
    const pot = largestPotOfOrder(order, values);
    if (pot === null) {
      if (order.right === "C" && order.best !== null && order.sharesAverageCost === null) callOrdersWithoutCost++;
      continue;
    }
    const kept = largestByDay.get(order.date);
    if (!kept || pot < kept.pot) largestByDay.set(order.date, { pot, right: order.right });
  }
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
    dailyLargestPot: [...largestByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, { pot, right }]) => [date, pot, right]),
    tooLargeDays: tooLarge.map((order) => [order.date, order.right, order.fills.length > 1 ? yieldGivenUp(order) : null, order.unsold]),
    callOrdersWithoutCost,
    orders: orders.filter((order) => order.best !== null).map((order) => [order.date, order.right, order.best!.volumeCap, order.best!.strike, order.right === "C" ? order.sharesAverageCost : null]),
  };
}
