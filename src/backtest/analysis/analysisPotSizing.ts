import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { median } from "./analysisPriceFigures.js";

// The Analyse window's pot sizing (formulas approved 2026-10-15). Too small: each day's smallest pot at that day's 10:00
// price as traded and shock, and whether the configured pot fit (fit over the history). Too large: from the analysis's own
// backtest, the orders that wanted more contracts than the best contract's volume limit, the yield that cost, what went
// unsold, and each order's largest pot. The window takes the X% point of the daily values itself, so X changes at once.

export interface AnalysisFitDay {
  date: string;
  /** The 10:00 price as traded. */
  price: number;
  /** That day's shock from the rule, a fraction. */
  shock: number;
}

export interface AnalysisLadderValues {
  potDollars: number;
  /** Share level, a fraction. */
  shares: number;
  rungs: number;
  /** A fixed shock (fraction) instead of each day's rule; null: the rule. */
  fixedShock: number | null;
}

/** Each day: smallest pot = max(100 × P ÷ p, 100 × P × (n − S) ÷ (1 − p)); whether the pot bought a lot and a Put at the first cap fit a rung. */
export function fitByDay(days: readonly AnalysisFitDay[], values: AnalysisLadderValues): { date: string; smallestPot: number; lotFits: boolean; rungFits: boolean }[] {
  const { potDollars: pot, shares: p, rungs: n } = values;
  return days.map((day) => {
    const shock = values.fixedShock ?? day.shock;
    const lotCost = day.price * 100;
    return {
      date: day.date,
      smallestPot: Math.max(lotCost / p, (100 * day.price * (n - shock)) / (1 - p)),
      lotFits: pot * p >= lotCost,
      rungFits: (pot * (1 - p)) / n >= day.price * (1 - shock / n) * 100,
    };
  });
}

/** By year: days, days a lot didn't fit, days a rung didn't fit. */
export function fitHistoryByYear(rows: ReturnType<typeof fitByDay>): Record<string, { days: number; lotFails: number; rungFails: number }> {
  const byYear: Record<string, { days: number; lotFails: number; rungFails: number }> = {};
  for (const row of rows) {
    const year = (byYear[row.date.slice(0, 4)] ??= { days: 0, lotFails: 0, rungFails: 0 });
    year.days++;
    if (!row.lotFits) year.lotFails++;
    if (!row.rungFits) year.rungFails++;
  }
  return byYear;
}

/** One order of the analysis's backtest: its sales down the ranking and what it left unsold. */
export interface AnalysisOrder {
  date: string;
  at: string;
  right: "C" | "P";
  wanted: number | null;
  best: { strike: number; dte: number; premiumYield: number; volumeCap: number } | null;
  fills: { contracts: number; premiumYield: number }[];
  unsold: number;
  unsoldReason: "cash" | "volume" | "no_candidate" | null;
  /** Call orders: the shares' cost: their average cost before the order, else (an entry, no shares held yet) the look's price they are bought at; null when the engine recorded neither. */
  sharesAverageCost: number | null;
}

