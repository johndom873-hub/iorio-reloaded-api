import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { ladderRungReached, type LadderPutBlock } from "../engine/backtestBaselineLadder.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";

// A CC + Put Ladder session's ladder on its price chart (sessionPriceChart.ts) and in its cycle detail: the ladder's levels
// and rungs sold, and its orders that needed more than one strike or went partly unsold. They were the Ladder's Analyse
// window's until Vol Farmer v4 replaced that window (Marcelo 2026-11-01); the Sessions screen keeps them.

export interface SessionLadderFigures {
  /**
   * Each day the cycle held shares (the day's first look, before its orders), split-adjusted as the price chart: [date, the
   * next ladder put's cap (null: none fits), the floor, why no ladder put could be sold (null: one could)]. Empty for a
   * session run before the levels were recorded.
   */
  ladderLevels: [string, number | null, number | null, LadderPutBlock | null][];
  /**
   * Each rung sold, split-adjusted: [date, its highest strike, its fills [strike, expiry, contracts], the rung it reaches
   * [its number, the ticker's rungs, the reserve's slices it fills up to, the reserve committed before it in dollars] (null
   * when its sale recorded no reserve)].
   */
  ladderRungsSold: [string, number, [number, string, number][], [number, number, number, number] | null][];
}

/** Days an order needed more than one strike or went partly unsold: the price chart's shading. [date, right, yield given up, unsold]. */
export type SessionTooLargeDay = [string, "C" | "P", number | null, number];

/** One order of a session: its sales down the ranking and what it left unsold. */
export interface SessionOrder {
  date: string;
  at: string;
  right: "C" | "P";
  wanted: number | null;
  best: { strike: number; dte: number; premiumYield: number; volumeCap: number } | null;
  fills: { contracts: number; premiumYield: number }[];
  unsold: number;
  unsoldReason: "cash" | "volume" | "no_candidate" | null;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** The orders of a session for a symbol: filled sales grouped by look, right and best candidate, plus the shortfall rows cut by volume or cash. */
export async function loadSessionOrders(sessionId: string, symbol: string, connection: Knex = db): Promise<SessionOrder[]> {
  const sales = await connection("backtest_actions")
    .where({ session_id: sessionId, symbol, outcome: "filled" })
    .whereIn("kind", ["open_cash_secured_put", "open_covered_call"])
    .whereNotNull("candidate_scores")
    .orderBy("sequence")
    .select(connection.raw("trading_date::text as trading_date"), "at", "contract", "candidate_scores", "quantity");
  const orders = new Map<string, SessionOrder>();
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
export function yieldGivenUp(order: SessionOrder): number | null {
  const filled = order.fills.reduce((sum, fill) => sum + fill.contracts, 0);
  if (order.best === null || filled === 0) return null;
  return order.best.premiumYield - order.fills.reduce((sum, fill) => sum + fill.contracts * fill.premiumYield, 0) / filled;
}

/** The orders that needed more than one strike or went partly unsold, as the price chart shades them. */
export function tooLargeDaysOf(orders: readonly SessionOrder[]): SessionTooLargeDay[] {
  return orders.filter((order) => order.fills.length > 1 || order.unsold > 0).map((order) => [order.date, order.right, order.fills.length > 1 ? yieldGivenUp(order) : null, order.unsold]);
}

/** The ladder's rung count a session ran a symbol with: its own pot's value in a session of pots, else the session's. */
export async function loadLadderRungs(sessionId: string, symbol: string, connection: Knex = db): Promise<number | null> {
  const session = await connection("backtest_sessions").where({ id: sessionId }).first("settings_snapshot", "overrides", "book_mode", "symbol_settings");
  if (!session) return null;
  const tickerRungs = session.book_mode === "pots" ? session.symbol_settings?.[symbol]?.baseline?.ladderRungs : undefined;
  return tickerRungs ?? applyBacktestOverrides(session.settings_snapshot, session.overrides ?? {}).baseline.ladderRungs;
}

/** The ladder's levels and rungs sold of a symbol in a session, split-adjusted by each day's recorded factor. */
export async function loadSessionLadder(sessionId: string, symbol: string, connection: Knex = db): Promise<SessionLadderFigures> {
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
  const rungsSold = new Map<string, SessionLadderFigures["ladderRungsSold"][number]>();
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
