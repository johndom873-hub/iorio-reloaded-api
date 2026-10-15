import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { median } from "./analysisPriceFigures.js";

// The Analyse window's pot sizing (formulas approved 2026-10-15). Too small: each day's smallest pot at that day's 10:00
// price as traded and shock, and whether the pot fit that day (fit over the history), the pot following the analysis
// backtest's account as live pots follow the account. Too large: each day's largest pot, from the best capped Put and the
// best entry Call the chain scan found; and from the analysis's own backtest, the orders that wanted more contracts than
// the best contract's volume limit, the yield that cost and what went unsold. The window takes the X% point of the daily
// values itself, so X changes at once.

export interface AnalysisFitDay {
  date: string;
  /** The 10:00 price as traded. */
  price: number;
  /** That day's shock from the rule, a fraction. */
  shock: number;
}

export interface AnalysisLadderValues {
  /** Share level, a fraction. */
  shares: number;
  rungs: number;
  /** A fixed shock (fraction) instead of each day's rule; null: the rule. */
  fixedShock: number | null;
}

/**
 * Each day: smallest pot = max(100 × P ÷ p, 100 × P × (n − S) ÷ (1 − p)); whether that day's pot bought a lot and a Put at
 * the first cap fit a rung. `potOnDay` null: no pot path (the fits are null).
 */
export function fitByDay(days: readonly AnalysisFitDay[], values: AnalysisLadderValues, potOnDay: ((date: string) => number) | null): { date: string; smallestPot: number; lotFits: boolean | null; rungFits: boolean | null }[] {
  const { shares: p, rungs: n } = values;
  return days.map((day) => {
    const shock = values.fixedShock ?? day.shock;
    const lotCost = day.price * 100;
    const pot = potOnDay?.(day.date) ?? null;
    return {
      date: day.date,
      smallestPot: Math.max(lotCost / p, (100 * day.price * (n - shock)) / (1 - p)),
      lotFits: pot === null ? null : pot * p >= lotCost,
      rungFits: pot === null ? null : (pot * (1 - p)) / n >= day.price * (1 - shock / n) * 100,
    };
  });
}

/** A day's largest-pot contracts: the best capped Put's volume limit and strike, the best entry Call's volume limit (null when none passed). */
export interface AnalysisLargestPotDay {
  date: string;
  price: number;
  putVolumeCap: number | null;
  putStrike: number | null;
  callVolumeCap: number | null;
}

/**
 * The day's largest pot (approved 2026-10-15): the smaller of the Put side, limit × strike × 100 × n ÷ (1 − p) (every rung
 * filled at that size fits the reserve), and the Call side, limit × 100 × P ÷ p (the shares those Calls cover, bought at
 * the 10:00 price, fit the shares' budget). Null when a side has no qualifying contract: the day is left out of the X%
 * point and counted apart (Marcelo 2026-10-15). `right` is the side that set it.
 */
export function largestPotOfDay(day: AnalysisLargestPotDay, values: Pick<AnalysisLadderValues, "shares" | "rungs">): { pot: number; right: "C" | "P" } | null {
  const putSide = day.putVolumeCap !== null && day.putStrike !== null ? (day.putVolumeCap * day.putStrike * 100 * values.rungs) / (1 - values.shares) : null;
  const callSide = day.callVolumeCap !== null ? (day.callVolumeCap * 100 * day.price) / values.shares : null;
  if (putSide === null || callSide === null) return null;
  return putSide <= callSide ? { pot: putSide, right: "P" } : { pot: callSide, right: "C" };
}

/**
 * The analysis backtest's pot path, as live pots follow the account (approved 2026-10-15): each day's base = the larger of
 * the account at the open cycle's start (the close before its first day) and last night's account (the starting value on
 * the first day); last night's alone while no cycle is open. `days` ascending.
 */
export function ladderBasePath(days: readonly { date: string; accountValue: number }[], cycles: readonly { openedOn: string; closedOn: string | null }[], startingValue: number): [string, number][] {
  const closeBefore = (dateIso: string) => {
    let value = startingValue;
    for (const day of days) {
      if (day.date >= dateIso) break;
      value = day.accountValue;
    }
    return value;
  };
  const cycleStarts = cycles.map((cycle) => ({ ...cycle, startValue: closeBefore(cycle.openedOn) }));
  return days.map((day, index) => {
    const lastNight = index === 0 ? startingValue : days[index - 1]!.accountValue;
    const cycle = cycleStarts.find((candidate) => candidate.openedOn <= day.date && (candidate.closedOn === null || day.date <= candidate.closedOn));
    return [day.date, cycle ? Math.max(cycle.startValue, lastNight) : lastNight];
  });
}

/** The pot on a day from a path: the path's value that day, else its latest before (carried forward past its last day); the first value before its first day. */
export function potOnDayFrom(path: readonly [string, number][]): ((date: string) => number) | null {
  if (path.length === 0) return null;
  const byDate = new Map(path);
  return (date) => {
    const exact = byDate.get(date);
    if (exact !== undefined) return exact;
    let value = path[0]![1];
    for (const [pathDate, pot] of path) {
      if (pathDate > date) break;
      value = pot;
    }
    return value;
  };
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
    const order = orders.get(key) ?? orders.set(key, { date: sale.trading_date as string, at, right, wanted: scores.wantedContracts ?? null, best, fills: [], unsold: 0, unsoldReason: null }).get(key)!;
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
