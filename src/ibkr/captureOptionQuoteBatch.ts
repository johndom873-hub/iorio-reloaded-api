import { EventName, Option, OptionType } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";

// Quote collector for the nightly option-chain archive (IORIO Signal Engine,
// Phase 0). Deliberately a NEW module rather than a change to
// fetchQuotesForContracts (fetchOptionChain.ts), which trade-alert generation
// and the Ticker Detail chain depend on: that one ignores bid/ask sizes, open
// interest, volume, the option's model price and the underlying price the
// model used — all needed for the archive — and altering it risks live alerts.
// Same subscription pattern, wider capture.
//
// Streaming reqMktData, one subscription per contract, with generic tick 101
// requested for open interest. The caller must keep a batch to the agreed ~60
// lines: the ~100-line market-data quota is shared across the whole Gateway.
//
// CONFIRMED LIVE (2026-09-21, pre-market, AMAT): open interest, bid/ask sizes
// and volume all arrive per contract as tickSize 27/28, 0/3 and 8 in streaming
// mode under generic tick 101 (details at the open-interest constants below).
// STILL UNVERIFIED: the model computation ticks (13/83 — IV, greeks, model
// price, spot used) and real bid/ask prices, which only flow during market
// hours; the probe at the open settles those.

const openInterestGenericTickList = "101";
const defaultBatchCeilingMs = 8_000;

// Request ids for a one-shot connection (a shared connection allocates its own
// via nextReqIdFor). Module-level, not per call, so two batches running
// concurrently on the same socket can never reuse an id.
let nextFallbackReqId = 20_000;

// Tick types (interactivebrokers.github.io/tws-api/tick_types.html). Real-time
// and delayed variants are both accepted — see the tick-type notes in
// fetchOptionChain.ts (accepting only one silently drops data).
const bidPriceTicks = new Set([1, 66]);
const askPriceTicks = new Set([2, 67]);
const lastPriceTicks = new Set([4, 68]);
const bidSizeTicks = new Set([0, 69]);
const askSizeTicks = new Set([3, 70]);
const volumeTicks = new Set([8, 74]);
// Confirmed LIVE 2026-09-21 (paper Gateway, AMAT): for every option contract
// IBKR sends BOTH 27 and 28, but 27 carries the open interest of CALLS and 28
// of PUTS — the tick for the other right is always 0. A call must read 27 and
// a put 28, otherwise whichever arrives last silently overwrites the real
// number with that 0.
const callOpenInterestTick = 27;
const putOpenInterestTick = 28;
const modelComputationTicks = new Set([13, 83]);
// Open interest (27/28) is deliberately NOT here: it is static daily data that
// arrives the same way whether the price feed is real-time or delayed, so it
// says nothing about which kind of feed this was.
const realTimeTickTypes = new Set([0, 1, 2, 3, 4, 8, 13]);
const delayedTickTypes = new Set([66, 67, 68, 69, 70, 74, 83]);

export interface OptionContractRequest {
  expiry: string; // YYYYMMDD
  strike: number;
  right: "C" | "P";
}

export interface CapturedOptionQuote extends OptionContractRequest {
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  modelOptionPrice: number | null;
  underlyingPrice: number | null;
  openInterest: number | null;
  volume: number | null;
  /** Any price/size/computation tick arrived for this contract — what the "starved ticker" rule counts. */
  receivedAnyTick: boolean;
  sawRealTimeTicks: boolean;
  sawDelayedTicks: boolean;
  /** IBKR error code raised for this contract's request (e.g. 200 no security definition, 101 ticker limit), if any. */
  errorCode: number | null;
}

export interface CaptureOptionQuoteBatchOptions {
  /** Safety ceiling for the whole batch. Streaming has no IBKR-side "done" event. */
  ceilingMs?: number;
  /** When every contract is settled the batch resolves early. Overridable so live testing can tune it. */
  isSettled?: (quote: CapturedOptionQuote) => boolean;
}

/** Default: a price (two-sided or last), a model delta and an open-interest reading, or an error that means no data is coming. */
export function isOptionQuoteSettledByDefault(quote: CapturedOptionQuote): boolean {
  if (quote.errorCode !== null) return true;
  const hasPrice = (quote.bid !== null && quote.ask !== null) || quote.last !== null;
  return hasPrice && quote.delta !== null && quote.openInterest !== null;
}

// IBKR marks "no data" with -1 (prices/sizes) or an enormous sentinel
// (computation fields), depending on field — normalized to null here so a
// field that isn't quoted never gets stored as a real number.
function normalizePrice(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1e10 ? value : null;
}
function normalizeSize(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value < 1e10 ? value : null;
}
function normalizeImpliedVolatility(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1e3 ? value : null;
}
function normalizeDelta(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && Math.abs(value) <= 1 ? value : null;
}
// Theta has no sign that identifies "not computed", so only enormous sentinels are rejected.
function normalizeTheta(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && Math.abs(value) < 1e6 ? value : null;
}
// Gamma and vega of a valid model can never be negative, so IBKR's negative
// "not computed" markers (-1 / -2) are rejected here rather than stored.
function normalizeNonNegativeGreek(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value < 1e6 ? value : null;
}
function normalizeModelPrice(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value < 1e10 ? value : null;
}

