import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { environment, ibkrMarketDataLinesEnabled } from "../config/env.js";
import { easternTodaySql } from "../lib/easternTodaySql.js";

// IBKR's market-data lines are shared across every connection on one TWS username (verified against IBKR's docs
// 2026-09-21), and the allocation is IBKR's formula: max(100, monthly commissions ÷ $8, equity × 100 ÷ $1M).
// Measured on prod's live login: 100 on 2026-11-23 at $964k net liquidation, exactly the formula.
//
// The budget follows that formula conservatively (Marcelo 2026-11-23):
//   - equity is the lowest net liquidation of the last 5 nightly snapshots, so a rise counts only once it has held;
//   - commissions are left out (which month IBKR counts is unknown, and our own record of them is incomplete);
//   - 10 lines stay spare for TWS and the one-shot lookups that aren't booked here (the health check's SPY probe);
//   - only on the live account: the paper login's allocation was never measured, so it stays at the floor;
//   - no snapshot in the last 7 days means the floor.
// Example: lowest of the last 5 nights $1,210,000 → max(100, 121) − 10 = 111 lines; at $964,402 → max(100, 96) − 10 = 90.
//
// Priority reservations (approved 2026-09-24): the market quote loop and
// Pluto's agent reserve their lines with `priority: true`. A priority reservation only has
// to fit alongside other priority reservations, and its lines are subtracted
// from what every non-priority holder may take — so live screens can never
// starve the loop; they get whatever is left ("Fit" variant) and the live
// pool sheds subscriptions to match (marketDataPool.ts).
export const ibkrMarketDataLineFloor = 100;
export const marketDataLineHeadroom = 10;
export const netLiquidationDollarsPerMarketDataLine = 10_000;
export const nightlySnapshotsForMarketDataLineCeiling = 5;
export const maximumSnapshotAgeDaysForMarketDataLineCeiling = 7;

/** The budget at IBKR's floor: what the paper login, and the live one without a recent snapshot, always get. */
export const totalMarketDataLineBudget = ibkrMarketDataLineFloor - marketDataLineHeadroom;

export interface MarketDataLineBudget {
  /** Lines every holder together may reserve. */
  budget: number;
  /** IBKR's allocation as this budget estimates it (budget + headroom). */
  estimatedIbkrCeiling: number;
  /** The net liquidation the estimate used (the lowest recent night), null when it used the floor. */
  netLiquidationUsed: number | null;
}

/** Pure: the budget from the recent nightly net liquidations (any order); only the live account follows equity. */
export function computeMarketDataLineBudget(input: { tradingMode: "paper" | "live"; recentNightlyNetLiquidations: number[] }): MarketDataLineBudget {
  const usable = input.recentNightlyNetLiquidations.filter((value) => Number.isFinite(value) && value > 0);
  if (input.tradingMode !== "live" || usable.length === 0) {
    return { budget: totalMarketDataLineBudget, estimatedIbkrCeiling: ibkrMarketDataLineFloor, netLiquidationUsed: null };
  }
  const lowestNetLiquidation = Math.min(...usable);
  const estimatedIbkrCeiling = Math.max(ibkrMarketDataLineFloor, Math.floor(lowestNetLiquidation / netLiquidationDollarsPerMarketDataLine));
  return { budget: estimatedIbkrCeiling - marketDataLineHeadroom, estimatedIbkrCeiling, netLiquidationUsed: lowestNetLiquidation };
}

/** The budget now: the last 5 nightly snapshots dated within the last 7 Eastern days. */
export async function loadMarketDataLineBudget(connection: Knex | Knex.Transaction = db, tradingMode: "paper" | "live" = environment.ibkrTradingMode): Promise<MarketDataLineBudget> {
  if (tradingMode !== "live") return computeMarketDataLineBudget({ tradingMode, recentNightlyNetLiquidations: [] });
  const { rows } = await connection.raw(
    `SELECT net_liquidation_value::float AS net_liquidation
       FROM account_pnl_snapshots
      WHERE net_liquidation_value IS NOT NULL
        AND snapshot_date > ${easternTodaySql} - ?::int
      ORDER BY snapshot_date DESC
      LIMIT ?`,
    [maximumSnapshotAgeDaysForMarketDataLineCeiling, nightlySnapshotsForMarketDataLineCeiling],
  );
  return computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: rows.map((row: { net_liquidation: number }) => row.net_liquidation) });
}

export interface LineReservationResult {
  ok: boolean;
  /** Lines free for this holder at the moment of the call — for shedding/error messages, not a promise they'll still be free on retry. */
  availableLines: number;
  /** Lines currently held by active priority reservations other than this holder (0 when none — "normal operation"). */
  priorityLinesHeld: number;
  /** True when IBKR_MARKET_DATA_LINES_ENABLED=false refused the reservation outright (no DB round trip, nothing held). */
  disabled?: boolean;
}

export interface ReserveMarketDataLinesOptions {
  priority?: boolean;
}

export interface LineUsage {
  priorityInUse: number;
  otherInUse: number;
}

/** Pure budget arithmetic: what a holder may take given everyone else's active reservations. */
export function computeAvailableLines(usage: LineUsage, priority: boolean, budget: number = totalMarketDataLineBudget): number {
  const available = priority ? budget - usage.priorityInUse : budget - usage.priorityInUse - usage.otherInUse;
  return Math.max(0, available);
}

/**
 * Reserves `lines` market-data lines under `holder` for `ttlSeconds`, failing
 * if the account-wide total (across every process sharing this DB, i.e. the
 * web dyno and any Heroku Scheduler one-off job) would exceed the budget.
 * Re-reserving the same holder replaces its previous reservation (size,
 * expiry and priority) rather than adding to it.
 */
