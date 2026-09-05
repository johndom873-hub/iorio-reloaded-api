import { EventName, Stock, type TickType } from "@stoqey/ib";
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
// [[project_ibkr_realtime_autofallback_to_delayed]] and the 2026-08-31
// trade-alert outage this exact gap caused elsewhere); same pattern as
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

export interface CandidateEnrichment {
  lastPrice: number | null;
  avgShareVolume: number | null;
  avgOptionVolume: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  bidAskSpreadPct: number | null;
  impliedVolatility: number | null;
}

/**
 * One reqMktData call per candidate, generic ticks "100,101,106,165" plus
 * the default bid/ask/last/volume fields. Caller owns the connection's
 * lifecycle and must run these SEQUENTIALLY on a shared connection (not
 * Promise.all) — matches the daily capture job's existing per-ticker
 * pacing, since this codebase has hit real IBKR pacing/contention bugs
 * firing concurrent requests before (see PROGRESS.md).
 */
export function enrichCandidate(
  connection: IbkrConnection,
  reqId: number,
  symbol: string,
  timeoutMs: number = defaultEnrichmentTimeoutMs,
): Promise<CandidateEnrichment> {
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
    };
    let settled = false;

    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      const fieldId = field as unknown as number;
      if (fieldId === BID_TICK || fieldId === DELAYED_BID_TICK) bid = value;
      if (fieldId === ASK_TICK || fieldId === DELAYED_ASK_TICK) ask = value;
      if (fieldId === LAST_TICK || fieldId === DELAYED_LAST_TICK) result.lastPrice = value;
      if (fieldId === AVG_VOLUME_TICK) result.avgShareVolume = value;
      if (fieldId === AVG_OPT_VOLUME_TICK) result.avgOptionVolume = value;
      if (fieldId === OPTION_IMPLIED_VOL_TICK) result.impliedVolatility = value;
      if (fieldId === OPTION_CALL_OPEN_INTEREST_TICK) result.callOpenInterest = value;
      if (fieldId === OPTION_PUT_OPEN_INTEREST_TICK) result.putOpenInterest = value;
    };

    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.tickPrice, onTick);
      connection.ib.off(EventName.tickSize, onTick);
      connection.ib.off(EventName.tickGeneric, onTick);
      connection.ib.cancelMktData(reqId);

      if (bid !== null && ask !== null && ask > 0) {
        const midpoint = (bid + ask) / 2;
        result.bidAskSpreadPct = midpoint > 0 ? (ask - bid) / midpoint : null;
      }
      resolve(result);
    }

    connection.ib.on(EventName.tickPrice, onTick);
    connection.ib.on(EventName.tickSize, onTick);
    connection.ib.on(EventName.tickGeneric, onTick);

    requestRealtimeMarketData(connection.ib);
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "100,101,106,165", false, false);
  });
}
