import type { Knex } from "knex";
import { db } from "../db/connection.js";

// The CC + Put Ladder's memory of a ticker's cycle between looks (pluto_ladder_cycles), the live counterpart of the
// backtest's LadderCycleState (backtestBaselineLadder.ts), with the live rules decided by Marcelo 2026-10-15:
//   - flat (no shares, no options): the account value is recorded at every look, the next cycle's starting value;
//   - a cycle starts at the first look that finds it open, its shock S fixed then (the ticker's override, else the
//     recommended one); a cycle already open when Pluto switches to the ladder starts at the switch (the rows are cleared
//     by the switch, so the first look finds no memory).
// The ladder's peak is not remembered: it is the average cost of the shares held (Marcelo 2026-10-15; selling Puts is
// meant to lower the break-even, so the floor follows what the shares cost, never the market's high), read from the
// holdings at each look (runningAverageShareCost, through the look book).

export interface LadderCycleMemory {
  /** Eastern date the cycle started; null while flat. */
  startedOn: string | null;
  /** The whole account's value at the cycle's start (while flat: at the last look). */
  accountValueAtStart: number;
  /** S as a fraction; null while flat. */
  shock: number | null;
}

export interface LadderCycleLook {
  /** The ticker holds shares or options. */
  cycleOpen: boolean;
  accountValue: number;
  todayIso: string;
  /** The shock a cycle starting today gets, percent: the ticker's override, else the recommended one. */
  shockPctIfStartingToday: number;
}

/** Pure: the memory after this look. */
export function nextLadderCycleMemory(kept: LadderCycleMemory | null, look: LadderCycleLook): LadderCycleMemory {
  if (!look.cycleOpen) return { startedOn: null, accountValueAtStart: look.accountValue, shock: null };
  if (kept?.startedOn) return kept;
  return { startedOn: look.todayIso, accountValueAtStart: kept?.accountValueAtStart ?? look.accountValue, shock: look.shockPctIfStartingToday / 100 };
}

type MemoryRow = { cycle_started_on: string | null; account_value_at_start: string; shock_fraction: string | null };

export async function loadLadderCycleMemory(tickerId: string, connection: Knex = db): Promise<LadderCycleMemory | null> {
  const row: MemoryRow | undefined = await connection("pluto_ladder_cycles").where({ ticker_id: tickerId }).first(connection.raw("cycle_started_on::text as cycle_started_on"), "account_value_at_start", "shock_fraction");
  if (!row) return null;
  return { startedOn: row.cycle_started_on, accountValueAtStart: Number(row.account_value_at_start), shock: row.shock_fraction === null ? null : Number(row.shock_fraction) };
}

export async function saveLadderCycleMemory(tickerId: string, memory: LadderCycleMemory, connection: Knex = db): Promise<void> {
  const row = { ticker_id: tickerId, cycle_started_on: memory.startedOn, account_value_at_start: memory.accountValueAtStart, shock_fraction: memory.shock, updated_at: connection.fn.now() };
  await connection("pluto_ladder_cycles").insert(row).onConflict("ticker_id").merge();
}

/** Every ticker's memory forgotten: run by the switch to the ladder, inside its transaction. */
export async function clearLadderCycleMemories(connection: Knex = db): Promise<void> {
  await connection("pluto_ladder_cycles").delete();
}
