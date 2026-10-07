import { EventName, Stock, type TickType } from "@stoqey/ib";
import { randomUUID } from "node:crypto";
import { describeMarketDataLineShortage, releaseMarketDataLines, reserveMarketDataLines } from "./marketDataLineBudget.js";
import type { IbkrConnection } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";

const defaultEnrichmentTimeoutMs = 15_000;

// Same empirically-confirmed mapping captureMarketDataSnapshot.ts uses for
// generic ticks 105/106 (see that file's comment — tested against the real
// paper Gateway). BID/ASK/LAST/VOLUME are IBKR's standard default tick
// fields (interactivebrokers.github.io/tws-api/tick_types.html), not yet
// individually re-verified against this account's entitlements the way
// 24/87 were — flagged for the same Monday market-hours check as
// fetchScannerCandidates.ts's ratio parsing.
//
// Both real-time and delayed tick IDs are accepted for bid/ask/last —
// requestRealtimeMarketData always *requests* REALTIME, but IBKR can still
// substitute delayed data per-symbol on its own (see
// [[project_ibkr_realtime_autofallback_to_delayed]]); same pattern as
// fetchLivePrices.ts/fetchTickerOverview.ts. The generic ticks below
// (avg volume, option IV, open interest) have no separate delayed IDs.
const BID_TICK = 1;
const DELAYED_BID_TICK = 66;
const ASK_TICK = 2;
const DELAYED_ASK_TICK = 67;
const LAST_TICK = 4;
const DELAYED_LAST_TICK = 68;
const VOLUME_TICK = 8;
const OPTION_IMPLIED_VOL_TICK = 24;
const AVG_VOLUME_TICK = 21;
const OPTION_CALL_OPEN_INTEREST_TICK = 27;
const OPTION_PUT_OPEN_INTEREST_TICK = 28;
const AVG_OPT_VOLUME_TICK = 87;
// "No security definition has been found" (or an ambiguous contract): IBKR drops the request, so no tick will ever follow.
const NO_SECURITY_DEFINITION_ERROR_CODE = 200;

export interface CandidateEnrichment {
  lastPrice: number | null;
  avgShareVolume: number | null;
  avgOptionVolume: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  bidAskSpreadPct: number | null;
  impliedVolatility: number | null;
  // The last error IBKR sent for this request (e.g. code 200 after a ticker change), null when none.
  ibkrError: { code: number; message: string } | null;
}

/**
 * One reqMktData call per candidate, generic ticks "100,101,106,165" plus
 * the default bid/ask/last/volume fields. Caller owns the connection's
 * lifecycle and must run these SEQUENTIALLY on a shared connection (not
 * Promise.all) — matches the daily capture job's existing per-ticker
 * pacing, since this codebase has hit real IBKR pacing/contention bugs
 * firing concurrent requests before (see PROGRESS.md).
 */
export async function enrichCandidate(
  connection: IbkrConnection,
  reqId: number,
  symbol: string,
  timeoutMs: number = defaultEnrichmentTimeoutMs,
): Promise<CandidateEnrichment> {
  const holder = `snapshot:scanner:${symbol}:${randomUUID()}`;
  const reservation = await reserveMarketDataLines(holder, 1, Math.ceil(timeoutMs / 1000) + 5);
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
    let bid: number | null = null;
    let ask: number | null = null;
    const result: CandidateEnrichment = {
      lastPrice: null,
      avgShareVolume: null,
      avgOptionVolume: null,
      callOpenInterest: null,
      putOpenInterest: null,
      bidAskSpreadPct: null,
      impliedVolatility: null,
      ibkrError: null,
    };
    let settled = false;

    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      const fieldId = field as unknown as number;
      // IBKR sends -1 for "no data" on a price tick: it is neither a price nor an arrival.
      const isPriceTick = fieldId === BID_TICK || fieldId === DELAYED_BID_TICK || fieldId === ASK_TICK || fieldId === DELAYED_ASK_TICK || fieldId === LAST_TICK || fieldId === DELAYED_LAST_TICK;
      if (isPriceTick && value < 0) return;
      if (fieldId === BID_TICK || fieldId === DELAYED_BID_TICK) bid = value;
      if (fieldId === ASK_TICK || fieldId === DELAYED_ASK_TICK) ask = value;
      if (fieldId === LAST_TICK || fieldId === DELAYED_LAST_TICK) result.lastPrice = value;
      if (fieldId === AVG_VOLUME_TICK) result.avgShareVolume = value;
      if (fieldId === AVG_OPT_VOLUME_TICK) result.avgOptionVolume = value;
      if (fieldId === OPTION_IMPLIED_VOL_TICK) result.impliedVolatility = value;
      if (fieldId === OPTION_CALL_OPEN_INTEREST_TICK) result.callOpenInterest = value;
      if (fieldId === OPTION_PUT_OPEN_INTEREST_TICK) result.putOpenInterest = value;
      const allFieldsIn = bid !== null && ask !== null && result.lastPrice !== null && result.avgShareVolume !== null && result.impliedVolatility !== null && result.callOpenInterest !== null && result.putOpenInterest !== null;
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

      if (bid !== null && ask !== null && ask > 0) {
        const midpoint = (bid + ask) / 2;
        result.bidAskSpreadPct = midpoint > 0 ? (ask - bid) / midpoint : null;
      }
      resolve(result);
    }

    connection.ib.on(EventName.tickPrice, onTick);
    connection.ib.on(EventName.tickSize, onTick);
    connection.ib.on(EventName.tickGeneric, onTick);
    connection.ib.on(EventName.error, onError);

    requestRealtimeMarketData(connection.ib);
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "100,101,106,165", false, false);
  });
}
