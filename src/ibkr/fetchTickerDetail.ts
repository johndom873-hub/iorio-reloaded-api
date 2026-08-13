import { Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { lookupContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot, type TickerPricing } from "./fetchTickerOverview.js";
import { lookupOptionChain, type OptionQuote } from "./fetchOptionChain.js";

export interface TickerDetail {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  pricing: TickerPricing;
  optionChain: OptionQuote[];
}

const contractDetailsReqId = 1;
const pricingReqId = 2;

/**
 * Everything the Ticker Detail modal needs in one shot: company overview,
 * full live pricing, and a strategy-relevant option chain (see
 * fetchOptionChain.ts for why it's filtered, not the full chain). One IBKR
 * connection shared across all three — contract details and pricing run in
 * parallel (independent), then the option chain (needs a spot price to pick
 * near-the-money strikes) runs after pricing resolves.
 */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
  const connection = await connectToIbkrGateway();
  try {
    const contractDetailsPromise = lookupContractDetails(connection, contractDetailsReqId);
    connection.ib.reqContractDetails(contractDetailsReqId, new Stock(symbol, "SMART", "USD"));

    const [contractDetails, pricing] = await Promise.all([
      contractDetailsPromise,
      lookupPricingSnapshot(connection, symbol, pricingReqId),
    ]);

    const spotPrice = pricing.last ?? pricing.previousClose;
    const optionChain = spotPrice ? await lookupOptionChain(connection, symbol, spotPrice) : [];

    return { symbol, ...contractDetails, pricing, optionChain };
  } finally {
    connection.disconnect();
  }
}
