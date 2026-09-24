import { EventName, Option, Stock, type Contract, type IBApi } from "@stoqey/ib";
import { sharedLiveConnection } from "./sharedReadConnection.js";
import { reserveMarketDataLines, releaseMarketDataLines } from "./marketDataLineBudget.js";
import { planPoolCapacity, type PoolCapacityEntry } from "./marketDataPoolCapacity.js";
import { loadFallbackStockPrices } from "../lib/priceService.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import type { PriceContract } from "./fetchLivePrices.js";

// The ONE place in the app that ever calls IBKR's reqMktData for a live
// (non-order-execution, non-nightly-capture, non-Day-Signals) subscription.
// One real line per distinct contract (stock or option), fanned out to every
// subscriber across every screen — approved 2026-09-24, replacing the
// earlier design of two separate pools (pricePool.ts/greeksPool.ts), which
// still cost 2 lines for the same option contract whenever both a price
// consumer (Pulse's P&L) and a greeks consumer (Pulse's greeks) watched it,
// since IBKR already sends bid/ask/last AND the computed greeks on a single
// plain reqMktData subscription (empty generic tick list).
//
// Every option contract subscription requests the same full field set
// (last/bid/ask/delta/gamma/vega/theta/IV/underlying) regardless of what the
// FIRST subscriber actually needed — this is what makes a later subscriber
// wanting different fields (e.g. Ticker Detail joining a contract Pulse
// already warmed for price-only) work correctly without a second
// subscription: nothing here is decided per-consumer, only per-contract.
//
// Budget (approved 2026-09-24, "Fit" variant): lines are RESERVED against
// the shared budget (marketDataLineBudget.ts) before any subscription is
// issued — until then the pool only warned on a failed reservation and kept
// subscribing, so it could silently exceed the budget. When the budget hands
// the pool fewer lines than it has contracts (the 10:00 ET chain capture
// holding its 50-line priority reservation), the pool SHEDS to fit: paused
// subscriptions keep their subscribers and last values, stop ticking, and
// resume by themselves once lines free up (planPoolCapacity decides which).
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
// Also how quickly a capture-window restriction is noticed and shed for, and
// how quickly paused contracts resume afterwards.
const reconcileIntervalMs = 15_000;
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
  /** -1 while unsubscribed from IBKR (never subscribed yet, paused for budget, or the underlying connection dropped). */
  reqId: number;
  quote: PooledQuote;
  subscribers: Set<(quote: PooledQuote) => void>;
  /** Monotonic creation order — what "newest first" shedding is decided on. */
  sequence: number;
  /** Shed to fit the budget; not subscribed until a reconcile resumes it. */
  paused: boolean;
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
let nextSequence = 1;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let resubscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
let resubscribeRetryAttempt = 0;
let restricted = false;

/** Live subscribers right now — for the health/observability endpoint. */
export function marketDataPoolSnapshot(): { contractCount: number; subscriberCount: number; pausedCount: number; restricted: boolean } {
  let subscriberCount = 0;
  let pausedCount = 0;
  for (const entry of entriesByPoolKey.values()) {
    subscriberCount += entry.subscribers.size;
    if (entry.paused) pausedCount += 1;
  }
  return { contractCount: entriesByPoolKey.size, subscriberCount, pausedCount, restricted };
}

