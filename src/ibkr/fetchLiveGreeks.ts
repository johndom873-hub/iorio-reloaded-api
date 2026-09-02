import { EventName, Option, OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
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

const quoteTimeoutMs = 5_000;

/**
 * Simplified sibling of fetchOptionChain.ts's fetchQuotesForContracts — the
 * exact contracts are already known (from position_legs), so there's no
 * strike-discovery step, just a direct greeks subscribe/collect/cancel.
 */
export async function fetchLiveGreeks(contracts: GreeksContract[]): Promise<Record<string, Greeks>> {
  if (contracts.length === 0) return {};

  const connection = await connectToIbkrGateway();
  const { ib } = connection;

  try {
    requestRealtimeMarketData(ib);

    const greeksByKey = new Map<string, Greeks>();
    const reqIdToContract = new Map<number, GreeksContract>();
    let nextReqId = 20_000;

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
      // Model computation only, real-time (13) or delayed (83) — see the
      // same comment in fetchOptionChain.ts's fetchQuotesForContracts.
      if (!contract || (tickType !== 83 && tickType !== 13)) return;
      greeksByKey.set(contract.key, {
        delta: delta ?? null,
        gamma: gamma ?? null,
        vega: vega ?? null,
        theta: theta ?? null,
      });
    }

    function onError(error: Error, code: number, reqId: number) {
      const contract = reqIdToContract.get(reqId);
      if (!contract) return;
      // Informational "using delayed data" notices, expected wherever this
      // account isn't entitled for real-time on a given symbol. See the
      // same handling in fetchOptionChain.ts's fetchQuotesForContracts.
      if (isDelayedDataFallbackNotice(code)) return;
      console.error(
        `Live greeks error for ${contract.symbol} ${contract.expiry} ${contract.strike}${contract.right} (code ${code}): ${error.message}`,
      );
    }

    ib.on(EventName.tickOptionComputation, onTickOptionComputation);
    ib.on(EventName.error, onError);

    for (const contract of contracts) {
      const reqId = nextReqId++;
      reqIdToContract.set(reqId, contract);
      greeksByKey.set(contract.key, { delta: null, gamma: null, vega: null, theta: null });
      ib.reqMktData(
        reqId,
        new Option(contract.symbol, contract.expiry, contract.strike, contract.right, "SMART"),
        "",
        false,
        false,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, quoteTimeoutMs));

    for (const reqId of reqIdToContract.keys()) {
      ib.cancelMktData(reqId);
    }
    ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
    ib.removeListener(EventName.error, onError);

    return Object.fromEntries(greeksByKey);
  } finally {
    connection.disconnect();
  }
}
