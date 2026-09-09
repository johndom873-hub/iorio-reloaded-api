import { EventName, SecType, type ContractDescription, type IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";

export interface TickerSearchResult {
  symbol: string;
  companyName: string | null;
}

const searchTimeoutMs = 8_000;

function requestMatchingSymbols(ib: IBApi, reqId: number, query: string): Promise<ContractDescription[]> {
  return new Promise((resolve) => {
    let settled = false;

    const onSamples = (id: number, contractDescriptions: ContractDescription[]) => {
      if (id !== reqId) return;
      finish(contractDescriptions);
    };

    const onError = (_error: Error, _code: number, id: number) => {
      if (id === reqId) finish([]);
    };

    const timer = setTimeout(() => finish([]), searchTimeoutMs);

    function finish(result: ContractDescription[]) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ib.off(EventName.symbolSamples, onSamples);
      ib.off(EventName.error, onError);
      resolve(result);
    }

    ib.on(EventName.symbolSamples, onSamples);
    ib.on(EventName.error, onError);
    ib.reqMatchingSymbols(reqId, query);
  });
}

function toSearchResults(matches: ContractDescription[]): TickerSearchResult[] {
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
}

/**
 * Searches IBKR for US-listed stocks with options available, matching the
 * query against either the ticker symbol or the company name (IBKR's
 * reqMatchingSymbols does both in one call — "start of ticker symbol or, for
 * larger strings, company name").
 *
 * Tries the shared read connection first (sharedReadConnection.ts — reused
 * across requests, no per-call connect cost) and falls back to a one-shot
 * connection only when the shared one isn't available.
 */
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `searchTickers: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }

  if (borrowed) {
    const { ib, release } = borrowed;
    try {
      const matches = await requestMatchingSymbols(ib, sharedReadConnection.allocateReqId(), query);
      return toSearchResults(matches);
    } finally {
      release();
    }
  }

  const connection = await connectToIbkrGateway();
  try {
    const matches = await requestMatchingSymbols(connection.ib, 1, query);
    return toSearchResults(matches);
  } finally {
    connection.disconnect();
  }
}
