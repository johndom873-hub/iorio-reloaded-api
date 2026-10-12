import { EventName, Option, OptionType } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import { countSentMessages, createLineUsageMeter, percentileOfSorted, type LineUsageSummary } from "./lineUsageMeter.js";

export { percentileOfSorted };

// Quote collector for the nightly option-chain archive (IORIO Signal Engine,
// Phase 0). Captures what a plain live quote ignores — bid/ask sizes, open
// interest, volume, the option's model price and the underlying price the
// model used — all needed for the archive.
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

/**
 * Default: a price (two-sided or last), a model delta and an open-interest reading, or an error that means no data is coming.
 * IBKR's explicit "no data" (-1 or 0) on the bid or ask also settles the price: no two-sided quote is coming, so the line
 * stops waiting for one and only waits for delta and open interest (approved 2026-10-08).
 */
export function isOptionQuoteSettledByDefault(quote: CapturedOptionQuote, noMarketOnASide = false): boolean {
  if (quote.errorCode !== null) return true;
  const hasPrice = (quote.bid !== null && quote.ask !== null) || quote.last !== null || noMarketOnASide;
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

// --- Rolling window (approved 2026-09-24) ------------------------------------
//
// The nightly capture used fixed batches of optionChainCaptureBatchSize
// contracts: subscribe all, wait until every one settled or the ceiling
// hit, cancel, next batch. A contract settled in one second held its line
// idle until the batch's slowest contract or the 8 s ceiling — 1,118 s for
// 3,217 contracts on 2026-09-23. This window keeps `concurrency` lines in
// flight across ticker boundaries and hands each freed line to the next
// queued contract the moment one settles (the Day Signals loop's
// daySignalsQuoteWindow.ts shape, with this file's fuller tick capture and
// settle rule), so throughput is lines ÷ the average settle time rather than
// lines ÷ the ceiling. Each contract still has its own timeout (the old
// ceiling) as its safety net.

export interface CaptureQuoteWindowOptions {
  /** Lines kept in flight — the caller's line reservation must cover this many. */
  concurrency: number;
  /**
   * Per-contract safety net, counted from IBKR's first tick for the contract (approved 2026-10-08), so time spent in our
   * own outgoing message queue does not eat into it; a contract IBKR never answers is released this long after its request.
   */
  timeoutMs?: number;
  /** `noMarketOnASide`: IBKR answered "no data" (-1 or 0) on the bid or ask. */
  isSettled?: (quote: CapturedOptionQuote, noMarketOnASide: boolean) => boolean;
  /**
   * Early release and one retry (approved 2026-10-12, chain capture only): this long after IBKR's first tick, a contract
   * that has its price but still lacks open interest and/or delta gives its line back and is queued once more, right after
   * its ticker's remaining contracts. IBKR drops those fields per subscription, not per contract, and a second
   * subscription almost always gets them. The retry's values are what is kept (open interest from either attempt).
   * Omitted: no early release, every contract waits for `timeoutMs`.
   */
  retryIncompleteAfterMs?: number;
}

export interface CaptureQuoteWindow {
  /**
   * Queues one ticker's contracts and resolves with their final quotes once
   * every one of them has settled. Other tickers' contracts may be queued and
   * in flight at the same time; the order of settlement across tickers is
   * whatever IBKR's ticks make it.
   */
  capture(symbol: string, contracts: OptionContractRequest[]): Promise<CapturedOptionQuote[]>;
  /** Cancels anything still in flight, resolves every open capture with what it has, and detaches the listeners. */
  close(): void;
  /** Lines this window keeps in flight. */
  concurrency: number;
  /** Contracts subscribed right now — for logs and tests. */
  inFlightCount(): number;
  /** Contracts queued for a line right now; a free line only ever means this is 0. */
  queuedCount(): number;
  /** The window's first reqMktData and its latest release (ms since epoch), for the reservation timeline. */
  subscribedSpan(): { firstSubscribedAt: number | null; lastReleasedAt: number | null };
  /** How contracts used their lines since the previous call (then resets) — for the periodic progress log. */
  drainSettleStats(): CaptureSettleStats;
  /** The same, since the window opened — for the end-of-run summary. */
  wholeRunSettleStats(): CaptureSettleStats;
}

type SettleField = "price" | "delta" | "openInterest";
type ReleaseOutcome = "settled" | "timedOut" | "releasedEarly";

export interface CaptureSettleStats {
  /** Length of the period these stats cover (since the previous drain). */
  intervalMs: number;
  /** Lines subscribed, lowest and highest seen during the period (sampled on every subscribe and release). */
  minInFlight: number | null;
  maxInFlight: number | null;
  /** Line-time held by contracts released during the period; ÷ intervalMs = average lines in use. */
  lineBusyMs: number;
  /** The part of lineBusyMs held by contracts that timed out without the full field set. */
  timedOutLineMs: number;
  /** Settled with the full field set (price, delta, open interest). */
  settled: number;
  /** Held the line for the whole timeout without the full field set. */
  timedOut: number;
  /** Of those, IBKR never sent a single tick (released by the no-reply clock); the rest were answered but incomplete. */
  timedOutUnanswered: number;
  errored: number;
  /** Still subscribed when close() ran (the re-capture deadline, a dropped connection): released without settling. */
  cancelledAtClose: number;
  /** Released `retryIncompleteAfterMs` after IBKR's first tick with a price but no open interest and/or delta (first attempts and retries). */
  releasedEarly: number;
  /** The fields those early releases were missing. */
  missingOnEarlyRelease: Record<SettleField, number>;
  /** The part of lineBusyMs held by early-released subscriptions. */
  releasedEarlyLineMs: number;
  /** Retry subscriptions released in the period, how many of them got the full field set, and the line time they held. */
  retries: number;
  retriesRecovered: number;
  retryLineMs: number;
  /** How long each released contract held its line, subscribe to release (every outcome). */
  holdMsP50: number | null;
  holdMsP90: number | null;
  holdMsMax: number | null;
  /** On full-set contracts, the field that arrived last (what the line was waiting for). */
  lastField: Record<SettleField, number>;
  /** On timed-out contracts IBKR did answer, the fields that never arrived. */
  missingOnTimeout: Record<SettleField, number>;
  /** Full-data contracts settled with no two-sided quote or last because IBKR answered "no data" on a side. */
  settledWithoutMarket: number;
  /** Each settle field's arrival after IBKR's first tick for the contract (IBKR's own delay, without our queue wait). */
  afterFirstReplyMs: Record<SettleField, { p50: number | null; p90: number | null }>;
  /** Time-weighted subscribed vs answered lines, message rate and the wait for IBKR's first tick (lineUsageMeter.ts). */
  lineUsage: LineUsageSummary;
  /** Messages the library really wrote to the Gateway socket per second (after its rate limiter); null when it cannot be counted. */
  messagesSentPerSecond: number | null;
  /** Our reqMktData/cancelMktData calls not yet written to the socket at the end of the period: the limiter's queue; null when it cannot be counted. */
  messagesWaitingToSend: number | null;
}

interface WindowGroup {
  symbol: string;
  remaining: number;
  quotes: CapturedOptionQuote[];
  resolve: (quotes: CapturedOptionQuote[]) => void;
}

interface WindowQueued {
  contract: OptionContractRequest;
  group: WindowGroup;
  /** Set on a retry: the first attempt's quote, the one the group returns, which the retry's values are merged into. */
  retryOf?: CapturedOptionQuote;
}

interface WindowPending {
  quote: CapturedOptionQuote;
  group: WindowGroup;
  retryOf?: CapturedOptionQuote;
  timer: ReturnType<typeof setTimeout>;
  /** The early-release check, `retryIncompleteAfterMs` after the first tick. */
  earlyReleaseTimer: ReturnType<typeof setTimeout> | null;
  subscribedAt: number;
  /** IBKR's first tick of any kind for the contract (ms since epoch), for drainSettleStats. */
  firstTickAt: number | null;
  /** IBKR answered "no data" (-1 or 0) on the bid or ask. */
  noMarketOnASide: boolean;
  /** When each settle field first arrived (ms since epoch), for drainSettleStats. */
  arrivedAt: Record<SettleField, number | null>;
}

function emptyCapturedQuote(contract: OptionContractRequest): CapturedOptionQuote {
  return {
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
  };
}

export function openCaptureQuoteWindow(ib: IBApi, options: CaptureQuoteWindowOptions): CaptureQuoteWindow {
  const timeoutMs = options.timeoutMs ?? defaultBatchCeilingMs;
  const isSettled = options.isSettled ?? isOptionQuoteSettledByDefault;
  const queue: WindowQueued[] = [];
  const pending = new Map<number, WindowPending>();
  let closed = false;
  const emptyFieldCounts = (): Record<SettleField, number> => ({ price: 0, delta: 0, openInterest: 0 });
  const meter = createLineUsageMeter();
  // The window's connection carries only its own reqMktData/cancelMktData once open, so calls minus sends is the limiter's queue.
  const sentCounter = countSentMessages(ib);
  let messagesCalled = 0;
  const freshStats = () => ({
    periodStartedAt: Date.now(),
    sentAtPeriodStart: sentCounter?.sentCount() ?? 0,
    holdsMs: [] as number[],
    minInFlight: null as number | null,
    maxInFlight: null as number | null,
    timedOutLineMs: 0,
    settled: 0,
    timedOut: 0,
    timedOutUnanswered: 0,
    errored: 0,
    cancelledAtClose: 0,
    releasedEarly: 0,
    missingOnEarlyRelease: emptyFieldCounts(),
    releasedEarlyLineMs: 0,
    retries: 0,
    retriesRecovered: 0,
    retryLineMs: 0,
    settledWithoutMarket: 0,
    lastField: emptyFieldCounts(),
    missingOnTimeout: emptyFieldCounts(),
    afterFirstReplyMs: { price: [] as number[], delta: [] as number[], openInterest: [] as number[] },
  });
  let intervalStats = freshStats();
  const wholeRunStats = freshStats();
  let firstSubscribedAt: number | null = null;
  let lastReleasedAt: number | null = null;
  // Opens with no line in use, so the first period's low reflects the wait before the first subscribe.
  for (const stats of [intervalStats, wholeRunStats]) stats.minInFlight = stats.maxInFlight = 0;

  function sampleInFlight(): void {
    const count = pending.size;
    for (const stats of [intervalStats, wholeRunStats]) {
      stats.minInFlight = stats.minInFlight === null ? count : Math.min(stats.minInFlight, count);
      stats.maxInFlight = stats.maxInFlight === null ? count : Math.max(stats.maxInFlight, count);
    }
  }

  function summarize(stats: ReturnType<typeof freshStats>, lineUsage: LineUsageSummary): CaptureSettleStats {
    const sortedHolds = [...stats.holdsMs].sort((a, b) => a - b);
    const intervalMs = Date.now() - stats.periodStartedAt;
    const sentNow = sentCounter?.sentCount() ?? null;
    const percentiles = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p50: percentileOfSorted(sorted, 50), p90: percentileOfSorted(sorted, 90) };
    };
    return {
      intervalMs,
      minInFlight: stats.minInFlight,
      maxInFlight: stats.maxInFlight,
      lineBusyMs: sortedHolds.reduce((sum, holdMs) => sum + holdMs, 0),
      timedOutLineMs: stats.timedOutLineMs,
      settled: stats.settled,
      timedOut: stats.timedOut,
      timedOutUnanswered: stats.timedOutUnanswered,
      errored: stats.errored,
      cancelledAtClose: stats.cancelledAtClose,
      releasedEarly: stats.releasedEarly,
      missingOnEarlyRelease: { ...stats.missingOnEarlyRelease },
      releasedEarlyLineMs: stats.releasedEarlyLineMs,
      retries: stats.retries,
      retriesRecovered: stats.retriesRecovered,
      retryLineMs: stats.retryLineMs,
      settledWithoutMarket: stats.settledWithoutMarket,
      holdMsP50: percentileOfSorted(sortedHolds, 50),
      holdMsP90: percentileOfSorted(sortedHolds, 90),
      holdMsMax: sortedHolds.at(-1) ?? null,
      lastField: { ...stats.lastField },
      missingOnTimeout: { ...stats.missingOnTimeout },
      afterFirstReplyMs: { price: percentiles(stats.afterFirstReplyMs.price), delta: percentiles(stats.afterFirstReplyMs.delta), openInterest: percentiles(stats.afterFirstReplyMs.openInterest) },
      lineUsage,
      messagesSentPerSecond: sentNow === null ? null : intervalMs > 0 ? ((sentNow - stats.sentAtPeriodStart) * 1000) / intervalMs : 0,
      messagesWaitingToSend: sentNow === null ? null : Math.max(0, messagesCalled - sentNow),
    };
  }

  function noteArrivals(entry: WindowPending): void {
    const now = Date.now();
    const { quote, arrivedAt } = entry;
    if (arrivedAt.price === null && ((quote.bid !== null && quote.ask !== null) || quote.last !== null)) arrivedAt.price = now;
    if (arrivedAt.delta === null && quote.delta !== null) arrivedAt.delta = now;
    if (arrivedAt.openInterest === null && quote.openInterest !== null) arrivedAt.openInterest = now;
  }

  function recordSettle(entry: WindowPending, outcome: ReleaseOutcome): void {
    const holdMs = Date.now() - entry.subscribedAt;
    const fields = Object.entries(entry.arrivedAt) as [SettleField, number | null][];
    const [lastField] = fields.reduce((latest, current) => ((current[1] ?? 0) > (latest[1] ?? 0) ? current : latest));
    for (const stats of [intervalStats, wholeRunStats]) {
      stats.holdsMs.push(holdMs);
      if (entry.retryOf) {
        stats.retries += 1;
        stats.retryLineMs += holdMs;
        if (outcome === "settled" && entry.quote.errorCode === null) stats.retriesRecovered += 1;
      }
      if (entry.firstTickAt !== null) for (const [field, at] of fields) if (at !== null) stats.afterFirstReplyMs[field].push(at - entry.firstTickAt);
      if (entry.quote.errorCode !== null) stats.errored += 1;
      else if (outcome === "releasedEarly") {
        stats.releasedEarly += 1;
        stats.releasedEarlyLineMs += holdMs;
        for (const [field, at] of fields) if (at === null) stats.missingOnEarlyRelease[field] += 1;
      } else if (outcome === "timedOut") {
        stats.timedOut += 1;
        stats.timedOutLineMs += holdMs;
        if (entry.firstTickAt === null) stats.timedOutUnanswered += 1;
        else for (const [field, at] of fields) if (at === null) stats.missingOnTimeout[field] += 1;
      } else {
        stats.settled += 1;
        stats.lastField[lastField] += 1;
        if (entry.quote.last === null && (entry.quote.bid === null || entry.quote.ask === null)) stats.settledWithoutMarket += 1;
      }
    }
  }

  function recordCancelAtClose(entry: WindowPending): void {
    const holdMs = Date.now() - entry.subscribedAt;
    for (const stats of [intervalStats, wholeRunStats]) {
      stats.holdsMs.push(holdMs);
      stats.cancelledAtClose += 1;
    }
  }

  // The first tick restarts the timeout: until then the contract was on the no-reply clock started at its request.
  function noteFirstTick(reqId: number, entry: WindowPending): void {
    if (entry.firstTickAt !== null) return;
    entry.firstTickAt = Date.now();
    meter.answered(reqId);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => settle(reqId, "timedOut"), timeoutMs);
    if (options.retryIncompleteAfterMs !== undefined) entry.earlyReleaseTimer = setTimeout(() => releaseIfIncomplete(reqId), options.retryIncompleteAfterMs);
  }

  // Price in, open interest and/or delta missing: give the line back. A first attempt goes back in the queue once,
  // right after its ticker's remaining contracts; a retry ends here with what it has. Without a price, the normal
  // timeout still applies.
  function releaseIfIncomplete(reqId: number): void {
    const entry = pending.get(reqId);
    if (!entry) return;
    entry.earlyReleaseTimer = null;
    const { quote } = entry;
    const hasPrice = (quote.bid !== null && quote.ask !== null) || quote.last !== null || entry.noMarketOnASide;
    if (!hasPrice || (quote.delta !== null && quote.openInterest !== null)) return;
    if (entry.retryOf) {
      settle(reqId, "releasedEarly");
      return;
    }
    recordSettle(entry, "releasedEarly");
    releaseLine(reqId, entry);
    let insertAt = 0;
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index]!.group === entry.group) {
        insertAt = index + 1;
        break;
      }
    }
    queue.splice(insertAt, 0, { contract: { expiry: quote.expiry, strike: quote.strike, right: quote.right }, group: entry.group, retryOf: quote });
    sampleInFlight();
    pump();
  }

  // The retry's price, sizes and greeks replace the first attempt's together (fresher, and consistent with each other);
  // open interest is a once-a-day figure, so either attempt's will do. A retry IBKR never answered leaves the first attempt as it was.
  function mergeRetry(original: CapturedOptionQuote, retry: CapturedOptionQuote): void {
    if (!retry.receivedAnyTick) return;
    const openInterest = retry.openInterest ?? original.openInterest;
    const { sawRealTimeTicks, sawDelayedTicks } = original;
    Object.assign(original, retry, { openInterest, sawRealTimeTicks: sawRealTimeTicks || retry.sawRealTimeTicks, sawDelayedTicks: sawDelayedTicks || retry.sawDelayedTicks });
  }

  function releaseLine(reqId: number, entry: WindowPending): void {
    clearTimeout(entry.timer);
    if (entry.earlyReleaseTimer !== null) clearTimeout(entry.earlyReleaseTimer);
    pending.delete(reqId);
    meter.released(reqId);
    lastReleasedAt = Date.now();
    messagesCalled += 1;
    try {
      ib.cancelMktData(reqId);
    } catch {
      // the connection may already be gone
    }
  }

  function markTick(quote: CapturedOptionQuote, tickType: number): void {
    quote.receivedAnyTick = true;
    if (realTimeTickTypes.has(tickType)) quote.sawRealTimeTicks = true;
    if (delayedTickTypes.has(tickType)) quote.sawDelayedTicks = true;
  }

  function settle(reqId: number, outcome: ReleaseOutcome = "settled"): void {
    const entry = pending.get(reqId);
    if (!entry) return;
    recordSettle(entry, outcome);
    releaseLine(reqId, entry);
    if (entry.retryOf) mergeRetry(entry.retryOf, entry.quote);
    entry.group.remaining -= 1;
    if (entry.group.remaining === 0) entry.group.resolve(entry.group.quotes);
    sampleInFlight();
    pump();
  }

  function checkSettled(reqId: number): void {
    const entry = pending.get(reqId);
    if (!entry) return;
    noteArrivals(entry);
    if (isSettled(entry.quote, entry.noMarketOnASide)) settle(reqId, "settled");
  }

  function pump(): void {
    if (closed) return;
    if (queue.length === 0) return;
    pumpContracts();
    sampleInFlight();
  }

  function pumpContracts(): void {
    while (pending.size < options.concurrency && queue.length > 0) {
      const { contract, group, retryOf } = queue.shift()!;
      const reqId = nextReqIdFor(ib, () => nextFallbackReqId++);
      const quote = emptyCapturedQuote(contract);
      // A retry's quote stays private until it is merged into the first attempt's, which the group already holds.
      if (!retryOf) group.quotes.push(quote);
      pending.set(reqId, { quote, group, retryOf, timer: setTimeout(() => settle(reqId, "timedOut"), timeoutMs), earlyReleaseTimer: null, subscribedAt: Date.now(), firstTickAt: null, noMarketOnASide: false, arrivedAt: { price: null, delta: null, openInterest: null } });
      meter.subscribed(reqId);
      firstSubscribedAt ??= Date.now();
      messagesCalled += 1;
      const right = contract.right === "C" ? OptionType.Call : OptionType.Put;
      try {
        ib.reqMktData(reqId, new Option(group.symbol, contract.expiry, contract.strike, right, "SMART"), openInterestGenericTickList, false, false);
      } catch (error) {
        console.warn(`Option capture could not subscribe ${group.symbol} ${contract.expiry} ${contract.strike}${contract.right}: ${error instanceof Error ? error.message : error}`);
        quote.errorCode = -1;
        settle(reqId, "settled");
      }
    }
  }

  function onTickPrice(reqId: number, tickType: number, price: number): void {
    const entry = pending.get(reqId);
    if (!entry) return;
    noteFirstTick(reqId, entry);
    markTick(entry.quote, tickType);
    if (bidPriceTicks.has(tickType)) entry.quote.bid = normalizePrice(price);
    if (askPriceTicks.has(tickType)) entry.quote.ask = normalizePrice(price);
    if ((bidPriceTicks.has(tickType) || askPriceTicks.has(tickType)) && !(price > 0)) entry.noMarketOnASide = true;
    if (lastPriceTicks.has(tickType)) entry.quote.last = normalizePrice(price);
    checkSettled(reqId);
  }

  function onTickSize(reqId: number, tickType: number | undefined, size: number | undefined): void {
    const entry = pending.get(reqId);
    if (!entry || tickType === undefined) return;
    const { quote } = entry;
    noteFirstTick(reqId, entry);
    markTick(quote, tickType);
    if (bidSizeTicks.has(tickType)) quote.bidSize = normalizeSize(size);
    if (askSizeTicks.has(tickType)) quote.askSize = normalizeSize(size);
    if (volumeTicks.has(tickType)) quote.volume = normalizeSize(size);
    if (tickType === callOpenInterestTick && quote.right === "C") quote.openInterest = normalizeSize(size);
    if (tickType === putOpenInterestTick && quote.right === "P") quote.openInterest = normalizeSize(size);
    checkSettled(reqId);
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
    const entry = pending.get(reqId);
    if (!entry) return;
    const { quote } = entry;
    noteFirstTick(reqId, entry);
    markTick(quote, tickType);
    if (modelComputationTicks.has(tickType)) {
      quote.impliedVolatility = normalizeImpliedVolatility(impliedVolatility);
      quote.delta = normalizeDelta(delta);
      quote.gamma = normalizeNonNegativeGreek(gamma);
      quote.vega = normalizeNonNegativeGreek(vega);
      quote.theta = normalizeTheta(theta);
      quote.modelOptionPrice = normalizeModelPrice(optionPrice);
      quote.underlyingPrice = normalizePrice(underlyingPrice);
    }
    checkSettled(reqId);
  }

  function onError(error: Error, code: number, reqId: number): void {
    const entry = pending.get(reqId);
    if (!entry || isDelayedDataFallbackNotice(code)) return;
    entry.quote.errorCode = code;
    console.warn(`Option capture error for ${entry.group.symbol} ${entry.quote.expiry} ${entry.quote.strike}${entry.quote.right} (code ${code}): ${error.message}`);
    checkSettled(reqId);
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickSize, onTickSize);
  ib.on(EventName.tickOptionComputation, onTickOptionComputation);
  ib.on(EventName.error, onError);

  return {
    capture(symbol, contracts) {
      if (closed) return Promise.reject(new Error("the capture quote window is closed"));
      if (contracts.length === 0) return Promise.resolve([]);
      return new Promise<CapturedOptionQuote[]>((resolve) => {
        const group: WindowGroup = { symbol, remaining: contracts.length, quotes: [], resolve };
        for (const contract of contracts) queue.push({ contract, group });
        pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      const openGroups = new Set<WindowGroup>();
      for (const [reqId, entry] of pending) {
        clearTimeout(entry.timer);
        if (entry.earlyReleaseTimer !== null) clearTimeout(entry.earlyReleaseTimer);
        recordCancelAtClose(entry);
        meter.released(reqId);
        lastReleasedAt = Date.now();
        messagesCalled += 1;
        try {
          ib.cancelMktData(reqId);
        } catch {
          // the connection may already be gone
        }
        openGroups.add(entry.group);
      }
      pending.clear();
      for (const { group } of queue) openGroups.add(group);
      queue.length = 0;
      for (const group of openGroups) group.resolve(group.quotes);
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.removeListener(EventName.tickSize, onTickSize);
      ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
      ib.removeListener(EventName.error, onError);
      sentCounter?.stop();
    },
    concurrency: options.concurrency,
    inFlightCount: () => pending.size,
    queuedCount: () => queue.length,
    subscribedSpan: () => ({ firstSubscribedAt, lastReleasedAt }),
    drainSettleStats() {
      const drained = summarize(intervalStats, meter.drain());
      intervalStats = freshStats();
      intervalStats.minInFlight = intervalStats.maxInFlight = pending.size;
      return drained;
    },
    wholeRunSettleStats: () => summarize(wholeRunStats, meter.wholeRun()),
  };
}
