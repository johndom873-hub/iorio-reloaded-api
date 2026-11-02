import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadPlutoTickerSettings, tickerPotFraction } from "./tickerSettingsStore.js";

// Each shortlisted ticker's allocation and pot as Pluto's Tickers tab shows them (Marcelo 2026-10-28): what the CC + Put
// Ladder's settings read used to carry, kept for Vol Farmer v4 when the Ladder retired (2026-11-02).

export interface PlutoTickerAllocation {
  symbol: string;
  /** The ticker is enabled in Pluto. */
  enabled: boolean;
  /** The ticker's set allocation, % of Pluto's capital budget; null = an equal share (effectiveAllocationPctBySymbol). */
  allocationPct: number | null;
  /**
   * The ticker's pot in dollars, while it is enabled in Pluto: allocation (effective) × (1 + the excess allowance) ×
   * Pluto's capital budget at last night's account value (tickerPotFraction). Null when the ticker is not enabled or no
   * account value is recorded.
   */
  potDollars: number | null;
  /** Pluto's capital budget in dollars at last night's account value; null when none is recorded. */
  capitalBudgetDollars: number | null;
}

/** The allocation and pot of each of `symbols` (upper case); the shared reads are made once. */
export async function loadPlutoTickerAllocations(symbols: readonly string[], connection: Knex = db): Promise<PlutoTickerAllocation[]> {
  const [settings, enabledTickers, lastSnapshot] = await Promise.all([
    loadPlutoSettings(connection),
    loadEnabledPlutoTickerSettings(connection),
    connection("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value"),
  ]);
  const accountValue = lastSnapshot ? Number(lastSnapshot.net_liquidation_value) : null;
  const capitalBudgetDollars = accountValue === null ? null : (accountValue * settings.capitalBudgetPct) / 100;
  const effectiveBySymbol = effectiveAllocationPctBySymbol(enabledTickers);
  return Promise.all(
    symbols.map(async (symbol) => {
      const tickerSettings = await loadPlutoTickerSettings(symbol, connection);
      const enabled = enabledTickers.some((ticker) => ticker.symbol === symbol);
      const effectivePct = effectiveBySymbol.get(symbol);
      const potDollars = enabled && effectivePct !== undefined && accountValue !== null ? accountValue * tickerPotFraction(effectivePct, settings) : null;
      return { symbol, enabled, allocationPct: tickerSettings?.allocationPct ?? null, potDollars, capitalBudgetDollars };
    }),
  );
}
