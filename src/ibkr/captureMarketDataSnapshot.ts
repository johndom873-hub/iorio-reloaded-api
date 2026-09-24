import { EventName, Stock, type TickType } from "@stoqey/ib";
import { randomUUID } from "node:crypto";
import type { IbkrConnection } from "./connectIbkr.js";
import { describeMarketDataLineShortage, releaseMarketDataLines, reserveMarketDataLines } from "./marketDataLineBudget.js";

const defaultSnapshotTimeoutMs = 15_000;
// Average option volume (tick 87) consistently never arrives (see PROGRESS.md),
// so waiting the full timeout for it cost every ticker add 5-15 s. Once IV is
// in, a short grace is all the volume tick gets (2026-09-24).
const afterImpliedVolatilityGraceMs = 500;

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
export async function captureMarketDataSnapshot(
  connection: IbkrConnection,
  reqId: number,
  symbol: string,
  timeoutMs: number = defaultSnapshotTimeoutMs,
): Promise<CapturedMarketDataSnapshot> {
  const holder = `snapshot:marketData:${symbol}:${randomUUID()}`;
  const reservation = await reserveMarketDataLines(holder, 1, Math.ceil(timeoutMs / 1000) + 5);
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, `${symbol} market data`, 1));
  try {
    return await captureMarketDataSnapshotUnbudgeted(connection, reqId, symbol, timeoutMs);
  } finally {
    releaseMarketDataLines(holder).catch((error) => console.warn(`Failed to release IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }
}

function captureMarketDataSnapshotUnbudgeted(connection: IbkrConnection, reqId: number, symbol: string, timeoutMs: number): Promise<CapturedMarketDataSnapshot> {
  return new Promise((resolve) => {
    const snapshot: CapturedMarketDataSnapshot = { impliedVolatility: null, avgOptionVolume: null };
    let settled = false;

    const haveBoth = () => snapshot.impliedVolatility !== null && snapshot.avgOptionVolume !== null;

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      if ((field as unknown as number) === OPTION_IMPLIED_VOL_TICK) snapshot.impliedVolatility = value;
      if ((field as unknown as number) === AVG_OPT_VOLUME_TICK) snapshot.avgOptionVolume = value;
      if (haveBoth()) finish();
      else if (snapshot.impliedVolatility !== null && graceTimer === null) graceTimer = setTimeout(finish, afterImpliedVolatilityGraceMs);
    };

    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
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
