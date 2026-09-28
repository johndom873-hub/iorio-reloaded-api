import { connectToIbkrGateway } from "./connectIbkr.js";
import { IbkrLookupTimeoutError, refreshStoredOptionChain, type OptionChainRefreshTimings } from "./fetchOptionChain.js";
import { loadCaptureUniverse, type UniverseTicker } from "./runOptionChainCapture.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { loadFallbackStockPrices } from "../lib/priceService.js";

// Split off runOptionChainCapture.ts 2026-09-23: chain STRUCTURE (expiries +
// each expiry's real strike grid) is plain IBKR contract-definition data,
// not gated on the market being open, so it runs pre-market — see
// scripts/run-option-chain-structure-job.ts. The nightly capture job
// (option_chain_capture) now reads what this job wrote (fetchOptionChain.ts's
// loadStoredOptionChain) instead of refreshing structure itself, and is
// ticks-only, which does need the market open for real quotes.

type IbkrApi = Parameters<typeof refreshStoredOptionChain>[0];

// Incremental structure (approved by Marcelo): a stored strike grid is reused
// while younger than this and spot sits inside its strike range, so a daily
// run only looks up new expiries and grids due a re-check. Looking up every
// in-window expiry every run (~180 back-to-back wildcard lookups) gets
// throttled by IBKR, and the stall takes the whole Gateway session with it.
export const structureGridMaxAgeDays = 7;

export type OptionChainStructureEvent =
  | { type: "tickerDone"; symbol: string; expiryCount: number; strikeCount: number; timings: OptionChainRefreshTimings }
  | { type: "tickerError"; symbol: string; message: string }
  | { type: "aborted"; afterSymbol: string; skippedSymbols: string[] };

export interface OptionChainStructureResult {
  tickersAttempted: number;
  tickersComplete: number;
  tickersFailed: number;
  failedSymbols: string[];
  /** Not attempted: the run stopped at the first IBKR timeout (see IbkrLookupTimeoutError). */
  skippedSymbols: string[];
  gridLookups: number;
  gridsReused: number;
}

/** Everything runOptionChainStructureRefresh touches outside itself; injectable so the run logic is testable offline. */
export interface OptionChainStructureDependencies {
  now: () => Date;
  loadUniverse: () => Promise<UniverseTicker[]>;
  connect: () => Promise<{ ib: IbkrApi; disconnect: () => void }>;
  refreshStoredOptionChain: typeof refreshStoredOptionChain;
  loadSpotPrices: (symbols: string[]) => Promise<Map<string, number>>;
}

const defaultDependencies: OptionChainStructureDependencies = {
  now: () => new Date(),
  loadUniverse: loadCaptureUniverse,
  connect: connectToIbkrGateway,
  refreshStoredOptionChain,
  loadSpotPrices: async (symbols) => new Map([...(await loadFallbackStockPrices(symbols))].map(([symbol, known]) => [symbol, known.price])),
};

export async function runOptionChainStructureRefresh(
  onEvent: (event: OptionChainStructureEvent) => void = () => {},
  dependencies: OptionChainStructureDependencies = defaultDependencies,
): Promise<OptionChainStructureResult> {
  const todayIso = easternDateIso(dependencies.now());
  const universe = await dependencies.loadUniverse();
  const result: OptionChainStructureResult = { tickersAttempted: universe.length, tickersComplete: 0, tickersFailed: 0, failedSymbols: [], skippedSymbols: [], gridLookups: 0, gridsReused: 0 };
  const spotBySymbol = await dependencies.loadSpotPrices(universe.map((ticker) => ticker.symbol));

  const { ib, disconnect } = await dependencies.connect();
  try {
    for (const [index, ticker] of universe.entries()) {
      try {
        if (ticker.contractId === null) throw new Error("no ibkr_contract_id stored for this ticker");
        const chain = await dependencies.refreshStoredOptionChain(ib, { tickerId: ticker.tickerId, symbol: ticker.symbol, contractId: ticker.contractId }, todayIso, {
          maxAgeDays: structureGridMaxAgeDays,
          spotPrice: spotBySymbol.get(ticker.symbol) ?? null,
        });
        const strikeCount = [...chain.strikesByExpiry.values()].reduce((sum, strikes) => sum + strikes.length, 0);
        const reused = chain.timings.expiries.filter((expiry) => expiry.reused).length;
        result.gridsReused += reused;
        result.gridLookups += chain.timings.expiries.length - reused;
        onEvent({ type: "tickerDone", symbol: ticker.symbol, expiryCount: chain.strikesByExpiry.size, strikeCount, timings: chain.timings });
        result.tickersComplete++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: "tickerError", symbol: ticker.symbol, message });
        result.tickersFailed++;
        result.failedSymbols.push(ticker.symbol);
        // The timed-out request can't be cancelled and stays queued in the Gateway's session; every
        // request sent after it waits behind it, and piling more on is what stalled the whole Gateway.
        if (error instanceof IbkrLookupTimeoutError) {
          result.skippedSymbols = universe.slice(index + 1).map((remaining) => remaining.symbol);
          onEvent({ type: "aborted", afterSymbol: ticker.symbol, skippedSymbols: result.skippedSymbols });
          break;
        }
      }
    }
  } finally {
    disconnect();
  }

  return result;
}
