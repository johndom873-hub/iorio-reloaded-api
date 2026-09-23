import { EventName, Option, Stock, type Contract, type IBApi } from "@stoqey/ib";
import { sharedLiveConnection } from "./sharedReadConnection.js";
import { reserveMarketDataLines, releaseMarketDataLines } from "./marketDataLineBudget.js";
import { loadFallbackStockPrices } from "../lib/priceService.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import type { PriceContract } from "./fetchLivePrices.js";

// The ONE place in the app that ever calls IBKR's reqMktData for a live
// (non-order-execution, non-nightly-capture) subscription. One real line per
// distinct contract (stock or option), fanned out to every subscriber
// across every screen — approved 2026-09-24, replacing the earlier design
// of two separate pools (pricePool.ts/greeksPool.ts), which still cost 2
// lines for the same option contract whenever both a price consumer (Pulse's
// P&L) and a greeks consumer (Pulse's greeks) watched it, since IBKR already
// sends bid/ask/last AND the computed greeks on a single plain reqMktData
// subscription (empty generic tick list) — no reason to ever ask twice.
//
// Every option contract subscription requests the same full field set
// (last/bid/ask/delta/gamma/vega/theta/IV/underlying) regardless of what the
// FIRST subscriber actually needed — this is what makes a later subscriber
// wanting different fields (e.g. Ticker Detail joining a contract Pulse
// already warmed for price-only) work correctly without a second
// subscription: nothing here is decided per-consumer, only per-contract.
//
// Always runs on sharedLiveConnection (fixed REALTIME for its whole life,
// see its own header comment). Deliberately does NOT fall back to a
// one-shot connection the way other callers of the shared connections do: a
// per-subscriber fallback during a hiccup would both defeat the dedup and
// risk double-subscribing once the shared connection recovers. A subscriber
// just sees its last known values stop updating until the shared
// connection's own reconnect-with-backoff (unrelated to this file) brings
// it back, at which point every pooled contract is silently re-subscribed
// here with no caller-visible interruption (live-tested 2026-09-24 against
// a forced disconnect, single- and multi-subscriber).
const reservationHolder = "marketDataPool";
const reservationTtlSeconds = 90;
const reservationRenewIntervalMs = 60_000;
const resubscribeRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];

// How long streamPooledPrices/streamPooledGreeks/streamPooledOptionQuotes
// wait for pooled REALTIME data (and, for stock legs, the DB fallback) to
// arrive before declaring their first reading final — same value/reasoning
// as the old frozenGraceMs a real FROZEN request used to provide.
export const settleGraceMs = 3_000;

// Real-time / delayed pairs — see fetchOptionChain.ts's matching comments
// for why both are always accepted (real-time entitlement can label ticks
// with the real-time code even when delayed was expected).
const lastTickTypes = [4, 68];
const bidTickTypes = [1, 66];
const askTickTypes = [2, 67];
const greeksTickTypes = [13, 83];

export interface PooledQuote {
  last: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  impliedVolatility: number | null;
  underlyingPrice: number | null;
}

export const emptyPooledQuote: PooledQuote = {
  last: null,
  bid: null,
  ask: null,
  delta: null,
  gamma: null,
  vega: null,
  theta: null,
  impliedVolatility: null,
  underlyingPrice: null,
};

interface PoolEntry {
  contract: PriceContract;
  /** -1 while unsubscribed from IBKR (never subscribed yet, or the underlying connection dropped). */
  reqId: number;
  quote: PooledQuote;
  subscribers: Set<(quote: PooledQuote) => void>;
}

export function poolKeyFor(contract: PriceContract): string {
  return contract.legType === "stock" ? `stock|${contract.symbol}` : `option|${contract.symbol}|${contract.expiry}|${contract.strike}|${contract.right}`;
}

function buildIbkrContract(contract: PriceContract): Contract {
  return contract.legType === "stock" ? new Stock(contract.symbol, "SMART", "USD") : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right!, "SMART");
}

function quoteEqual(a: PooledQuote, b: PooledQuote): boolean {
  return (
    a.last === b.last &&
    a.bid === b.bid &&
    a.ask === b.ask &&
    a.delta === b.delta &&
    a.gamma === b.gamma &&
    a.vega === b.vega &&
    a.theta === b.theta &&
    a.impliedVolatility === b.impliedVolatility &&
    a.underlyingPrice === b.underlyingPrice
  );
}

const entriesByPoolKey = new Map<string, PoolEntry>();
const reqIdToPoolKey = new Map<number, string>();
let listenersAttachedTo: IBApi | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let resubscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
let resubscribeRetryAttempt = 0;