export async function captureOptionQuoteBatch(
  ib: IBApi,
  symbol: string,
  contracts: OptionContractRequest[],
  options: CaptureOptionQuoteBatchOptions = {},
): Promise<CapturedOptionQuote[]> {
  const ceilingMs = options.ceilingMs ?? defaultBatchCeilingMs;
  const isSettled = options.isSettled ?? isOptionQuoteSettledByDefault;
  if (contracts.length === 0) return [];

  const quotesByReqId = new Map<number, CapturedOptionQuote>();
  let onAllSettled: (() => void) | null = null;

  function checkAllSettled(): void {
    for (const quote of quotesByReqId.values()) if (!isSettled(quote)) return;
    onAllSettled?.();
  }

  function markTick(quote: CapturedOptionQuote, tickType: number): void {
    quote.receivedAnyTick = true;
    if (realTimeTickTypes.has(tickType)) quote.sawRealTimeTicks = true;
    if (delayedTickTypes.has(tickType)) quote.sawDelayedTicks = true;
  }

  function onTickPrice(reqId: number, tickType: number, price: number): void {
    const quote = quotesByReqId.get(reqId);
    if (!quote) return;
    markTick(quote, tickType);
    if (bidPriceTicks.has(tickType)) quote.bid = normalizePrice(price);
    if (askPriceTicks.has(tickType)) quote.ask = normalizePrice(price);
    if (lastPriceTicks.has(tickType)) quote.last = normalizePrice(price);
    checkAllSettled();
  }

  function onTickSize(reqId: number, tickType: number | undefined, size: number | undefined): void {
    const quote = quotesByReqId.get(reqId);
    if (!quote || tickType === undefined) return;
    markTick(quote, tickType);
    if (bidSizeTicks.has(tickType)) quote.bidSize = normalizeSize(size);
    if (askSizeTicks.has(tickType)) quote.askSize = normalizeSize(size);
    if (volumeTicks.has(tickType)) quote.volume = normalizeSize(size);
    if (tickType === callOpenInterestTick && quote.right === "C") quote.openInterest = normalizeSize(size);
    if (tickType === putOpenInterestTick && quote.right === "P") quote.openInterest = normalizeSize(size);
    checkAllSettled();
  }

  function onTickOptionComputation(
    reqId: number,
    tickType: number,
    _tickAttrib: number | undefined,
    impliedVolatility?: number,
    delta?: number,
    optionPrice?: number,
    _presentValueDividend?: number,
    gamma?: number,
    vega?: number,
    theta?: number,
    underlyingPrice?: number,
  ): void {
    const quote = quotesByReqId.get(reqId);
    if (!quote) return;
    markTick(quote, tickType);
    // Model computation only (13 real-time / 83 delayed) — the bid/ask/last
    // computation ticks depend on a stale last trade, same reasoning as
    // fetchOptionChain.ts.
    if (!modelComputationTicks.has(tickType)) {
      checkAllSettled();
      return;
    }
    quote.impliedVolatility = normalizeImpliedVolatility(impliedVolatility);
    quote.delta = normalizeDelta(delta);
    quote.gamma = normalizeNonNegativeGreek(gamma);
    quote.vega = normalizeNonNegativeGreek(vega);
    quote.theta = normalizeTheta(theta);
    quote.modelOptionPrice = normalizeModelPrice(optionPrice);
    quote.underlyingPrice = normalizePrice(underlyingPrice);
    checkAllSettled();
  }

  function onError(error: Error, code: number, reqId: number): void {
    const quote = quotesByReqId.get(reqId);
    if (!quote) return;
    // Informational "using delayed data" notices, not a failure for this contract.
    if (isDelayedDataFallbackNotice(code)) return;
    quote.errorCode = code;
    console.warn(`Option capture error for ${symbol} ${quote.expiry} ${quote.strike}${quote.right} (code ${code}): ${error.message}`);
    checkAllSettled();
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickSize, onTickSize);
  ib.on(EventName.tickOptionComputation, onTickOptionComputation);
  ib.on(EventName.error, onError);

  try {
    for (const contract of contracts) {
      const reqId = nextReqIdFor(ib, () => nextFallbackReqId++);
      quotesByReqId.set(reqId, {
        ...contract,
        bid: null,
        ask: null,
        last: null,
        bidSize: null,
        askSize: null,
        impliedVolatility: null,
        delta: null,
        gamma: null,
        vega: null,
        theta: null,
        modelOptionPrice: null,
        underlyingPrice: null,
        openInterest: null,
        volume: null,
        receivedAnyTick: false,
        sawRealTimeTicks: false,
        sawDelayedTicks: false,
        errorCode: null,
      });
      const right = contract.right === "C" ? OptionType.Call : OptionType.Put;
      ib.reqMktData(reqId, new Option(symbol, contract.expiry, contract.strike, right, "SMART"), openInterestGenericTickList, false, false);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ceilingMs);
      onAllSettled = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  } finally {
    for (const reqId of quotesByReqId.keys()) ib.cancelMktData(reqId);
    ib.removeListener(EventName.tickPrice, onTickPrice);
    ib.removeListener(EventName.tickSize, onTickSize);
    ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
    ib.removeListener(EventName.error, onError);
  }

  return Array.from(quotesByReqId.values());
}
