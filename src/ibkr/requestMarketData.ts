import { EventName, MarketDataType, type IBApi } from "@stoqey/ib";

/**
 * Always ask IBKR for real-time data. If the account isn't entitled for a
 * given symbol, IBKR automatically substitutes delayed data on its own and
 * reports one of the informational codes handled by isDelayedDataFallbackNotice
 * below — no app-side retry/fallback logic needed.
 */
export function requestRealtimeMarketData(ib: IBApi): void {
  if (marketDataTypeManagedConnections.has(ib)) return;
  ib.reqMarketDataType(MarketDataType.REALTIME);
}

// The market data type is connection-wide, and changing it while another
// subscription is outstanding on the same connection has been seen to
// silently stop that subscription's first tick (see streamPricingUpdates).
// A connection shared by concurrent streams therefore sets its type exactly
// once, when it connects (sharedReadConnection.ts's live connection), and is
// registered here so every requestRealtimeMarketData call site becomes a
// no-op for it instead of re-sending the type.
const marketDataTypeManagedConnections = new WeakSet<IBApi>();

export function markMarketDataTypeManaged(ib: IBApi): void {
  marketDataTypeManagedConnections.add(ib);
}

/**
 * IBKR's way of saying "not entitled for this symbol, substituting delayed
 * data" — informational, not a failure.
 */
export function isDelayedDataFallbackNotice(code: number): boolean {
  return code === 10089 || code === 10091 || code === 10167;
}

// Each (source, contract, code) is logged once per process, so a subscription re-made after every reconnect, or a
// contract fetched every round, leaves one line rather than one per request. Cleared past the cap to stay bounded.
const loggedEntitlementNotices = new Set<string>();
const loggedEntitlementNoticesCap = 5_000;

/**
 * Logs a delayed-data notice (isDelayedDataFallbackNotice): it means the account has no live-data subscription for the
 * contract, so a missing or delayed price has this as its explanation. Returns whether the line was written.
 */
export function logMarketDataEntitlementNotice(source: string, contractLabel: string, code: number, message: string): boolean {
  const noticeKey = `${source}|${contractLabel}|${code}`;
  if (loggedEntitlementNotices.has(noticeKey)) return false;
  if (loggedEntitlementNotices.size >= loggedEntitlementNoticesCap) loggedEntitlementNotices.clear();
  loggedEntitlementNotices.add(noticeKey);
  console.warn(`${source}: not entitled to live data for ${contractLabel} (code ${code}): ${message}`);
  return true;
}
