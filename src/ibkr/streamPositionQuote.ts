import { MarketDataType, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { lookupContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot, type TickerPricing } from "./fetchTickerOverview.js";
import { prepareOptionChainStrikes, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";

export type PositionQuoteSection = "overview" | "optionChain";

export type PositionQuoteStreamEvent =
  | { type: "overview"; data: { pricing: TickerPricing } }
  | { type: "optionChain"; data: OptionQuote[] }
  | { type: "error"; section: PositionQuoteSection; message: string };

const overviewReqId = 1;
const pricingReqId = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lighter sibling of streamTickerDetail.ts, for the New Position form: only
 * pricing + option chain, no historical-bars chart request. The form has no
 * chart to show, and reqHistoricalData is the most pacing-sensitive IBKR
 * call this project makes (see PROGRESS.md) — skipping it here avoids
 * firing one on every form open for no reason.
 */
export async function streamPositionQuote(symbol: string, onEvent: (event: PositionQuoteStreamEvent) => void): Promise<void> {
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    const contractDetailsPromise = lookupContractDetails(connection, overviewReqId);
    connection.ib.reqContractDetails(overviewReqId, new Stock(symbol, "SMART", "USD"));
    const pricingPromise = lookupPricingSnapshot(connection, symbol, pricingReqId);

    const overviewTask: Promise<TickerPricing | null> = (async () => {
      try {
        const pricing = await pricingPromise;
        onEvent({ type: "overview", data: { pricing } });
        return pricing;
      } catch (error) {
        onEvent({ type: "error", section: "overview", message: errorMessage(error) });
        return null;
      }
    })();

    const optionChainTask: Promise<void> = (async () => {
      try {
        const contractDetails = await contractDetailsPromise;
        if (!contractDetails.conId) throw new Error("No contract found to look up the option chain.");

        const pricing = await overviewTask;
        const spotPrice = pricing?.last ?? pricing?.previousClose;
        if (!spotPrice) throw new Error("No spot price available to select option strikes.");

        const expiryStrikes = await prepareOptionChainStrikes(connection, symbol, contractDetails.conId, spotPrice);
        const optionChain = await quoteOptionChain(connection, symbol, expiryStrikes);
        onEvent({ type: "optionChain", data: optionChain });
      } catch (error) {
        onEvent({ type: "error", section: "optionChain", message: errorMessage(error) });
      }
    })();

    await Promise.all([overviewTask, optionChainTask]);
  } finally {
    connection.disconnect();
  }
}
