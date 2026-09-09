import { EventName, Option, OptionType, type IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice, requestRealtimeMarketData } from "./requestMarketData.js";

export interface GreeksContract {
  key: string;
  symbol: string;
  expiry: string; // YYYYMMDD
  strike: number;
  right: OptionType;
}

export interface Greeks {
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
}

// Safety-net ceiling only, not the expected outcome — see the snapshot-mode
// note below. Real measurement (tmp/testSnapshotModeForGreeks.ts,
// 2026-09-09, all 4 real open option legs): completed at 3237ms. This gives
// real headroom above that before falling back to whatever greeks happened
// to arrive.
const snapshotTimeoutMs = 6_000;

function requestLiveGreeks(ib: IBApi, allocateReqId: () => number, contracts: GreeksContract[]): Promise<Record<string, Greeks>> {
  requestRealtimeMarketData(ib);

  const greeksByKey = new Map<string, Greeks>();
  const reqIdToContract = new Map<number, GreeksContract>();
  // Tracks contracts still waiting — lets the wait below resolve as soon as
  // every requested contract is done, rather than a fixed timer. A contract
  // counts as done the moment EITHER its greeks arrive OR IBKR signals
  // tickSnapshotEnd, whichever comes first — not tickSnapshotEnd alone. Same
  // defensive shape as fetchLivePrices.ts after finding tickSnapshotEnd
  // doesn't reliably fire for an option's last-price snapshot — greeks
  // measured clean via tickSnapshotEnd alone (tmp/testSnapshotModeForGreeks.ts,
  // 4/4 real option legs), but resolving on the data itself, not just IBKR's
  // separate completion signal, costs nothing and removes the same risk
  // class if it turns out to affect some other contract/condition too.
  const pendingReqIds = new Set<number>();
  let onAllReceived: (() => void) | null = null;

  function markDone(reqId: number) {
    if (pendingReqIds.delete(reqId) && pendingReqIds.size === 0) onAllReceived?.();
  }

  function onTickOptionComputation(
    reqId: number,
    tickType: number,
    _tickAttrib: number | undefined,
    _impliedVol?: number,
    delta?: number,
    _optPrice?: number,
    _pvDividend?: number,
    gamma?: number,
    vega?: number,
    theta?: number,
  ) {
    const contract = reqIdToContract.get(reqId);
    // Model computation only, real-time (13) or delayed (83) — see the same
    // comment in fetchOptionChain.ts's fetchQuotesForContracts.
    if (!contract || (tickType !== 83 && tickType !== 13)) return;
    greeksByKey.set(contract.key, {
      delta: delta ?? null,
      gamma: gamma ?? null,
      vega: vega ?? null,
      theta: theta ?? null,
    });
    markDone(reqId);
  }

  function onTickSnapshotEnd(reqId: number) {
    markDone(reqId);
  }

  function onError(error: Error, code: number, reqId: number) {
    const contract = reqIdToContract.get(reqId);
    if (!contract) return;
    // Informational "using delayed data" notices, expected wherever this
    // account isn't entitled for real-time on a given symbol. See the same
    // handling in fetchOptionChain.ts's fetchQuotesForContracts.
    if (isDelayedDataFallbackNotice(code)) return;
    console.error(
      `Live greeks error for ${contract.symbol} ${contract.expiry} ${contract.strike}${contract.right} (code ${code}): ${error.message}`,
    );
  }

  ib.on(EventName.tickOptionComputation, onTickOptionComputation);
  ib.on(EventName.tickSnapshotEnd, onTickSnapshotEnd);
  ib.on(EventName.error, onError);

  return (async () => {
    try {
      for (const contract of contracts) {
        const reqId = allocateReqId();
        reqIdToContract.set(reqId, contract);
        pendingReqIds.add(reqId);
        greeksByKey.set(contract.key, { delta: null, gamma: null, vega: null, theta: null });
        // snapshot=true — see the pendingReqIds comment above.
        ib.reqMktData(
          reqId,
          new Option(contract.symbol, contract.expiry, contract.strike, contract.right, "SMART"),
          "",
          true,
          false,
        );
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, snapshotTimeoutMs);
        onAllReceived = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      return Object.fromEntries(greeksByKey);
    } finally {
      for (const reqId of reqIdToContract.keys()) {
        ib.cancelMktData(reqId);
      }
      ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
      ib.removeListener(EventName.tickSnapshotEnd, onTickSnapshotEnd);
      ib.removeListener(EventName.error, onError);
    }
  })();
}

/**
 * Simplified sibling of fetchOptionChain.ts's fetchQuotesForContracts — the
 * exact contracts are already known (from position_legs), so there's no
 * strike-discovery step, just a direct greeks subscribe/collect/cancel.
 *
 * Tries the shared read connection first (sharedReadConnection.ts — reused
 * across requests, no per-call connect cost) and falls back to a one-shot
 * connection only when the shared one isn't available.
 */
export async function fetchLiveGreeks(contracts: GreeksContract[]): Promise<Record<string, Greeks>> {
  if (contracts.length === 0) return {};

  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `fetchLiveGreeks: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }

  if (borrowed) {
    const { ib, release } = borrowed;
    try {
      return await requestLiveGreeks(ib, () => sharedReadConnection.allocateReqId(), contracts);
    } finally {
      release();
    }
  }

  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  try {
    let nextReqId = 20_000;
    return await requestLiveGreeks(ib, () => nextReqId++, contracts);
  } finally {
    connection.disconnect();
  }
}