/** Live subscribers right now — for the health/observability endpoint. */
export function marketDataPoolSnapshot(): { contractCount: number; subscriberCount: number } {
  let subscriberCount = 0;
  for (const entry of entriesByPoolKey.values()) subscriberCount += entry.subscribers.size;
  return { contractCount: entriesByPoolKey.size, subscriberCount };
}

export async function subscribeToPooledQuote(contract: PriceContract, onUpdate: (quote: PooledQuote) => void): Promise<() => void> {
  const poolKey = poolKeyFor(contract);
  if (!entriesByPoolKey.has(poolKey)) {
    const newEntry: PoolEntry = { contract, reqId: -1, quote: emptyPooledQuote, subscribers: new Set() };
    entriesByPoolKey.set(poolKey, newEntry);
    if (contract.legType === "stock") {
      // Fast first paint while the live subscription is still being
      // established — same source/reasoning as fetchLivePrices.ts's gap-fill.
      loadFallbackStockPrices([contract.symbol])
        .then((fallback) => {
          if (entriesByPoolKey.get(poolKey) !== newEntry || newEntry.reqId !== -1 || newEntry.quote.last !== null) return;
          const price = fallback.get(contract.symbol)?.price ?? null;
          if (price === null) return;
          newEntry.quote = { ...newEntry.quote, last: price };
          for (const subscriber of newEntry.subscribers) subscriber(newEntry.quote);
        })
        .catch(() => {});
    }
  }
  const entry = entriesByPoolKey.get(poolKey)!;
  entry.subscribers.add(onUpdate);
  onUpdate(entry.quote);

  ensureRenewTimerRunning();
  scheduleReservationReconcile();
  void resubscribeInvalidatedEntries();

  return () => {
    const current = entriesByPoolKey.get(poolKey);
    if (current !== entry) return;
    entry.subscribers.delete(onUpdate);
    if (entry.subscribers.size > 0) return;
    entriesByPoolKey.delete(poolKey);
    if (entry.reqId !== -1) {
      reqIdToPoolKey.delete(entry.reqId);
      listenersAttachedTo?.cancelMktData(entry.reqId);
    }
    scheduleReservationReconcile();
  };
}

function ensureRenewTimerRunning(): void {
  if (renewTimer !== null) return;
  renewTimer = setInterval(() => scheduleReservationReconcile(), reservationRenewIntervalMs);
  renewTimer.unref?.();
}

// Subscribe/unsubscribe can fire in bursts and the periodic renew timer can
// land in the same window — reserving a bare "current count" per call,
// unserialized, let two in-flight writes for the same holder complete out
// of order and leave a stale count (found live-testing 2026-09-23 on the
// predecessor pools). One write in flight at a time, always reading
// entriesByPoolKey.size at the moment it actually runs rather than when it
// was scheduled — same debounce-and-serialize shape as priceService.ts's
// recordStockPrices, built for the identical race on a different table.
let reservationReconcileInFlight = false;
let reservationReconcileAgainNeeded = false;

function scheduleReservationReconcile(): void {
  if (reservationReconcileInFlight) {
    reservationReconcileAgainNeeded = true;
    return;
  }
  reservationReconcileInFlight = true;
  void reconcileReservation();
}

async function reconcileReservation(): Promise<void> {
  try {
    const count = entriesByPoolKey.size;
    if (count === 0) await releaseMarketDataLines(reservationHolder);
    else await reserveMarketDataLines(reservationHolder, count, reservationTtlSeconds);
  } catch (error) {
    console.warn(`marketDataPool: reservation reconcile failed — ${error instanceof Error ? error.message : error}`);
  } finally {
    reservationReconcileInFlight = false;
    if (reservationReconcileAgainNeeded) {
      reservationReconcileAgainNeeded = false;
      scheduleReservationReconcile();
    }
  }
}

