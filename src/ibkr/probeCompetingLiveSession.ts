import { EventName, MarketDataType, Stock, type IBApi } from "@stoqey/ib";

// IBKR error 10197 ("No market data during competing live session") on every
// market-data request, with the Gateway connection itself up and healthy. Two
// causes: the live username (johndom873) logged in elsewhere (TWS, mobile,
// Client Portal), which only logging it out fixes; or the Gateway's own session
// gone stale after IBKR silently dropped and restored it (no login dialog, just
// "Connecting to server..."), which a Gateway restart (fresh login) fixes.
//
// Resolves on the first decisive event only. IBKR answers reqMktData with a
// marketDataType event BEFORE any 10197 error, so that event says nothing
// about whether data will actually flow: only a real price (flowing) or the
// 10197 error (blocked) decide it. Neither within the timeout is "unknown",
// which callers must treat as no information (neither alert nor clear).
export const competingLiveSessionErrorCode = 10197;
const probeTimeoutMs = 5_000;

export type CompetingLiveSessionProbeResult = "blocked" | "flowing" | "unknown";

type ProbeApi = Pick<IBApi, "on" | "removeListener" | "reqMarketDataType" | "reqMktData" | "cancelMktData">;

export function probeCompetingLiveSession(ib: ProbeApi, reqId: number, symbol: string, timeoutMs: number = probeTimeoutMs): Promise<CompetingLiveSessionProbeResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("unknown"), timeoutMs);

    function onError(_error: Error, code: number, id: number) {
      if (id === reqId && code === competingLiveSessionErrorCode) finish("blocked");
    }
    function onTickPrice(id: number, _tickType: number, price: number) {
      if (id === reqId && price > 0) finish("flowing");
    }
    function finish(result: CompetingLiveSessionProbeResult) {
      clearTimeout(timer);
      ib.removeListener(EventName.error, onError);
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.cancelMktData(reqId);
      resolve(result);
    }

    ib.on(EventName.error, onError);
    ib.on(EventName.tickPrice, onTickPrice);
    ib.reqMarketDataType(MarketDataType.REALTIME);
    ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "", false, false);
  });
}