/** The orders of a session for a symbol: filled sales grouped by look, right and best candidate, plus the shortfall rows cut by volume or cash. */
export async function loadAnalysisOrders(sessionId: string, symbol: string, connection: Knex = db): Promise<AnalysisOrder[]> {
  const sales = await connection("backtest_actions")
    .where({ session_id: sessionId, symbol, outcome: "filled" })
    .whereIn("kind", ["open_cash_secured_put", "open_covered_call"])
    .whereNotNull("candidate_scores")
    .orderBy("sequence")
    .select(connection.raw("trading_date::text as trading_date"), "at", "contract", "candidate_scores", "quantity");
  const orders = new Map<string, AnalysisOrder>();
  for (const sale of sales) {
    const scores = sale.candidate_scores as Record<string, number | undefined>;
    const contract = sale.contract as { right?: "C" | "P" } | null;
    const right = contract?.right ?? "P";
    const at = new Date(sale.at).toISOString();
    const best = scores.bestCandidateStrike === undefined ? null : { strike: scores.bestCandidateStrike!, dte: scores.bestCandidateDte!, premiumYield: scores.bestCandidatePremiumYield!, volumeCap: scores.bestCandidateVolumeCap! };
    const key = `${at}|${right}|${best?.strike ?? ""}|${best?.dte ?? ""}|${scores.wantedContracts ?? ""}`;
    const order = orders.get(key) ?? orders.set(key, { date: sale.trading_date as string, at, right, wanted: scores.wantedContracts ?? null, best, fills: [], unsold: 0, unsoldReason: null, sharesAverageCost: right === "C" ? (scores.sharesAverageCostBefore ?? scores.stockPriceAtLook ?? null) : null }).get(key)!;
    order.fills.push({ contracts: Number(sale.quantity), premiumYield: scores.premiumYield ?? 0 });
  }
  const shortfalls = await connection("backtest_look_shortfalls").where({ session_id: sessionId, symbol }).whereIn("reason", ["volume", "cash"]).select("at", "option_right", "unsold_contracts", "reason");
  for (const shortfall of shortfalls) {
    const at = new Date(shortfall.at).toISOString();
    const order = [...orders.values()].find((candidate) => candidate.at === at && candidate.right === shortfall.option_right);
    if (!order) continue;
    order.unsold += Number(shortfall.unsold_contracts ?? 0);
    order.unsoldReason = shortfall.reason;
  }
  return [...orders.values()];
}

/** Yield given up = the best contract's premium yield − the contract-weighted yield of what the order filled. */
export function yieldGivenUp(order: AnalysisOrder): number | null {
  const filled = order.fills.reduce((sum, fill) => sum + fill.contracts, 0);
  if (order.best === null || filled === 0) return null;
  return order.best.premiumYield - order.fills.reduce((sum, fill) => sum + fill.contracts * fill.premiumYield, 0) / filled;
}

/**
 * Each order's largest pot (formula approved 2026-10-15): the pot whose order still fits the best contract's volume limit.
 * Put: limit × strike × 100 × n ÷ (1 − p). Call: limit × 100 × the shares' cost ÷ p (every lot held wants a Call; an entry's
 * shares cost the look's price, approved 2026-10-15).
 */
export function largestPotOfOrder(order: AnalysisOrder, values: Pick<AnalysisLadderValues, "shares" | "rungs">): number | null {
  if (order.best === null || !(order.best.volumeCap > 0)) return null;
  if (order.right === "P") return (order.best.volumeCap * order.best.strike * 100 * values.rungs) / (1 - values.shares);
  return order.sharesAverageCost === null ? null : (order.best.volumeCap * 100 * order.sharesAverageCost) / values.shares;
}

export interface AnalysisTooLargeYear {
  saleDays: number;
  callDaysOverOneStrike: number;
  putDaysOverOneStrike: number;
  medianYieldGivenUp: number | null;
  callDaysPartlyUnsold: number;
  putDaysPartlyUnsold: number;
}

/** By year: sale days, days an order needed more than one strike (Calls, Puts), the median yield given up over those orders, days part of an order went unsold. */
export function tooLargeByYear(orders: readonly AnalysisOrder[]): Record<string, AnalysisTooLargeYear> {
  const byYear: Record<string, AnalysisTooLargeYear> = {};
  const years = new Set(orders.map((order) => order.date.slice(0, 4)));
  for (const year of years) {
    const yearOrders = orders.filter((order) => order.date.startsWith(year));
    const days = (predicate: (order: AnalysisOrder) => boolean) => new Set(yearOrders.filter(predicate).map((order) => order.date)).size;
    const multi = (order: AnalysisOrder) => order.fills.length > 1;
    byYear[year] = {
      saleDays: days((order) => order.fills.length > 0),
      callDaysOverOneStrike: days((order) => order.right === "C" && multi(order)),
      putDaysOverOneStrike: days((order) => order.right === "P" && multi(order)),
      medianYieldGivenUp: median(yearOrders.filter(multi).map(yieldGivenUp).filter((value): value is number => value !== null)),
      callDaysPartlyUnsold: days((order) => order.right === "C" && order.unsold > 0),
      putDaysPartlyUnsold: days((order) => order.right === "P" && order.unsold > 0),
    };
  }
  return byYear;
}
