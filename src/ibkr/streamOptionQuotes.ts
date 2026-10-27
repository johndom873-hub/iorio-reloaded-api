import { OptionType } from "@stoqey/ib";
import { streamPooledOptionQuotes } from "./pooledOptionQuotes.js";
import { formatExpiryAsIsoDate, formatIsoDateAsExpiry } from "../lib/expiryFormat.js";

export interface OptionContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface StreamedOptionQuote extends OptionContractRef {
  bid: number | null;
  ask: number | null;
  /** IBKR's model delta. */
  delta: number | null;
}

// Live bid/ask for exactly the contracts a screen shows (one right per
// strike, unlike quoteOptionChain's call+put per strike), via
// marketDataPool.ts's shared subscription (approved 2026-09-24). Held open
// until `signal` aborts.
export async function streamOptionQuotes(symbol: string, contracts: OptionContractRef[], onUpdate: (quotes: StreamedOptionQuote[]) => void, signal: AbortSignal): Promise<void> {
  if (contracts.length === 0 || signal.aborted) return;

  const ibkrContracts = contracts.map((contract) => ({ symbol, expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }));
  const toLiveQuotes = (quotes: { expiry: string; strike: number; right: OptionType; bid: number | null; ask: number | null; delta: number | null }[]): StreamedOptionQuote[] =>
    quotes.map((quote) => ({ expiry: formatExpiryAsIsoDate(quote.expiry), strike: quote.strike, right: quote.right === OptionType.Call ? "C" : "P", bid: quote.bid, ask: quote.ask, delta: quote.delta }));

  const initial = await streamPooledOptionQuotes(ibkrContracts, (quotes) => onUpdate(toLiveQuotes(quotes)), signal);
  onUpdate(toLiveQuotes(initial));
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
