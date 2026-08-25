import { MarketDataType, type OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { fetchQuotesForContracts, type OptionQuote } from "./fetchOptionChain.js";

/**
 * Live bid/ask/last/IV/Greeks for a single not-yet-confirmed order's option
 * leg — Order Review panel, built 2026-08-25 (see PROGRESS.md's "Richer
 * order/review screen" entry). Own connect/disconnect since this is a
 * one-off on-demand lookup, same shape as fetchLiveGreeks.ts.
 */
export async function fetchOrderLegQuote(symbol: string, expiry: string, strike: number, right: OptionType): Promise<OptionQuote> {
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);
    const [quote] = await fetchQuotesForContracts(connection.ib, symbol, [{ expiry, strike, right }]);
    return quote!;
  } finally {
    connection.disconnect();
  }
}