export async function subscribeToPooledQuote(contract: PriceContract, onUpdate: (quote: PooledQuote) => void): Promise<() => void> {
  const poolKey = poolKeyFor(contract);
  if (!entriesByPoolKey.has(poolKey)) {
    const newEntry: PoolEntry = { contract, reqId: -1, quote: emptyPooledQuote, subscribers: new Set(), sequence: nextSequence++, paused: false };
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

  ensureReconcileTimerRunning();
  scheduleReconcile();

  return () => {
    const current = entriesByPoolKey.get(poolKey);
    if (current !== entry) return;
    entry.subscribers.delete(onUpdate);
    if (entry.subscribers.size > 0) return;
    entriesByPoolKey.delete(poolKey);
    cancelIbkrSubscription(entry);
    scheduleReconcile();
  };
}

function cancelIbkrSubscription(entry: PoolEntry): void {
  if (entry.reqId === -1) return;
  reqIdToPoolKey.delete(entry.reqId);
  listenersAttachedTo?.cancelMktData(entry.reqId);
  entry.reqId = -1;
}

function ensureReconcileTimerRunning(): void {
  if (reconcileTimer !== null) return;
  reconcileTimer = setInterval(() => scheduleReconcile(), reconcileIntervalMs);
  reconcileTimer.unref?.();
}

// Subscribe/unsubscribe can fire in bursts and the periodic timer can land
// in the same window — reserving a bare "current count" per call,
// unserialized, let two in-flight writes for the same holder complete out
// of order and leave a stale count (found live-testing 2026-09-23 on the
// predecessor pools). One reconcile in flight at a time, always reading the
// entries at the moment it actually runs rather than when it was scheduled.
let reconcileInFlight = false;
let reconcileAgainNeeded = false;

function scheduleReconcile(): void {
  if (reconcileInFlight) {
    reconcileAgainNeeded = true;
    return;
  }
  reconcileInFlight = true;
  void reconcile();
}

/** Reserve → shed/resume to what the budget allows → subscribe whatever is active and unsubscribed. */
async function reconcile(): Promise<void> {
  try {
    const desired = entriesByPoolKey.size;
    if (desired === 0) {
      await releaseMarketDataLines(reservationHolder);
      setRestricted(false);
      return;
    }
    let allowed = desired;
    const result = await reserveMarketDataLines(reservationHolder, desired, reservationTtlSeconds);
    if (!result.ok) {
      allowed = result.availableLines;
      // Hold exactly what fits so the budget reflects the pool's real footprint.
      if (allowed > 0) await reserveMarketDataLines(reservationHolder, allowed, reservationTtlSeconds);
      else await releaseMarketDataLines(reservationHolder);
    }
    applyCapacityPlan(allowed);
    setRestricted(allowed < desired);
  } catch (error) {
    console.warn(`marketDataPool: reservation reconcile failed — ${error instanceof Error ? error.message : error}`);
  } finally {
    reconcileInFlight = false;
    if (reconcileAgainNeeded) {
      reconcileAgainNeeded = false;
      scheduleReconcile();
    }
  }
  await subscribeUnsubscribedEntries();
}

function applyCapacityPlan(allowedLines: number): void {
  const capacityEntries: PoolCapacityEntry[] = [...entriesByPoolKey.entries()].map(([poolKey, entry]) => ({ poolKey, legType: entry.contract.legType, sequence: entry.sequence, paused: entry.paused }));
  const plan = planPoolCapacity(capacityEntries, allowedLines);
  for (const poolKey of plan.pauseKeys) {
    const entry = entriesByPoolKey.get(poolKey);
    if (!entry) continue;
    entry.paused = true;
    cancelIbkrSubscription(entry);
  }
  for (const poolKey of plan.resumeKeys) {
    const entry = entriesByPoolKey.get(poolKey);
    if (entry) entry.paused = false;
  }
  if (plan.pauseKeys.length > 0 || plan.resumeKeys.length > 0) {
    console.log(`marketDataPool: budget allows ${allowedLines} of ${entriesByPoolKey.size} contracts — paused ${plan.pauseKeys.length}, resumed ${plan.resumeKeys.length}.`);
  }
}

function setRestricted(value: boolean): void {
  if (restricted === value) return;
  restricted = value;
  console.log(value ? "marketDataPool: restricted — fewer budget lines than pooled contracts (chain capture running?)." : "marketDataPool: restriction lifted — every pooled contract fits the budget again.");
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
  // invalidated — so subscribeUnsubscribedEntries() transparently restores
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
    void subscribeUnsubscribedEntries();
  }, delay);
  resubscribeRetryTimer.unref?.();
}

async function subscribeUnsubscribedEntries(): Promise<void> {
  const hasUnsubscribed = [...entriesByPoolKey.values()].some((entry) => entry.reqId === -1 && !entry.paused);
  if (!hasUnsubscribed) return;
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
    if (entry.reqId !== -1 || entry.paused) continue;
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
