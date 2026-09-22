import { OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { fetchQuotesForContracts } from "./fetchOptionChain.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { sharedLiveConnection } from "./sharedReadConnection.js";
import { formatExpiryAsIsoDate, formatIsoDateAsExpiry } from "../lib/optionChainSnapshotStore.js";
import type { ContractRef, LiveOptionQuote } from "../lib/signalsLiveScoring.js";

// Live bid/ask for the exact contracts the Signals modal scores (one right per
// strike, unlike quoteOptionChain's call+put per strike), on the shared live
// connection like streamTickerDetail. Held open until `signal` aborts.
export async function streamSignalsOptionQuotes(symbol: string, contracts: ContractRef[], onUpdate: (quotes: LiveOptionQuote[]) => void, signal: AbortSignal): Promise<void> {
  if (contracts.length === 0 || signal.aborted) return;

  let borrowed: Awaited<ReturnType<typeof sharedLiveConnection.borrow>> | null = null;
  try {
    borrowed = await sharedLiveConnection.borrow();
  } catch (error) {
    console.log(`streamSignalsOptionQuotes: shared live connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`);
  }
  const connection = borrowed ? { ib: borrowed.ib, disconnect: borrowed.release } : await connectToIbkrGateway();
  try {
    requestRealtimeMarketData(connection.ib);
    const ibkrContracts = contracts.map((contract) => ({ expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }));
    const toLiveQuotes = (quotes: { expiry: string; strike: number; right: OptionType; bid: number | null; ask: number | null }[]): LiveOptionQuote[] =>
      quotes.map((quote) => ({ expiry: formatExpiryAsIsoDate(quote.expiry), strike: quote.strike, right: quote.right === OptionType.Call ? "C" : "P", bid: quote.bid, ask: quote.ask }));

    const initial = await fetchQuotesForContracts(connection.ib, symbol, ibkrContracts, { onUpdate: (quotes) => onUpdate(toLiveQuotes(quotes)), signal });
    onUpdate(toLiveQuotes(initial));
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    connection.disconnect();
  }
}
