import { EventName, SecType, type ContractDescription } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface TickerSearchResult {
  symbol: string;
  companyName: string | null;
}

const searchTimeoutMs = 8_000;
const searchReqId = 1;

function requestMatchingSymbols(
  connection: Awaited<ReturnType<typeof connectToIbkrGateway>>,
  query: string,
): Promise<ContractDescription[]> {
  return new Promise((resolve) => {
    let settled = false;

    const onSamples = (reqId: number, contractDescriptions: ContractDescription[]) => {
      if (reqId !== searchReqId) return;
      finish(contractDescriptions);
    };

    const onError = (_error: Error, _code: number, reqId: number) => {
      if (reqId === searchReqId) finish([]);
    };

    const timer = setTimeout(() => finish([]), searchTimeoutMs);

    function finish(result: ContractDescription[]) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.symbolSamples, onSamples);
      connection.ib.off(EventName.error, onError);
      resolve(result);
    }

    connection.ib.on(EventName.symbolSamples, onSamples);
    connection.ib.on(EventName.error, onError);
    connection.ib.reqMatchingSymbols(searchReqId, query);
  });
}

/**
 * Searches IBKR for US-listed stocks with options available, matching the
 * query against either the ticker symbol or the company name (IBKR's
 * reqMatchingSymbols does both in one call — "start of ticker symbol or,
 * for larger strings, company name"). Connects per-request like the rest
 * of ticker creation; see PROGRESS.md for the accepted latency tradeoff.
 */
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  const connection = await connectToIbkrGateway();
  try {
    const matches = await requestMatchingSymbols(connection, query);

    const results: TickerSearchResult[] = [];
    const seenSymbols = new Set<string>();

    for (const match of matches) {
      const contract = match.contract;
      if (!contract?.symbol) continue;
      if (contract.secType !== SecType.STK) continue;
      if (contract.currency !== "USD") continue;
      if (!match.derivativeSecTypes?.includes(SecType.OPT)) continue;
      if (seenSymbols.has(contract.symbol)) continue;

      seenSymbols.add(contract.symbol);
      results.push({ symbol: contract.symbol, companyName: contract.description ?? null });
    }

    return results;
  } finally {
    connection.disconnect();
  }
}
