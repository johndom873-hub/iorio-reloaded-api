import { connectToIbkrGateway, type IbkrConnection } from "../ibkr/connectIbkr.js";
import { topUpDailyBars } from "../ibkr/priceBarCache.js";
import { loadPendingStockSplits, type StockSplit } from "../lib/stockSplits.js";
import { loadEnabledPlutoTickerSettings } from "./tickerSettingsStore.js";

// The CC + Put Ladder's split check before the open (Marcelo 2026-10-15), run by the 09:00 UTC structure job: each ladder
// ticker's recent daily bars are fetched from IBKR and stored through the split check (dailyBarSplitCheck.ts), which
// records a split in stock_splits and replaces the price history when IBKR's prices show one. The nightly bar job does
// the same for every ticker; this one makes sure a split effective today is seen before the ladder's first look. A split
// IBKR's history does not show yet is caught at each look by the price guard (splitSuggestedByPrice).

export const ladderSplitCheckJobName = "ladder_split_check";

export interface LadderSplitCheckResult {
  checkedSymbols: string[];
  failed: { symbol: string; message: string }[];
  /** Splits still pending on the ladder's tickers after the check (records not yet rewritten to the new basis). */
  pendingSplits: (StockSplit & { symbol: string })[];
}

export interface LadderSplitCheckDependencies {
  loadLadderTickers(): Promise<{ tickerId: string; symbol: string }[]>;
  connect(): Promise<IbkrConnection>;
  topUp(connection: IbkrConnection, tickerId: string, symbol: string, reqId: number): Promise<unknown>;
  loadPendingSplits(tickerIds: string[]): Promise<StockSplit[]>;
}

export const defaultLadderSplitCheckDependencies: LadderSplitCheckDependencies = {
  loadLadderTickers: async () => (await loadEnabledPlutoTickerSettings()).map((ticker) => ({ tickerId: ticker.tickerId, symbol: ticker.symbol })),
  connect: connectToIbkrGateway,
  topUp: topUpDailyBars,
  loadPendingSplits: (tickerIds) => loadPendingStockSplits(tickerIds),
};

export async function runLadderSplitCheck(dependencies: LadderSplitCheckDependencies = defaultLadderSplitCheckDependencies): Promise<LadderSplitCheckResult> {
  const tickers = await dependencies.loadLadderTickers();
  const result: LadderSplitCheckResult = { checkedSymbols: [], failed: [], pendingSplits: [] };
  if (tickers.length === 0) return result;
  const connection = await dependencies.connect();
  try {
    for (const [index, ticker] of tickers.entries()) {
      try {
        await dependencies.topUp(connection, ticker.tickerId, ticker.symbol, 7000 + index * 10);
        result.checkedSymbols.push(ticker.symbol);
      } catch (error) {
        result.failed.push({ symbol: ticker.symbol, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    connection.disconnect();
  }
  const symbolById = new Map(tickers.map((ticker) => [ticker.tickerId, ticker.symbol]));
  result.pendingSplits = (await dependencies.loadPendingSplits(tickers.map((ticker) => ticker.tickerId))).map((split) => ({ ...split, symbol: symbolById.get(split.tickerId)! }));
  return result;
}

/** For runJob: every ticker failing is a failure, some failing completes with errors; a pending split is said in the details. */
export function describeLadderSplitCheckOutcome(result: LadderSplitCheckResult): { failureMessage?: string; completedWithErrors?: { errorCount: number; message: string } } {
  const failedText = result.failed.map((entry) => `${entry.symbol}: ${entry.message}`).join("; ");
  if (result.failed.length > 0 && result.checkedSymbols.length === 0) return { failureMessage: `no ladder ticker's daily bars could be checked for a split (${failedText})` };
  if (result.failed.length > 0) return { completedWithErrors: { errorCount: result.failed.length, message: `split check failed for ${failedText}` } };
  return {};
}
