import type { Knex } from "knex";
import type { VolFarmerV3AlwaysHoldTheStock } from "../backtest/backtestTypes.js";
import { db } from "../db/connection.js";
import { loadBooksLiveState } from "../books/bookFigures.js";
import { loadPlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadPlutoTickerSettings, tickerPotFraction } from "./tickerSettingsStore.js";

// Each shortlisted ticker's allocation, pot and Always hold the stock as Pluto's Tickers tab shows them (Marcelo
// 2026-10-28; Always hold the stock 2026-11-03): what the CC + Put Ladder's settings read used to carry, kept for Vol
// Farmer v4 when the Ladder retired (2026-11-02).

export interface PlutoTickerAllocation {
  symbol: string;
  /** The ticker is enabled in Pluto. */
  enabled: boolean;
  /** The ticker's set allocation, % of Pluto's capital budget; null = an equal share (effectiveAllocationPctBySymbol). */
  allocationPct: number | null;
  /**
   * The ticker's pot in dollars, while it is enabled in Pluto: allocation (effective) × (1 + the excess allowance) ×
   * Pluto's book value now (tickerPotFraction), the value its rounds and the order route size the pots on (2026-11-09;
   * was last night's snapshot, $0 on the day Pluto was funded). Null when the ticker is not enabled or the books are not started.
   */
  potDollars: number | null;
  /** Pluto's book value now; null before the books are started. */
  plutoBookValueDollars: number | null;
  /** The ticker's own Always hold the stock (Marcelo 2026-11-03); null = Pluto's setting, alwaysHoldTheStockEffective. */
  alwaysHoldTheStock: VolFarmerV3AlwaysHoldTheStock | null;
  /** What the ticker follows: its own value, else Pluto's volFarmerV4AlwaysHoldTheStock. */
  alwaysHoldTheStockEffective: VolFarmerV3AlwaysHoldTheStock;
}

/** Pluto's book value now, as its rounds read it (src/books/bookFigures.ts); null before the books are started. */
export async function loadPlutoBookValueNow(): Promise<number | null> {
  const books = await loadBooksLiveState({ withoutAccountSummary: true });
  return books.ready ? books.books.pluto.bookValue : null;
}

/** The allocation and pot of each of `symbols` (upper case); the shared reads are made once. */
export async function loadPlutoTickerAllocations(symbols: readonly string[], connection: Knex = db): Promise<PlutoTickerAllocation[]> {
  const [settings, enabledTickers, plutoBookValueDollars] = await Promise.all([loadPlutoSettings(connection), loadEnabledPlutoTickerSettings(connection), loadPlutoBookValueNow()]);
  const effectiveBySymbol = effectiveAllocationPctBySymbol(enabledTickers);
  return Promise.all(
    symbols.map(async (symbol) => {
      const tickerSettings = await loadPlutoTickerSettings(symbol, connection);
      const enabled = enabledTickers.some((ticker) => ticker.symbol === symbol);
      const effectivePct = effectiveBySymbol.get(symbol);
      const potDollars = enabled && effectivePct !== undefined && plutoBookValueDollars !== null ? plutoBookValueDollars * tickerPotFraction(effectivePct, settings) : null;
      const alwaysHoldTheStock = tickerSettings?.alwaysHoldTheStock ?? null;
      return { symbol, enabled, allocationPct: tickerSettings?.allocationPct ?? null, potDollars, plutoBookValueDollars, alwaysHoldTheStock, alwaysHoldTheStockEffective: alwaysHoldTheStock ?? settings.volFarmerV4AlwaysHoldTheStock };
    }),
  );
}
