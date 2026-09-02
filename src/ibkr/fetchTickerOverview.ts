import { BarSizeSetting, EventName, Stock, WhatToShow } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { isDelayedDataFallbackNotice, requestRealtimeMarketData } from "./requestMarketData.js";

export interface TickerPricing {
  last: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
}

export interface PriceBar {
  time: number; // Unix epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ChartRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "All";

// Matches menaris-admin-app's per-range bar granularity (services/chart-service.js
// RANGE_CONFIG), verified against real IBKR data (tmp/test-intraday-bars.ts,
// tmp/test-remaining-bars.ts) rather than assumed — every combo below returned
// hundreds of real bars.
const rangeConfig: Record<ChartRange, { barSize: BarSizeSetting; duration: string }> = {
  "1D": { barSize: BarSizeSetting.MINUTES_ONE, duration: "2 D" },
  "5D": { barSize: BarSizeSetting.MINUTES_FIVE, duration: "7 D" },
  "1M": { barSize: BarSizeSetting.MINUTES_THIRTY, duration: "1 M" },
  "3M": { barSize: BarSizeSetting.HOURS_ONE, duration: "3 M" },
  "6M": { barSize: BarSizeSetting.HOURS_TWO, duration: "6 M" },
  "1Y": { barSize: BarSizeSetting.DAYS_ONE, duration: "1 Y" },
  "5Y": { barSize: BarSizeSetting.WEEKS_ONE, duration: "5 Y" },
  All: { barSize: BarSizeSetting.WEEKS_ONE, duration: "20 Y" },
};

// IBKR's historicalData date field is only a Unix-epoch-seconds string (with
// formatDate=2) for bars smaller than 1 day — daily/weekly bars always come
// back as a plain YYYYMMDD string regardless of formatDate. Verified
// empirically (tmp/test-bar-date-format.ts), not assumed from docs.
function parseIbkrBarTime(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d{8}$/.test(trimmed)) {
    const iso = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T00:00:00Z`;
    return Math.floor(new Date(iso).getTime() / 1000);
  }
  return Number(trimmed);
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

/**
 * One-shot pricing snapshot — for callers that need a single point-in-time
 * price and move on programmatically (trade alert generation/refresh, the
 * New Position live-quote stream), not a long-lived UI screen. See
 * streamPricingUpdates below for the continuous version the Ticker Detail
 * modal uses instead.
 *
 * Shares an already-open connection — see the reqMarketDataType note on
 * streamPricingUpdates below; the same constraint applies here.
 */
export async function lookupPricingSnapshot(connection: IbkrConnection, symbol: string, reqId = 1): Promise<TickerPricing> {
  const { ib } = connection;

  return new Promise((resolve, reject) => {
    const pricing: TickerPricing = {
      last: null,
      bid: null,
      ask: null,
      open: null,
      high: null,
      low: null,
      previousClose: null,
      volume: null,
    };
    let lastError: string | null = null;
    const timer = setTimeout(() => reject(new Error(lastError ?? `Pricing snapshot timeout for ${symbol}`)), 10_000);

    function onTickPrice(id: number, tickType: number, price: number) {
      if (id !== reqId) return;
      // IBKR sends -1 as an explicit "no data for this field right now" tick
      // (found 2026-08-27 investigating stale post-close bid/ask that never
      // cleared) -- normalized to null here rather than silently dropped, so
      // a field that genuinely stops being quoted goes back to "no data"
      // instead of freezing on the last real value it ever held.
      const value = price > 0 ? price : null;
      // Real-time tick types: bid=1, ask=2, last=4, high=6, low=7, close=9, open=14.
      // Delayed: bid=66, ask=67, last=68, high=72, low=73, close=75, open=76.
      // Accepts both — real-time entitlement enabled 2026-08-31 sends
      // real-time tick types regardless of what reqMarketDataType() requests; an
      // accept-delayed-only filter here silently produced null spot prices
      // for every ticker from that point on (see fetchOptionChain.ts's
      // matching comment on the trade-alert outage this caused).
      if (tickType === 1 || tickType === 66) pricing.bid = value;
      if (tickType === 2 || tickType === 67) pricing.ask = value;
      if (tickType === 4 || tickType === 68) pricing.last = value;
      if (tickType === 6 || tickType === 72) pricing.high = value;
      if (tickType === 7 || tickType === 73) pricing.low = value;
      if (tickType === 9 || tickType === 75) pricing.previousClose = value;
      if (tickType === 14 || tickType === 76) pricing.open = value;
    }
    function onTickSize(id: number, tickType?: number, size?: number) {
      if (id !== reqId || size === undefined) return;
      // Real-time volume = 8, delayed = 74.
      if (tickType === 8 || tickType === 74) pricing.volume = size;
    }
    function onSnapshotEnd(id: number) {
      if (id !== reqId) return;
      clearTimeout(timer);
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.removeListener(EventName.tickSize, onTickSize);
      ib.removeListener(EventName.tickSnapshotEnd, onSnapshotEnd);
      ib.removeListener(EventName.error, onError);
      resolve(pricing);
    }

    // Captured, not rejected on: IBKR sends routine warnings (e.g. "Requested
    // market data is not subscribed. Displaying delayed market data.")
    // through this same error event for reqIds that still go on to receive
    // ticks and succeed. Rejecting here would break those. Logged AND
    // captured so that when a symbol comes back with no last/previousClose
    // at all and the timeout above fires, the real IBKR reason — permissions,
    // unrecognized symbol, etc. — reaches the caller instead of just the
    // generic timeout string.
    function onError(error: Error, code: number, errorReqId: number) {
      if (errorReqId !== reqId) return;
      if (isDelayedDataFallbackNotice(code)) return;
      console.warn(`IBKR pricing snapshot warning for ${symbol} (code ${code}): ${error.message}`);
      lastError = `Pricing snapshot error for ${symbol} (code ${code}): ${error.message}`;
    }

    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.tickSize, onTickSize);
    ib.once(EventName.tickSnapshotEnd, onSnapshotEnd);
    ib.on(EventName.error, onError);
    ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "", true, false);
  });
}


/**
 * Continuous streaming version of a pricing lookup (approved 2026-08-26 —
 * the modal should show live-updating prices, not a one-time snapshot).
 * Resolves once with the first usable reading (same readiness bar as the
 * old snapshot version: at least one price tick in), then keeps calling
 * onUpdate with the accumulated pricing on a fixed interval until `signal`
 * aborts — the caller (streamTickerDetail.ts) aborts when the SSE client
 * disconnects. Cancels the market data subscription and cleans up its
 * listeners on abort, same as any other IBKR call site.
 *
 * Shares an already-open connection — see streamTickerDetail.ts, which
 * calls `reqMarketDataType` itself, once, before starting this alongside
 * lookupHistoricalBars/prepareOptionChainStrikes on the same connection.
 * Do not call reqMarketDataType here too: it's connection-wide, and a
 * second call while this subscription is still outstanding was found to
 * silently prevent it from ever producing a first tick — reproduced as a
 * "Pricing snapshot timeout" once optionChain's metadata prep started
 * running concurrently with this instead of strictly after it.
 */
export async function streamPricingUpdates(
  connection: IbkrConnection,
  symbol: string,
  onUpdate: (pricing: TickerPricing) => void,
  signal: AbortSignal,
  reqId = 1,
): Promise<TickerPricing> {
  const { ib } = connection;

  const pricing: TickerPricing = {
    last: null,
    bid: null,
    ask: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    volume: null,
  };

  // True real-time push (approved 2026-08-27, replacing a fixed 1.5s
  // interval): every tick calls onUpdate, coalesced only within the same
  // event-loop turn via setImmediate — IBKR often delivers several tick
  // types (bid, ask, last, size) back to back from one network read, and
  // without this a single incoming update would fan out into several
  // separate SSE writes of the same-ish snapshot. This still pushes on
  // every genuinely new tick, just not once-per-field when they arrive
  // microseconds apart.
  let pushScheduled = false;
  function schedulePush() {
    if (pushScheduled || !liveModeStarted) return;
    pushScheduled = true;
    setImmediate(() => {
      pushScheduled = false;
      onUpdate({ ...pricing });
    });
  }
  let liveModeStarted = false;

  function onTickPrice(id: number, tickType: number, price: number) {
    if (id !== reqId) return;
    // IBKR sends -1 as an explicit "no data for this field right now" tick
    // (found 2026-08-27 investigating stale post-close bid/ask that never
    // cleared) -- normalized to null here rather than silently dropped, so a
    // field that genuinely stops being quoted goes back to "no data" instead
    // of freezing on the last real value it ever held for the rest of this
    // streaming session.
    const value = price > 0 ? price : null;
    // Real-time (1/2/4/6/7/9/14) and delayed (66/67/68/72/73/75/76) tick
    // types both accepted — see the matching comment on lookupPricingSnapshot
    // above.
    if (tickType === 1 || tickType === 66) pricing.bid = value;
    if (tickType === 2 || tickType === 67) pricing.ask = value;
    if (tickType === 4 || tickType === 68) pricing.last = value;
    if (tickType === 6 || tickType === 72) pricing.high = value;
    if (tickType === 7 || tickType === 73) pricing.low = value;
    if (tickType === 9 || tickType === 75) pricing.previousClose = value;
    if (tickType === 14 || tickType === 76) pricing.open = value;
    schedulePush();
  }
  function onTickSize(id: number, tickType?: number, size?: number) {
    if (id !== reqId || size === undefined) return;
    // Real-time volume = 8, delayed = 74.
    if (tickType === 8 || tickType === 74) pricing.volume = size;
    schedulePush();
  }

  let lastError: string | null = null;
  // Captured, not rejected on: IBKR sends routine warnings (e.g. "Requested
  // market data is not subscribed. Displaying delayed market data.")
  // through this same error event for reqIds that still go on to receive
  // ticks and succeed. Rejecting here would break those. Logged AND
  // captured so that when a symbol comes back with no price at all and the
  // initial-readiness timeout below fires, the real IBKR reason —
  // permissions, a competing session, etc. — reaches the caller instead of
  // just a generic timeout string.
  function onError(error: Error, code: number, errorReqId: number) {
    if (errorReqId !== reqId) return;
    if (isDelayedDataFallbackNotice(code)) return;
    console.warn(`IBKR pricing stream warning for ${symbol} (code ${code}): ${error.message}`);
    lastError = `Pricing stream error for ${symbol} (code ${code}): ${error.message}`;
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickSize, onTickSize);
  ib.on(EventName.error, onError);
  // snapshot=false: a genuine streaming subscription, not a one-shot
  // snapshot — ticks keep arriving for as long as this stays subscribed,
  // which is what lets onUpdate below report a live-updating price instead
  // of a value frozen at whatever it was the moment the modal opened.
  ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "", false, false);

  function cleanup() {
    ib.cancelMktData(reqId);
    ib.removeListener(EventName.tickPrice, onTickPrice);
    ib.removeListener(EventName.tickSize, onTickSize);
    ib.removeListener(EventName.error, onError);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(lastError ?? `Pricing snapshot timeout for ${symbol}`));
    }, 10_000);
    const readyCheck = setInterval(() => {
      if (pricing.last === null && pricing.previousClose === null) return;
      clearInterval(readyCheck);
      clearTimeout(timer);
      resolve();
    }, 200);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(readyCheck);
        clearTimeout(timer);
        cleanup();
        resolve();
      },
      { once: true },
    );
  });

  // liveModeStarted gates schedulePush above so nothing pushes during the
  // ready-wait: the initial reading already satisfies this function's own
  // promise (callers like streamTickerDetail.ts's optionChainTask need that
  // first spot price right away, not once the whole streaming session
  // eventually ends) — real-time pushing of every subsequent tick starts
  // only once that's resolved, and keeps going until `signal` aborts.
  if (!signal.aborted) {
    liveModeStarted = true;
    signal.addEventListener("abort", cleanup, { once: true });
  }

  return pricing;
}

/**
 * Low-level historical-bars fetch, parameterized directly by IBKR bar
 * size/duration rather than a ChartRange — extracted so priceBarCache.ts can
 * also request short "top-up" windows (e.g. "5 D" of daily bars to refresh a
 * warm cache) that don't correspond to any of the fixed ChartRange presets
 * below. lookupHistoricalBars (the ChartRange-based version everything else
 * still uses) is now a thin wrapper around this.
 */
export async function fetchHistoricalBarsRaw(
  connection: IbkrConnection,
  symbol: string,
  barSize: BarSizeSetting,
  duration: string,
  reqId = 1,
  whatToShow: WhatToShow = WhatToShow.TRADES,
): Promise<PriceBar[]> {
  const { ib } = connection;

  return new Promise((resolve, reject) => {
    const bars: PriceBar[] = [];
    const timer = setTimeout(() => reject(new Error(`Historical data timeout for ${symbol}`)), 20_000);

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.historicalData, onHistoricalData);
      ib.removeListener(EventName.error, onError);
    }

    function onHistoricalData(
      id: number,
      date: string,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ) {
      if (id !== reqId) return;
      if (date.startsWith("finished")) {
        cleanup();
        resolve(bars);
        return;
      }
      bars.push({ time: parseIbkrBarTime(date), open, high, low, close, volume });
    }

    function onError(error: Error, code: number, errorReqId: number) {
      if (errorReqId !== reqId) return;
      cleanup();
      reject(new Error(`Historical data error for ${symbol} (code ${code}): ${error.message}`));
    }

    ib.on(EventName.historicalData, onHistoricalData);
    ib.on(EventName.error, onError);
    ib.reqHistoricalData(reqId, new Stock(symbol, "SMART", "USD"), "", duration, barSize, whatToShow, 1, 2, false);
  });
}

/** Shares an already-open connection — see the reqMarketDataType note on lookupPricingSnapshot above. */
export async function lookupHistoricalBars(
  connection: IbkrConnection,
  symbol: string,
  range: ChartRange,
  reqId = 1,
): Promise<PriceBar[]> {
  const { barSize, duration } = rangeConfig[range];
  return fetchHistoricalBarsRaw(connection, symbol, barSize, duration, reqId);
}

export async function fetchPriceBars(symbol: string, range: ChartRange): Promise<PriceBar[]> {
  const connection = await connectToIbkrGateway();
  try {
    requestRealtimeMarketData(connection.ib);
    return await lookupHistoricalBars(connection, symbol, range);
  } finally {
    connection.disconnect();
  }
}

/**
 * Shares an already-open connection — see the reqMarketDataType note on
 * lookupPricingSnapshot above. Daily-bar sibling of lookupHistoricalBars,
 * used by the daily price/IV capture job: "2 D" duration (not "1 D") so a
 * completed daily bar exists even right after a weekend/holiday, since
 * IBKR only returns *completed* daily bars, not the still-forming one for
 * today. Returns the most recent bar, or null if none came back (e.g. the
 * job runs before the first daily bar of a newly-added ticker exists).
 */
export async function lookupLatestDailyBar(
  connection: IbkrConnection,
  symbol: string,
  reqId = 1,
  whatToShow: WhatToShow = WhatToShow.TRADES,
): Promise<PriceBar | null> {
  const { ib } = connection;

  return new Promise((resolve, reject) => {
    const bars: PriceBar[] = [];
    const timer = setTimeout(() => reject(new Error(`Historical data timeout for ${symbol}`)), 20_000);

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.historicalData, onHistoricalData);
      ib.removeListener(EventName.error, onError);
    }

    function onHistoricalData(id: number, date: string, open: number, high: number, low: number, close: number, volume: number) {
      if (id !== reqId) return;
      if (date.startsWith("finished")) {
        cleanup();
        resolve(bars.at(-1) ?? null);
        return;
      }
      bars.push({ time: parseIbkrBarTime(date), open, high, low, close, volume });
    }

    function onError(error: Error, code: number, errorReqId: number) {
      if (errorReqId !== reqId) return;
      cleanup();
      reject(new Error(`Historical data error for ${symbol} (code ${code}): ${error.message}`));
    }

    ib.on(EventName.historicalData, onHistoricalData);
    ib.on(EventName.error, onError);
    ib.reqHistoricalData(reqId, new Stock(symbol, "SMART", "USD"), "", "2 D", BarSizeSetting.DAYS_ONE, whatToShow, 1, 2, false);
  });
}
