import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { volFarmerV2BreakEven, type VolFarmerV2Position } from "../backtest/engine/volFarmerV2Steps.js";
import { volFarmerV2MemoryFromStored, type VolFarmerV2Memory, type VolFarmerV2OrderKind } from "./volFarmerV2LiveBook.js";
import type { VolFarmerV2RoundFigures } from "./volFarmerV2LookLoader.js";
import { effectivePlutoStrategy, loadEnabledPlutoTickerSettings } from "./tickerSettingsStore.js";

// The Pluto screen's Vol Farmer v2 card: each enabled ticker running v2, its two positions and LEAPS as v2's memory
// counts them (pluto_vol_farmer_v2_cycles), the orders still working and what its last round said.

/** An option a position holds: a leg of the book, or an order still working (its leg not known yet). */
export interface VolFarmerV2ScreenOption {
  strike: number;
  expiry: string;
  contracts: number;
  working: boolean;
}

export interface VolFarmerV2ScreenPosition {
  shares: number;
  /** What each share cost: the first position's at the cycle's break-even when adopted, the second's its assigned Put's strike. */
  costPerShare: number;
  /** B-E¹ / B-E²: what each share cost less the premiums kept per share; null while the second position holds no shares. */
  breakEvenPerShare: number | null;
  calls: VolFarmerV2ScreenOption[];
  puts: VolFarmerV2ScreenOption[];
}

export interface VolFarmerV2ScreenTicker {
  symbol: string;
  /** When v2 adopted the ticker's holdings; null for a cycle v2 opened itself. */
  adoptedAt: string | null;
  /** v2 has no memory of the ticker yet: it waits to adopt its holdings (the last round's notes say why), or has not looked yet. */
  waiting: boolean;
  first: VolFarmerV2ScreenPosition | null;
  second: VolFarmerV2ScreenPosition | null;
  leaps: { strike: number; expiry: string; heldContracts: number; intendedContracts: number } | null;
  workingOrders: { kind: VolFarmerV2OrderKind; strike: number; expiry: string; contracts: number }[];
  lastRoundAt: string | null;
  lastRoundNotes: string[];
  lastRoundFigures: VolFarmerV2RoundFigures | null;
}

interface CycleRow {
  ticker_id: string;
  memory: VolFarmerV2Memory | null;
  adopted_at: Date | null;
  last_round_at: Date | null;
  last_round_notes: string[] | null;
  last_round_figures: VolFarmerV2RoundFigures | null;
}

export async function loadVolFarmerV2Screen(connection: Knex = db): Promise<VolFarmerV2ScreenTicker[]> {
  const tickers = (await loadEnabledPlutoTickerSettings(connection)).filter((ticker) => effectivePlutoStrategy(ticker) === "vol_farmer_v2");
  if (tickers.length === 0) return [];
  const rows: CycleRow[] = await connection("pluto_vol_farmer_v2_cycles").whereIn("ticker_id", tickers.map((ticker) => ticker.tickerId)).select("ticker_id", "memory", "adopted_at", "last_round_at", "last_round_notes", "last_round_figures");
  const rowByTickerId = new Map(rows.map((row) => [row.ticker_id, row]));
  const legIds = rows.flatMap((row) => (row.memory === null ? [] : memoryLegIds(row.memory))).filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:"));
  const legs: { id: string; strike_price: string | null; expiry_date: string | null; quantity: number; exit_at: Date | null }[] =
    legIds.length === 0 ? [] : await connection("position_legs").whereIn("id", [...new Set(legIds)]).select("id", "strike_price", connection.raw("expiry_date::text as expiry_date"), "quantity", "exit_at");
  const legById = new Map(legs.map((leg) => [leg.id, leg]));
  return tickers.map((ticker) => {
    const row = rowByTickerId.get(ticker.tickerId);
    const memory = row?.memory ? volFarmerV2MemoryFromStored(row.memory) : null;
    const optionOf = (legId: string, shares: number): VolFarmerV2ScreenOption | null => {
      const contracts = Math.round(shares / sharesPerContract);
      const pending = memory?.pending.find((order) => order.ref === legId);
      if (pending) return { strike: pending.strike, expiry: pending.expiry, contracts, working: true };
      const leg = legById.get(legId);
      if (!leg || leg.strike_price === null || leg.expiry_date === null) return null;
      return { strike: Number(leg.strike_price), expiry: leg.expiry_date, contracts, working: false };
    };
    const positionOf = (position: VolFarmerV2Position | null): VolFarmerV2ScreenPosition | null =>
      position === null
        ? null
        : {
            shares: position.shares,
            costPerShare: position.costPerShare,
            breakEvenPerShare: volFarmerV2BreakEven(position),
            calls: position.calls.flatMap((call) => optionOf(call.legId, call.shares) ?? []),
            puts: position.puts.flatMap((put) => optionOf(put.legId, put.shares) ?? []),
          };
    const leaps = memory?.state.leaps ?? null;
    return {
      symbol: ticker.symbol,
      adoptedAt: row?.adopted_at?.toISOString() ?? null,
      waiting: memory === null,
      first: positionOf(memory?.state.first ?? null),
      second: positionOf(memory?.state.second ?? null),
      leaps:
        leaps === null
          ? null
          : {
              strike: leaps.strike,
              expiry: leaps.expiry,
              heldContracts: leaps.legIds.reduce((sum, legId) => {
                const leg = legById.get(legId);
                return sum + (leg && leg.exit_at === null ? leg.quantity : 0);
              }, 0),
              intendedContracts: leaps.intendedContracts,
            },
      workingOrders: (memory?.pending ?? []).map((order) => ({ kind: order.kind, strike: order.strike, expiry: order.expiry, contracts: order.contracts })),
      lastRoundAt: row?.last_round_at?.toISOString() ?? null,
      lastRoundNotes: row?.last_round_notes ?? [],
      lastRoundFigures: row?.last_round_figures ?? null,
    };
  });
}

function memoryLegIds(memory: VolFarmerV2Memory): string[] {
  const { first, second, leaps } = memory.state;
  return [...[first, second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((option) => option.legId))), ...(leaps?.legIds ?? [])];
}
