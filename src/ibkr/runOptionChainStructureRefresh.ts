import { connectToIbkrGateway } from "./connectIbkr.js";
import { refreshStoredOptionChain, type OptionChainRefreshTimings } from "./fetchOptionChain.js";
import { loadCaptureUniverse, type UniverseTicker } from "./runOptionChainCapture.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";

// Split off runOptionChainCapture.ts 2026-09-23: chain STRUCTURE (expiries +
// each expiry's real strike grid) is plain IBKR contract-definition data,
// not gated on the market being open, so it runs pre-market — see
// scripts/run-option-chain-structure-job.ts. The nightly capture job
// (option_chain_capture) now reads what this job wrote (fetchOptionChain.ts's
// loadStoredOptionChain) instead of refreshing structure itself, and is
// ticks-only, which does need the market open for real quotes.

type IbkrApi = Parameters<typeof refreshStoredOptionChain>[0];

export type OptionChainStructureEvent =
  | { type: "tickerDone"; symbol: string; expiryCount: number; strikeCount: number; timings: OptionChainRefreshTimings }
  | { type: "tickerError"; symbol: string; message: string };

export interface OptionChainStructureResult {
  tickersAttempted: number;
  tickersComplete: number;
  tickersFailed: number;
}

/** Everything runOptionChainStructureRefresh touches outside itself; injectable so the run logic is testable offline. */
export interface OptionChainStructureDependencies {
  now: () => Date;
  loadUniverse: () => Promise<UniverseTicker[]>;
  connect: () => Promise<{ ib: IbkrApi; disconnect: () => void }>;
  refreshStoredOptionChain: (ib: IbkrApi, ticker: { tickerId: string; symbol: string; contractId: number }, todayIso: string) => ReturnType<typeof refreshStoredOptionChain>;
}

const defaultDependencies: OptionChainStructureDependencies = {
  now: () => new Date(),
  loadUniverse: loadCaptureUniverse,
  connect: connectToIbkrGateway,
  refreshStoredOptionChain,
};

export async function runOptionChainStructureRefresh(
  onEvent: (event: OptionChainStructureEvent) => void = () => {},
  dependencies: OptionChainStructureDependencies = defaultDependencies,
): Promise<OptionChainStructureResult> {
  const todayIso = easternDateIso(dependencies.now());
  const universe = await dependencies.loadUniverse();
  const result: OptionChainStructureResult = { tickersAttempted: universe.length, tickersComplete: 0, tickersFailed: 0 };

  const { ib, disconnect } = await dependencies.connect();
  try {
    for (const ticker of universe) {
      try {
        if (ticker.contractId === null) throw new Error("no ibkr_contract_id stored for this ticker");
        const chain = await dependencies.refreshStoredOptionChain(ib, { tickerId: ticker.tickerId, symbol: ticker.symbol, contractId: ticker.contractId }, todayIso);
        const strikeCount = [...chain.strikesByExpiry.values()].reduce((sum, strikes) => sum + strikes.length, 0);
        onEvent({ type: "tickerDone", symbol: ticker.symbol, expiryCount: chain.strikesByExpiry.size, strikeCount, timings: chain.timings });
        result.tickersComplete++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: "tickerError", symbol: ticker.symbol, message });
        result.tickersFailed++;
      }
    }
  } finally {
    disconnect();
  }

  return result;
}
