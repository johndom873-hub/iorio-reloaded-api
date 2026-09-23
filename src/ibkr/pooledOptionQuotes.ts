import type { OptionType } from "@stoqey/ib";
import { subscribeToPooledQuote, settleGraceMs, emptyPooledQuote, type PooledQuote } from "./marketDataPool.js";
import type { PriceContract } from "./fetchLivePrices.js";
import type { OptionQuote } from "./fetchOptionChain.js";

export interface OptionQuoteContract {
  symbol: string;
  expiry: string; // YYYYMMDD
  strike: number;
  right: OptionType;
}

function toPriceContract(contract: OptionQuoteContract): PriceContract {
  return { key: `${contract.expiry}|${contract.strike}|${contract.right}`, legType: "option", symbol: contract.symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right };
}

function toOptionQuote(contract: OptionQuoteContract, quote: PooledQuote): OptionQuote {
  return {
    expiry: contract.expiry,
    strike: contract.strike,
    right: contract.right,
    bid: quote.bid,
    ask: quote.ask,
    last: quote.last,
    impliedVolatility: quote.impliedVolatility,
    delta: quote.delta,
    gamma: quote.gamma,
    vega: quote.vega,
    theta: quote.theta,
  };
}

/**
 * Streaming-shaped wrapper over marketDataPool.ts for OptionQuote-shaped
 * consumers (Ticker Detail's chain via quoteOptionChain, Order Review's leg
 * quote, Signals' ticker-modal quotes) — drop-in replacement for
 * fetchOptionChain.ts's fetchQuotesForContracts' `live` mode as a live-data
 * SOURCE only, same external contract: resolves once every contract has
 * settled (current best-known reading), keeps pushing via `onUpdate` in the
 * background until `signal` aborts (the caller's own job, not awaited
 * inside this function — mirrors fetchQuotesForContracts exactly, so no
 * caller's control flow needs to change). A Gateway restart is invisible
 * here — the underlying pool keeps every subscription registered and
 * silently re-establishes them once the shared connection recovers.
 */
export async function streamPooledOptionQuotes(contracts: OptionQuoteContract[], onUpdate: (quotes: OptionQuote[]) => void, signal: AbortSignal): Promise<OptionQuote[]> {
  if (contracts.length === 0 || signal.aborted) return [];

  const entries = contracts.map((contract) => ({ contract, quote: emptyPooledQuote }));
  const currentArray = (): OptionQuote[] => entries.map(({ contract, quote }) => toOptionQuote(contract, quote));

  let settled = false;
  let pushScheduled = false;
  // Coalesced within the same event-loop turn, same reasoning as
  // fetchOptionChain.ts's matching schedulePush: a chain of 30+ contracts
  // can have several ticks land back to back from one network read.
  function schedulePush() {
    if (!settled || pushScheduled) return;
    pushScheduled = true;
    setImmediate(() => {
      pushScheduled = false;
      onUpdate(currentArray());
    });
  }

  const unsubscribes = await Promise.all(
    entries.map((entry, index) =>
      subscribeToPooledQuote(toPriceContract(entry.contract), (pooledQuote) => {
        entries[index]!.quote = pooledQuote;
        schedulePush();
      }),
    ),
  );

  function cleanup() {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }

  if (signal.aborted) {
    cleanup();
    return currentArray();
  }

  await new Promise((resolve) => setTimeout(resolve, settleGraceMs));
  settled = true;

  if (signal.aborted) {
    cleanup();
    return currentArray();
  }
  signal.addEventListener("abort", cleanup, { once: true });

  return currentArray();
}
