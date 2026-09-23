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

// Code 1100, reqId -1: "Connectivity between IB and the TWS/Gateway has been
// lost" — IBKR's own system-status notice for exactly this condition.
const connectivityLostCode = 1100;

/**
 * Resolves when `signal` aborts (the caller unsubscribed) OR the Gateway
 * connection drops out from under a live streaming subscription — used by
 * streamLivePrices/streamLiveGreeks so a Gateway restart ends the stream
 * instead of leaving it awaiting only the abort signal forever, which used
 * to require the caller's own retry logic to ever notice.
 */
export function waitForAbortOrGatewayDisconnect(ib: IBApi, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    function onAbort() {
      cleanup();
      resolve();
    }
    function onDisconnected() {
      cleanup();
      resolve();
    }
    function onSystemStatus(_error: Error, code: number, reqId: number) {
      if (reqId !== -1 || code !== connectivityLostCode) return;
      cleanup();
      resolve();
    }
    function cleanup() {
      signal.removeEventListener("abort", onAbort);
      ib.removeListener(EventName.disconnected, onDisconnected);
      ib.removeListener(EventName.error, onSystemStatus);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    ib.on(EventName.disconnected, onDisconnected);
    ib.on(EventName.error, onSystemStatus);
  });
}
