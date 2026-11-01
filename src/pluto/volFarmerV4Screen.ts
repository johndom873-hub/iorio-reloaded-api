import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { volFarmerV2BreakEven, type VolFarmerV2Position } from "../backtest/engine/volFarmerV2Steps.js";
import { volFarmerV4MemoryFromStored, type VolFarmerV4Memory, type VolFarmerV4OrderKind } from "./volFarmerV4LiveBook.js";
import type { VolFarmerV4RoundFigures } from "./volFarmerV4LookLoader.js";
import { effectivePlutoStrategy, loadEnabledPlutoTickerSettings } from "./tickerSettingsStore.js";

// The Pluto screen's Vol Farmer v4 card: each enabled ticker running v4, its two positions and LEAPS as v4's memory
// counts them (pluto_vol_farmer_v4_cycles), the orders still working and what its last round said.

/** An option a position holds: a leg of the book, or an order still working (its leg not known yet). */
export interface VolFarmerV4ScreenOption {
  strike: number;
  expiry: string;
  contracts: number;
  working: boolean;
}

export interface VolFarmerV4ScreenPosition {
  shares: number;
  /** What each share cost: the first position's at the cycle's break-even when adopted, the second's its assigned Put's strike. */
  costPerShare: number;
  /** B-E¹ / B-E²: what each share cost less the premiums kept per share; null while the second position holds no shares. */
  breakEvenPerShare: number | null;
  calls: VolFarmerV4ScreenOption[];
  puts: VolFarmerV4ScreenOption[];
}

export interface VolFarmerV4ScreenTicker {
  symbol: string;
  /** When v4 (or v2 before it) adopted the ticker's holdings; null for a cycle it opened itself. */
  adoptedAt: string | null;
  /** v4 has no memory of the ticker yet: it waits to adopt its holdings (the last round's notes say why), or has not looked yet. */
  waiting: boolean;
  first: VolFarmerV4ScreenPosition | null;
  second: VolFarmerV4ScreenPosition | null;
  leaps: { strike: number; expiry: string; heldContracts: number; intendedContracts: number } | null;
  /** The orders still working: an option order's contract and contracts, a share order's shares (its strike 0 and expiry ""). */
  workingOrders: { kind: VolFarmerV4OrderKind; strike: number; expiry: string; contracts: number; shares: number | null }[];
  lastRoundAt: string | null;
  lastRoundNotes: string[];
  lastRoundFigures: VolFarmerV4RoundFigures | null;
}

interface CycleRow {
  ticker_id: string;
  memory: VolFarmerV4Memory | null;
  adopted_at: Date | null;
  last_round_at: Date | null;
  last_round_notes: string[] | null;
  last_round_figures: VolFarmerV4RoundFigures | null;
}

export async function loadVolFarmerV4Screen(connection: Knex = db): Promise<VolFarmerV4ScreenTicker[]> {
  const tickers = (await loadEnabledPlutoTickerSettings(connection)).filter((ticker) => effectivePlutoStrategy(ticker) === "vol_farmer_v4");
  if (tickers.length === 0) return [];
  const rows: CycleRow[] = await connection("pluto_vol_farmer_v4_cycles").whereIn("ticker_id", tickers.map((ticker) => ticker.tickerId)).select("ticker_id", "memory", "adopted_at", "last_round_at", "last_round_notes", "last_round_figures");
  const rowByTickerId = new Map(rows.map((row) => [row.ticker_id, row]));
  const legIds = rows.flatMap((row) => (row.memory === null ? [] : memoryLegIds(row.memory))).filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:"));
  const legs: { id: string; strike_price: string | null; expiry_date: string | null; quantity: number; exit_at: Date | null }[] =
    legIds.length === 0 ? [] : await connection("position_legs").whereIn("id", [...new Set(legIds)]).select("id", "strike_price", connection.raw("expiry_date::text as expiry_date"), "quantity", "exit_at");
  const legById = new Map(legs.map((leg) => [leg.id, leg]));
  return tickers.map((ticker) => {
    const row = rowByTickerId.get(ticker.tickerId);
    const memory = row?.memory ? volFarmerV4MemoryFromStored(row.memory) : null;
    const optionOf = (legId: string, shares: number): VolFarmerV4ScreenOption | null => {
      const contracts = Math.round(shares / sharesPerContract);
      const pending = memory?.pending.find((order) => order.ref === legId);
      if (pending) return { strike: pending.strike, expiry: pending.expiry, contracts, working: true };
      const leg = legById.get(legId);
      if (!leg || leg.strike_price === null || leg.expiry_date === null) return null;
      return { strike: Number(leg.strike_price), expiry: leg.expiry_date, contracts, working: false };
    };
    const positionOf = (position: VolFarmerV2Position | null): VolFarmerV4ScreenPosition | null =>
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
      workingOrders: (memory?.pending ?? []).map((order) => ({ kind: order.kind, strike: order.strike, expiry: order.expiry, contracts: order.contracts, shares: order.shares ?? null })),
      lastRoundAt: row?.last_round_at?.toISOString() ?? null,
      lastRoundNotes: row?.last_round_notes ?? [],
      lastRoundFigures: row?.last_round_figures ?? null,
    };
  });
}

function memoryLegIds(memory: VolFarmerV4Memory): string[] {
  const { first, second, leaps } = memory.state;
  return [...[first, second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((option) => option.legId))), ...(leaps?.legIds ?? [])];
}