export async function reserveMarketDataLines(holder: string, lines: number, ttlSeconds: number, options: ReserveMarketDataLinesOptions = {}): Promise<LineReservationResult> {
  const priority = options.priority ?? false;
  if (!ibkrMarketDataLinesEnabled()) return { ok: false, availableLines: 0, priorityLinesHeld: 0, disabled: true };
  return db.transaction(async (trx) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    // Postgres doesn't allow FOR UPDATE on an aggregate, so an advisory
    // transaction lock serializes concurrent reserve() calls instead — held
    // only until this transaction commits/rolls back, so a rejected
    // reservation never blocks the next caller.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('ibkr_market_data_line_reservations'))");
    const { rows } = await trx.raw(
      `SELECT COALESCE(SUM(lines) FILTER (WHERE priority), 0)::int AS priority_in_use,
              COALESCE(SUM(lines) FILTER (WHERE NOT priority), 0)::int AS other_in_use
         FROM ibkr_market_data_line_reservations
        WHERE expires_at > now() AND holder != ?`,
      [holder],
    );
    const usage: LineUsage = { priorityInUse: rows[0].priority_in_use, otherInUse: rows[0].other_in_use };
    const { budget } = await loadMarketDataLineBudget(trx);
    const availableLines = computeAvailableLines(usage, priority, budget);
    if (lines > availableLines) return { ok: false, availableLines, priorityLinesHeld: usage.priorityInUse };

    await trx("ibkr_market_data_line_reservations")
      .insert({ holder, lines, expires_at: expiresAt, priority })
      .onConflict("holder")
      .merge();
    return { ok: true, availableLines, priorityLinesHeld: usage.priorityInUse };
  });
}

/** Lines a non-priority holder could reserve right now, without reserving any (0 when lines are disabled here). */
export async function loadAvailableMarketDataLines(): Promise<number> {
  if (!ibkrMarketDataLinesEnabled()) return 0;
  const [{ rows }, { budget }] = await Promise.all([
    db.raw(
      `SELECT COALESCE(SUM(lines) FILTER (WHERE priority), 0)::int AS priority_in_use,
              COALESCE(SUM(lines) FILTER (WHERE NOT priority), 0)::int AS other_in_use
         FROM ibkr_market_data_line_reservations
        WHERE expires_at > now()`,
    ),
    loadMarketDataLineBudget(),
  ]);
  return computeAvailableLines({ priorityInUse: rows[0].priority_in_use, otherInUse: rows[0].other_in_use }, false, budget);
}

/** Extends an existing reservation's expiry — for a long-lived holder kept alive by a heartbeat. No-op if the reservation already expired; the next reserve() call will re-establish it. */
export async function renewMarketDataLineReservation(holder: string, ttlSeconds: number): Promise<void> {
  await db("ibkr_market_data_line_reservations")
    .where({ holder })
    .update({ expires_at: new Date(Date.now() + ttlSeconds * 1000) });
}

export async function releaseMarketDataLines(holder: string): Promise<void> {
  await db("ibkr_market_data_line_reservations").where({ holder }).del();
}

/** One sentence for a failed reservation, naming the scheduled scan (chain capture) when it's the reason. */
export function describeMarketDataLineShortage(result: LineReservationResult, what: string, linesNeeded: number): string {
  if (result.disabled) {
    return `IBKR market-data lines are disabled in this environment (IBKR_MARKET_DATA_LINES_ENABLED=false) — ${what} needs ${linesNeeded} lines.`;
  }
  if (result.priorityLinesHeld > 0) {
    return `IBKR market data is restricted while the market quote loop and Pluto hold their reserved lines (${result.priorityLinesHeld}) — ${what} needs ${linesNeeded} lines, ${result.availableLines} available. Try again shortly.`;
  }
  return `IBKR market data is busy (another live view) — ${what} needs ${linesNeeded} lines, only ${result.availableLines} available. Try again shortly.`;
}

export interface MarketDataLineUsage {
  inUse: number;
  budget: number;
  byUse: { label: string; lines: number }[];
}

// Holder name prefix (before the first ":") → what the lines are for, as shown on Pulse.
const lineHolderLabels: Record<string, string> = {
  marketDataPool: "Screens",
  marketQuoteLoop: "Market quote loop",
  optionSessionVolumeCapture: "Option volume capture",
  optionQuote: "Option quotes",
  snapshot: "Snapshots",
  pluto_agent: "Pluto",
};

/**
 * Pure: lines in use across every process sharing the IBKR login. The live pool counts the lines it
 * really has open (it can hold fewer than it reserved); every other holder fills its reservation for
 * as long as it holds it (the market quote loop keeps its window full, snapshots reserve exactly their size).
 */
export function summarizeMarketDataLineUsage(reservations: { holder: string; lines: number }[], poolOpenLines: number, budget: number): MarketDataLineUsage {
  const linesByLabel = new Map<string, number>([["Screens", poolOpenLines]]);
  for (const { holder, lines } of reservations) {
    const prefix = holder.split(":")[0]!;
    if (prefix === "marketDataPool") continue;
    const label = lineHolderLabels[prefix] ?? prefix;
    linesByLabel.set(label, (linesByLabel.get(label) ?? 0) + lines);
  }
  const byUse = [...linesByLabel].map(([label, lines]) => ({ label, lines })).filter((use) => use.lines > 0);
  return { inUse: byUse.reduce((sum, use) => sum + use.lines, 0), budget, byUse };
}

export async function loadActiveMarketDataLineReservations(): Promise<{ holder: string; lines: number }[]> {
  return db("ibkr_market_data_line_reservations").where("expires_at", ">", db.fn.now()).select("holder", "lines");
}