function attachListeners(ib: IBApi): void {
  if (listenersAttachedTo === ib) return;
  listenersAttachedTo = ib;

  function updateEntry(poolKey: string, reqId: number, patch: Partial<PooledQuote>): void {
    const entry = entriesByPoolKey.get(poolKey);
    if (!entry || entry.reqId !== reqId) return;
    const next: PooledQuote = { ...entry.quote, ...patch };
    if (quoteEqual(entry.quote, next)) return;
    entry.quote = next;
    for (const subscriber of entry.subscribers) subscriber(next);
  }

  ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
    const poolKey = reqIdToPoolKey.get(reqId);
    if (!poolKey) return;
    // IBKR sends -1 as an explicit "no data for this field right now" —
    // normalized to null, not silently dropped, so a field that genuinely
    // stops being quoted goes back to "no data" (see fetchOptionChain.ts's
    // matching comment on the incident this fixes).
    const value = price > 0 ? price : null;
    if (lastTickTypes.includes(tickType)) updateEntry(poolKey, reqId, { last: value });
    else if (bidTickTypes.includes(tickType)) updateEntry(poolKey, reqId, { bid: value });
    else if (askTickTypes.includes(tickType)) updateEntry(poolKey, reqId, { ask: value });
  });
  ib.on(
    EventName.tickOptionComputation,
    (
      reqId: number,
      tickType: number,
      _tickAttrib: number | undefined,
      impliedVol?: number,
      delta?: number,
      _optPrice?: number,
      _pvDividend?: number,
      gamma?: number,
      vega?: number,
      theta?: number,
      underlyingPrice?: number,
    ) => {
      if (!greeksTickTypes.includes(tickType)) return;
      const poolKey = reqIdToPoolKey.get(reqId);
      if (!poolKey) return;
      const entry = entriesByPoolKey.get(poolKey);
      if (!entry || entry.reqId !== reqId) return;
      // Merge, don't replace — a field IBKR didn't include on this
      // particular tick keeps its last known value rather than reverting to
      // null (see fetchLiveGreeks.ts's matching comment).
      updateEntry(poolKey, reqId, {
        delta: delta ?? entry.quote.delta,
        gamma: gamma ?? entry.quote.gamma,
        vega: vega ?? entry.quote.vega,
        theta: theta ?? entry.quote.theta,
        impliedVolatility: impliedVol ?? entry.quote.impliedVolatility ?? null,
        underlyingPrice: underlyingPrice ?? entry.quote.underlyingPrice ?? null,
      });
    },
  );
  ib.on(EventName.error, (error: Error, code: number, reqId: number) => {
    if (isDelayedDataFallbackNotice(code)) return;
    const poolKey = reqIdToPoolKey.get(reqId);
    if (!poolKey) return;
    console.error(`marketDataPool: error for ${poolKey} (code ${code}): ${error.message}`);
  });
  ib.once(EventName.disconnected, handleUnderlyingDisconnect);
}

function handleUnderlyingDisconnect(): void {
  // Every subscription on the dropped connection is gone with it. Entries
  // and their subscribers stay registered — only the IBKR-side reqId is
  // invalidated — so resubscribeInvalidatedEntries() transparently restores
  // them once sharedLiveConnection reconnects, with no caller ever knowing.
  for (const entry of entriesByPoolKey.values()) entry.reqId = -1;
  reqIdToPoolKey.clear();
  listenersAttachedTo = null;
  scheduleResubscribeRetry();
}

function scheduleResubscribeRetry(): void {
  if (resubscribeRetryTimer !== null || entriesByPoolKey.size === 0) return;
  const delay = resubscribeRetryDelaysMs[Math.min(resubscribeRetryAttempt, resubscribeRetryDelaysMs.length - 1)]!;
  resubscribeRetryTimer = setTimeout(() => {
    resubscribeRetryTimer = null;
    void resubscribeInvalidatedEntries();
  }, delay);
  resubscribeRetryTimer.unref?.();
}

async function resubscribeInvalidatedEntries(): Promise<void> {
  const hasInvalidated = [...entriesByPoolKey.values()].some((entry) => entry.reqId === -1);
  if (!hasInvalidated) return;
  let borrowed: Awaited<ReturnType<typeof sharedLiveConnection.borrow>>;
  try {
    borrowed = await sharedLiveConnection.borrow();
  } catch {
    resubscribeRetryAttempt += 1;
    scheduleResubscribeRetry();
    return;
  }
  resubscribeRetryAttempt = 0;
  attachListeners(borrowed.ib);
  for (const [poolKey, entry] of entriesByPoolKey) {
    if (entry.reqId !== -1) continue;
    entry.reqId = sharedLiveConnection.allocateReqId();
    reqIdToPoolKey.set(entry.reqId, poolKey);
    // Empty generic tick list: IBKR sends bid/ask/last AND the computed
    // greeks (for an option contract) on a plain subscription — no special
    // tick request needed for anything this pool tracks. Open interest
    // (tick 27/28, generic tick 101) is deliberately not requested here —
    // nothing live needs it; only the nightly capture job does, and it
    // stays on its own separate, bounded, already-budgeted subscription.
    borrowed.ib.reqMktData(entry.reqId, buildIbkrContract(entry.contract), "", false, false);
  }
}
