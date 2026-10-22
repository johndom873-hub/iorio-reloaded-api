import { EventName, Stock, type TickType } from "@stoqey/ib";
import { randomUUID } from "node:crypto";
import { describeMarketDataLineShortage, releaseMarketDataLines, reserveMarketDataLines } from "./marketDataLineBudget.js";
import type { IbkrConnection } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";

const defaultEnrichmentTimeoutMs = 15_000;

// Same empirically-confirmed mapping captureMarketDataSnapshot.ts uses for
// generic tick 106 (see that file's comment — tested against the real
// paper Gateway). LAST is IBKR's standard default tick field
// (interactivebrokers.github.io/tws-api/tick_types.html).
//
// Both real-time and delayed tick IDs are accepted for last —
// requestRealtimeMarketData always *requests* REALTIME, but IBKR can still
// substitute delayed data per-symbol on its own (see
// [[project_ibkr_realtime_autofallback_to_delayed]]); same pattern as
// fetchLivePrices.ts/fetchTickerOverview.ts. The generic ticks below
// (avg volume, option IV, open interest) have no separate delayed IDs.
const LAST_TICK = 4;
const DELAYED_LAST_TICK = 68;
const OPTION_IMPLIED_VOL_TICK = 24;
const AVG_VOLUME_TICK = 21;
const OPTION_CALL_OPEN_INTEREST_TICK = 27;
const OPTION_PUT_OPEN_INTEREST_TICK = 28;
// "No security definition has been found" (or an ambiguous contract): IBKR drops the request, so no tick will ever follow.
export const NO_SECURITY_DEFINITION_ERROR_CODE = 200;

export interface CandidateEnrichment {
  lastPrice: number | null;
  avgShareVolume: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  impliedVolatility: number | null;
  // The last error IBKR sent for this request (e.g. code 200 after a ticker change), null when none.
  ibkrError: { code: number; message: string } | null;
}

// A line taken by another holder between two symbols is usually free again within seconds.
const lineShortageRetryDelayMs = 2_000;
const lineShortageRetries = 3;

/**
 * One reqMktData call per candidate, generic ticks "101,106,165" plus
 * the default last price field, on one budgeted line. Caller owns the
 * connection's lifecycle. Several may run at once on one connection (the
 * screener job runs 20 after the close, measured 2026-10-22: every field
 * still arrives, about a second later per symbol); each books its own line.
 */
export async function enrichCandidate(
  connection: IbkrConnection,
  reqId: number,
  symbol: string,
  timeoutMs: number = defaultEnrichmentTimeoutMs,
): Promise<CandidateEnrichment> {
  const holder = `snapshot:scanner:${symbol}:${randomUUID()}`;
  let reservation = await reserveMarketDataLines(holder, 1, Math.ceil(timeoutMs / 1000) + 5);
  for (let retry = 1; !reservation.ok && !reservation.disabled && retry <= lineShortageRetries; retry++) {
    await new Promise((resolve) => setTimeout(resolve, lineShortageRetryDelayMs));
    reservation = await reserveMarketDataLines(holder, 1, Math.ceil(timeoutMs / 1000) + 5);
  }
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, `${symbol} scanner enrichment`, 1));
  try {
    return await enrichCandidateUnbudgeted(connection, reqId, symbol, timeoutMs);
  } finally {
    releaseMarketDataLines(holder).catch((error) => console.warn(`Failed to release IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }
}

// Settles a short grace after every field it asks for has arrived instead of
// always waiting the full timeout (2026-09-24); the timeout stays as the ceiling.
const afterAllFieldsGraceMs = 500;

function enrichCandidateUnbudgeted(connection: IbkrConnection, reqId: number, symbol: string, timeoutMs: number): Promise<CandidateEnrichment> {
  return new Promise((resolve) => {
    const result: CandidateEnrichment = {
      lastPrice: null,
      avgShareVolume: null,
      callOpenInterest: null,
      putOpenInterest: null,
      impliedVolatility: null,
      ibkrError: null,
    };
    let settled = false;

    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      const fieldId = field as unknown as number;
      // IBKR sends -1 for "no data" on a last-price tick: it is neither a price nor an arrival.
      const isLastPriceTick = fieldId === LAST_TICK || fieldId === DELAYED_LAST_TICK;
      if (isLastPriceTick && value < 0) return;
      if (isLastPriceTick) result.lastPrice = value;
      if (fieldId === AVG_VOLUME_TICK) result.avgShareVolume = value;
      if (fieldId === OPTION_IMPLIED_VOL_TICK) result.impliedVolatility = value;
      if (fieldId === OPTION_CALL_OPEN_INTEREST_TICK) result.callOpenInterest = value;
      if (fieldId === OPTION_PUT_OPEN_INTEREST_TICK) result.putOpenInterest = value;
      const allFieldsIn = result.lastPrice !== null && result.avgShareVolume !== null && result.impliedVolatility !== null && result.callOpenInterest !== null && result.putOpenInterest !== null;
      if (allFieldsIn && graceTimer === null) graceTimer = setTimeout(finish, afterAllFieldsGraceMs);
    };

    const onError = (error: Error, code: number, errorReqId: number) => {
      if (errorReqId !== reqId) return;
      result.ibkrError = { code, message: error.message };
      if (code === NO_SECURITY_DEFINITION_ERROR_CODE) finish();
    };

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      connection.ib.off(EventName.tickPrice, onTick);
      connection.ib.off(EventName.tickSize, onTick);
      connection.ib.off(EventName.tickGeneric, onTick);
      connection.ib.off(EventName.error, onError);
      // IBKR already dropped a request it rejected with 200: cancelling it only draws a "Can't find EId" error.
      if (result.ibkrError?.code !== NO_SECURITY_DEFINITION_ERROR_CODE) connection.ib.cancelMktData(reqId);
      resolve(result);
    }

    connection.ib.on(EventName.tickPrice, onTick);
    connection.ib.on(EventName.tickSize, onTick);
    connection.ib.on(EventName.tickGeneric, onTick);
    connection.ib.on(EventName.error, onError);

    requestRealtimeMarketData(connection.ib);
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "101,106,165", false, false);
  });
}
