import { MarketDataType, type IBApi } from "@stoqey/ib";

/**
 * Always ask IBKR for real-time data. If the account isn't entitled for a
 * given symbol, IBKR automatically substitutes delayed data on its own and
 * reports one of the informational codes handled by isDelayedDataFallbackNotice
 * below — no app-side retry/fallback logic needed.
 */
export function requestRealtimeMarketData(ib: IBApi): void {
  ib.reqMarketDataType(MarketDataType.REALTIME);
}

/**
 * IBKR's way of saying "not entitled for this symbol, substituting delayed
 * data" — informational, not a failure.
 */
export function isDelayedDataFallbackNotice(code: number): boolean {
  return code === 10089 || code === 10091 || code === 10167;
}
