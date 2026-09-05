import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot, lookupHistoricalBars, type TickerPricing } from "./fetchTickerOverview.js";
import { prepareOptionChainStrikes, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";

const contractDetailsReqId = 1;
const pricingReqId = 2;
const historicalReqId = 3;

export interface TickerQuoteSnapshot {
  symbol: string;
  // Always populated when the symbol is valid — historical daily bars work
  // regardless of market hours, unlike the live snapshot below.
  lastKnownClose: { price: number; asOf: string } | null;
  // Null outside US market hours (or on any other live-data failure) — see
  // liveUnavailableReason for why. Never fabricated: a null here must never
  // be papered over with a guessed number.
  live: { pricing: TickerPricing; optionChain: OptionQuote[] } | null;
  liveUnavailableReason: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Blocking (not SSE) quote lookup for Genosuke's get_ticker_quote tool — a
 * ticker with no open position and no trade alert has no cached data
 * anywhere (market_data_snapshots only covers the shortlist.s
 * IV/volume), so a Telegram request for "what's MU trading at" had no data
 * source at all until this (see PROGRESS.md's readTools.ts gap, closed
 * 2026-08-24). Reuses the exact functions streamPositionQuote.ts uses for
 * the New Position form's live-quote lookup, just as one blocking call
 * instead of an SSE stream — appropriate here since Genosuke's tool calls
 * are already synchronous request/response, not a UI with a spinner to
 * progressively fill in.
 *
 * The one-year daily-bar history call always succeeds (historical data
 * isn't gated by market hours) and gives a real last-known price even when
 * the live snapshot below can't. The live snapshot + option chain are
 * best-effort: IBKR's snapshot pricing (and therefore the option chain,
 * which needs a live spot price to pick strikes) is documented to fail
 * outside US market hours — that failure is caught and surfaced as
 * liveUnavailableReason instead of throwing, so a market-hours-closed
 * lookup still returns useful data rather than erroring out entirely.
 */
export async function fetchTickerQuoteSnapshot(symbol: string): Promise<TickerQuoteSnapshot> {
  const connection = await connectToIbkrGateway();
  try {
    requestRealtimeMarketData(connection.ib);

    const bars = await lookupHistoricalBars(connection, symbol, "1Y", historicalReqId);
    const lastBar = bars.at(-1);
    const lastKnownClose = lastBar ? { price: lastBar.close, asOf: new Date(lastBar.time * 1000).toISOString().slice(0, 10) } : null;

    try {
      const contractDetailsPromise = getCachedContractDetails(connection, symbol, contractDetailsReqId);
      const pricing = await lookupPricingSnapshot(connection, symbol, pricingReqId);
      const contractDetails = await contractDetailsPromise;

      const spotPrice = pricing.last ?? pricing.previousClose ?? lastKnownClose?.price;
      if (!contractDetails.conId || !spotPrice) {
        throw new Error("No contract or spot price available to select option strikes.");
      }

      const expiryStrikes = await prepareOptionChainStrikes(connection, symbol, contractDetails.conId, spotPrice);
      const optionChain = await quoteOptionChain(connection, symbol, expiryStrikes);

      return { symbol, lastKnownClose, live: { pricing, optionChain }, liveUnavailableReason: null };
    } catch (error) {
      return { symbol, lastKnownClose, live: null, liveUnavailableReason: errorMessage(error) };
    }
  } finally {
    connection.disconnect();
  }
}
