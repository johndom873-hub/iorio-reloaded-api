import { OptionType } from "@stoqey/ib";
import { streamPooledOptionQuotes } from "./pooledOptionQuotes.js";
import { formatExpiryAsIsoDate, formatIsoDateAsExpiry } from "../lib/optionChainSnapshotStore.js";
import type { ContractRef, LiveOptionQuote } from "../lib/signalsLiveScoring.js";

// Live bid/ask for the exact contracts the Signals modal scores (one right per
// strike, unlike quoteOptionChain's call+put per strike), via
// marketDataPool.ts's shared subscription (approved 2026-09-24). Held open
// until `signal` aborts.
export async function streamSignalsOptionQuotes(symbol: string, contracts: ContractRef[], onUpdate: (quotes: LiveOptionQuote[]) => void, signal: AbortSignal): Promise<void> {
  if (contracts.length === 0 || signal.aborted) return;

  const ibkrContracts = contracts.map((contract) => ({ symbol, expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }));
  const toLiveQuotes = (quotes: { expiry: string; strike: number; right: OptionType; bid: number | null; ask: number | null }[]): LiveOptionQuote[] =>
    quotes.map((quote) => ({ expiry: formatExpiryAsIsoDate(quote.expiry), strike: quote.strike, right: quote.right === OptionType.Call ? "C" : "P", bid: quote.bid, ask: quote.ask }));

  const initial = await streamPooledOptionQuotes(ibkrContracts, (quotes) => onUpdate(toLiveQuotes(quotes)), signal);
  onUpdate(toLiveQuotes(initial));
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
