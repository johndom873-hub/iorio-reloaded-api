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
 * All three run concurrently, but optionChain has one real dependency: it
 * needs the underlying's conId before it can look up expirations/strikes.
 * That conId comes from the *same* contractDetails lookup overview already
 * needs for companyName/sector — the two share one promise/one
 * reqContractDetails call, not two. An earlier version had optionChain do
 * its own separate reqContractDetails call for conId; firing two identical
 * contractDetails lookups for the same underlying concurrently at
 * connection start reproduced real IBKR request-pacing contention (a
 * "Pricing snapshot timeout", not just the per-expiry strikes slowdown
 * already documented in fetchOptionChain.ts).
 *
 * Only the final near-the-money strike selection needs the spot price, so
 * optionChain's metadata prep (expirations, valid strikes per expiry)
 * starts as soon as contractDetails resolves — it doesn't wait for
 * pricing, which is often the slower of the two.
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

        const expiryStrikesPromise = prepareOptionChainStrikes(connection, symbol, contractDetails.conId);
        // Node treats a promise rejecting with no handler attached yet as an
        // unhandled rejection and kills the process by default. We don't
        // await expiryStrikesPromise until after overviewTask below (real
        // concurrency, not a sequential chain), so a fast rejection here
        // (e.g. the strikes lookup timing out) would otherwise crash the
        // whole server before the try/catch below gets a chance to run.
        // This no-op catch just marks it "handled" for that purpose; the
        // real error handling still happens at the `await
        // expiryStrikesPromise` line.
        expiryStrikesPromise.catch(() => {});

        const pricing = await overviewTask;
        const spotPrice = pricing?.last ?? pricing?.previousClose;
        if (!spotPrice) throw new Error("No spot price available to select option strikes.");

        const expiryStrikes = await expiryStrikesPromise;
        const optionChain = await quoteOptionChain(connection, symbol, spotPrice, expiryStrikes);
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
