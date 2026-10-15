import type { Knex } from "knex";
import { db } from "../db/connection.js";

// The CC + Put Ladder's memory of a ticker's cycle between looks (pluto_ladder_cycles), the live counterpart of the
// backtest's LadderCycleState (backtestBaselineLadder.ts), with the live rules decided by Marcelo 2026-10-15:
//   - flat (no shares, no options): the account value is recorded at every look, the next cycle's starting value;
//   - a cycle starts at the first look that finds it open, its shock S fixed then (the ticker's override, else the
//     recommended one); a cycle already open when Pluto switches to the ladder starts at the switch (the rows are cleared
//     by the switch, so the first look finds no memory);
//   - the peak starts at the shares' average cost the first time the cycle holds shares (shares taken over at the switch,
//     the strike of an assigned Put, or the ladder's own purchase), then rises with the live price at each look; a cycle
//     of Puts alone has no peak.
// Prices are not adjusted for a split during a cycle.

export interface LadderCycleMemory {
  /** Eastern date the cycle started; null while flat. */
  startedOn: string | null;
  /** The whole account's value at the cycle's start (while flat: at the last look). */
  accountValueAtStart: number;
  /** Null until the cycle holds shares. */
  peakPrice: number | null;
  /** S as a fraction; null while flat. */
  shock: number | null;
}

export interface LadderCycleLook {
  /** The ticker holds shares or options. */
  cycleOpen: boolean;
  sharesHeld: number;
  /** The shares' running average cost per share; null without shares. */
  sharesAverageCost: number | null;
  stockPrice: number;
  accountValue: number;
  todayIso: string;
  /** The shock a cycle starting today gets, percent: the ticker's override, else the recommended one. */
  shockPctIfStartingToday: number;
}

/** Pure: the memory after this look. */
export function nextLadderCycleMemory(kept: LadderCycleMemory | null, look: LadderCycleLook): LadderCycleMemory {
  if (!look.cycleOpen) return { startedOn: null, accountValueAtStart: look.accountValue, peakPrice: null, shock: null };
  const started: LadderCycleMemory = kept?.startedOn ? kept : { startedOn: look.todayIso, accountValueAtStart: kept?.accountValueAtStart ?? look.accountValue, peakPrice: null, shock: look.shockPctIfStartingToday / 100 };
  const firstPeak = look.sharesHeld > 0 && look.sharesAverageCost !== null ? look.sharesAverageCost : null;
  const peakFrom = started.peakPrice ?? firstPeak;
  return { ...started, peakPrice: peakFrom === null ? null : Math.max(peakFrom, look.stockPrice) };
}

type MemoryRow = { cycle_started_on: string | null; account_value_at_start: string; peak_price: string | null; shock_fraction: string | null };

export async function loadLadderCycleMemory(tickerId: string, connection: Knex = db): Promise<LadderCycleMemory | null> {
  const row: MemoryRow | undefined = await connection("pluto_ladder_cycles").where({ ticker_id: tickerId }).first(connection.raw("cycle_started_on::text as cycle_started_on"), "account_value_at_start", "peak_price", "shock_fraction");
  if (!row) return null;
  return {
    startedOn: row.cycle_started_on,
    accountValueAtStart: Number(row.account_value_at_start),
    peakPrice: row.peak_price === null ? null : Number(row.peak_price),
    shock: row.shock_fraction === null ? null : Number(row.shock_fraction),
  };
}

export async function saveLadderCycleMemory(tickerId: string, memory: LadderCycleMemory, connection: Knex = db): Promise<void> {
  const row = { ticker_id: tickerId, cycle_started_on: memory.startedOn, account_value_at_start: memory.accountValueAtStart, peak_price: memory.peakPrice, shock_fraction: memory.shock, updated_at: connection.fn.now() };
  await connection("pluto_ladder_cycles").insert(row).onConflict("ticker_id").merge();
}

/** Every ticker's memory forgotten: run by the switch to the ladder, inside its transaction. */
export async function clearLadderCycleMemories(connection: Knex = db): Promise<void> {
  await connection("pluto_ladder_cycles").delete();
}
