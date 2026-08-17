import { MarketDataType, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { lookupContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot, lookupHistoricalBars, type TickerPricing, type PriceBar } from "./fetchTickerOverview.js";
import { prepareOptionChainStrikes, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";

export type TickerDetailSection = "overview" | "chart" | "optionChain";

export interface TickerOverview {
  companyName: string | null;
  sector: string | null;
  pricing: TickerPricing;
}

export type TickerDetailStreamEvent =
  | { type: "overview"; data: TickerOverview }
  | { type: "chart"; data: PriceBar[] }
  | { type: "optionChain"; data: OptionQuote[] }
  | { type: "error"; section: TickerDetailSection; message: string };

const overviewReqId = 1;
const pricingReqId = 2;
const chartReqId = 3;

// The default range shown when the modal first opens — matches
// TickerPriceChart's own initial range. Switching ranges afterward goes
// through the plain /tickers/:symbol/chart request, unchanged.
const defaultChartRange = "3M" as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Streams the three pieces the Ticker Detail modal needs — company/pricing
 * overview, default-range chart bars, and the option chain — as each
 * becomes ready, over one shared IBKR connection, instead of blocking on
 * all three before returning anything (the old fetchTickerDetail did this,
 * taking ~20-25s end to end; see PROGRESS.md for the measured breakdown).
 *
 * All three run concurrently, but optionChain has real dependencies: it
 * needs the underlying's conId (shared with overview's contractDetails
 * lookup — see below) and, since fetchOptionChain.ts started validating
 * candidate strikes one at a time instead of via a wildcard scan, it now
 * also needs the spot price up front to know which strikes are worth
 * checking. So optionChain waits on overviewTask before starting its own
 * IBKR calls — a smaller overlap than before, traded for eliminating the
 * 10-20s+ throttled wildcard contractDetails call that used to be the
 * dominant cost (see fetchOptionChain.ts for why that call was throttled).
 *
 * conId comes from the *same* contractDetails lookup overview already
 * needs for companyName/sector — the two share one promise/one
 * reqContractDetails call, not two. An earlier version had optionChain do
 * its own separate reqContractDetails call for conId; firing two identical
 * contractDetails lookups for the same underlying concurrently at
 * connection start reproduced real IBKR request-pacing contention (a
 * "Pricing snapshot timeout").
 *
 * Each task catches its own errors and reports them as a section-specific
 * `error` event rather than failing the whole stream — IBKR's per-account
 * pacing limits mean one section can time out without the others being
 * affected.
 */
export async function streamTickerDetail(symbol: string, onEvent: (event: TickerDetailStreamEvent) => void): Promise<void> {
  const connection = await connectToIbkrGateway();
  try {
    // Connection-wide setting, called exactly once here — not inside any of
    // lookupPricingSnapshot/lookupHistoricalBars/prepareOptionChainStrikes,
    // which all run concurrently on this connection below. A second call
    // while a market-data snapshot subscription is still outstanding was
    // found to silently prevent it from ever completing (see the note on
    // lookupPricingSnapshot).
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    const contractDetailsPromise = lookupContractDetails(connection, overviewReqId);
    connection.ib.reqContractDetails(overviewReqId, new Stock(symbol, "SMART", "USD"));
    const pricingPromise = lookupPricingSnapshot(connection, symbol, pricingReqId);

    const overviewTask: Promise<TickerPricing | null> = (async () => {
      try {
        const [contractDetails, pricing] = await Promise.all([contractDetailsPromise, pricingPromise]);
        onEvent({
          type: "overview",
          data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing },
        });
        return pricing;
      } catch (error) {
        onEvent({ type: "error", section: "overview", message: errorMessage(error) });
        return null;
      }
    })();

    const chartTask: Promise<void> = (async () => {
      try {
        const bars = await lookupHistoricalBars(connection, symbol, defaultChartRange, chartReqId);
        onEvent({ type: "chart", data: bars });
      } catch (error) {
        onEvent({ type: "error", section: "chart", message: errorMessage(error) });
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

    await Promise.all([overviewTask, chartTask, optionChainTask]);
  } finally {
    connection.disconnect();
  }
}
