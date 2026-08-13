import { EventName, Stock, type TickType } from "@stoqey/ib";
import type { IbkrConnection } from "./connectIbkr.js";

const defaultSnapshotTimeoutMs = 15_000;

// TickType is exported as a type only, not a runtime enum, so these mirror
// its fixed protocol values directly (interactivebrokers.github.io/tws-api/tick_types.html).
const OPTION_IMPLIED_VOL_TICK = 24;
const AVG_OPT_VOLUME_TICK = 87;

export interface CapturedMarketDataSnapshot {
  impliedVolatility: number | null;
  avgOptionVolume: number | null;
}

/**
 * Captures implied volatility + average option volume for one ticker on an
 * already-open IBKR connection. Caller owns the connection's lifecycle
 * (connect/disconnect) and must pass a reqId not in use elsewhere on it.
 *
 * Generic ticks 105 (Average Option Volume) + 106 (Option Implied
 * Volatility) only work as a streaming subscription — IBKR rejects them
 * under snapshot=true with error 321 ("Snapshot market data subscription is
 * not applicable to generic ticks"), confirmed by testing against the real
 * paper Gateway. So this opens a stream and explicitly cancels it once both
 * values arrive (or the timeout fires) instead.
 *
 * @param timeoutMs How long to wait for both values before giving up and
 * returning whatever arrived (or nulls). Defaults to 15s, appropriate for
 * the unattended daily batch job; pass something shorter for an interactive
 * flow where a person is actively waiting.
 */
export function captureMarketDataSnapshot(
  connection: IbkrConnection,
  reqId: number,
  symbol: string,
  timeoutMs: number = defaultSnapshotTimeoutMs,
): Promise<CapturedMarketDataSnapshot> {
  return new Promise((resolve) => {
    const snapshot: CapturedMarketDataSnapshot = { impliedVolatility: null, avgOptionVolume: null };
    let settled = false;

    const haveBoth = () => snapshot.impliedVolatility !== null && snapshot.avgOptionVolume !== null;

    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      if ((field as unknown as number) === OPTION_IMPLIED_VOL_TICK) snapshot.impliedVolatility = value;
      if ((field as unknown as number) === AVG_OPT_VOLUME_TICK) snapshot.avgOptionVolume = value;
      if (haveBoth()) finish();
    };

    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.tickGeneric, onTick);
      connection.ib.off(EventName.tickSize, onTick);
      connection.ib.cancelMktData(reqId);
      resolve(snapshot);
    }

    connection.ib.on(EventName.tickGeneric, onTick);
    connection.ib.on(EventName.tickSize, onTick);
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "105,106", false, false);
  });
}
