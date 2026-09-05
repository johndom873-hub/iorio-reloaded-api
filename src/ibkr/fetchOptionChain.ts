import { EventName, Option, OptionType, SecType } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import { db } from "../db/connection.js";

export interface OptionQuote {
  expiry: string; // YYYYMMDD
  strike: number;
  right: OptionType;
  bid: number | null;
  ask: number | null;
  last: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
}

// 0-60 DTE covers everything from same-week/intra-weekly expiries through
// the covered-call/CSP monthly range. maxExpiries=6 is a hard ceiling, not a
// tuned guess: each expiry uses at most strikesPerSide(4) x 2 sides x 2
// rights = 16 reqMktData lines (the only lines this connection opens — the
// pricing lookup is a snapshot and doesn't count), so 6 expiries is
// guaranteed to stay at or under 96 of IBKR's 100-line-per-connection cap.
// pickExpiries sorts ascending and takes the first N, so the nearest
// (weekly/intra-weekly) expiries are always the ones kept if more than 6
// exist in the window.
const defaultMinDaysToExpiry = 0;
const defaultMaxDaysToExpiry = 60;
const maxExpiries = 6;
const strikesPerSide = 4;
const quoteTimeoutMs = 8_000;

// Exported for reuse by the trade-alert candidate generator, which needs
// its own per-strategy DTE window instead of this file's fixed one.
export function parseExpiry(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00Z`);
}

export function daysBetween(from: Date, to: Date): number {
  const fromMidnightUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toMidnightUtc = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((toMidnightUtc - fromMidnightUtc) / 86_400_000);
}

// Monotonic, not Date.now()-based — two lookups issued within the same
// millisecond (e.g. back-to-back expiries in the loop below) would
// otherwise collide on the same reqId and cross-resolve each other's
// listeners. Starts high to stay clear of the small fixed reqIds
// (contractDetailsReqId=1, pricingReqId=2, etc.) used by sibling callers
// sharing the same connection.
let nextLookupReqId = 5_000;

export async function lookupOptionParams(
  ib: IBApi,
  symbol: string,
  conId: number,
): Promise<{ expirations: string[]; strikes: number[] }> {
  return new Promise((resolve, reject) => {
    const reqId = nextLookupReqId++;
    let lastError: string | null = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(lastError ?? `secDefOptParams timeout for ${symbol}`));
    }, 10_000);
    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.securityDefinitionOptionParameter, onParams);
      ib.removeListener(EventName.error, onError);
    }
    function onParams(
      id: number,
      exchange: string,
      _underlyingConId: number,
      _tradingClass: string,
      _multiplier: string,
      expirations: string[],
      strikes: number[],
    ) {
      if (id !== reqId || exchange !== "SMART") return;
      cleanup();
      resolve({ expirations: Array.from(expirations), strikes: Array.from(strikes) });
    }
    // Captured, not rejected on immediately — IBKR sends routine informational
    // notices through this same event for reqIds that still go on to succeed
    // (same pattern as lookupPricingSnapshot). Only surfaced if the timeout
    // above actually fires, so a real permissions/pacing error explains the
    // timeout instead of the generic message masking it.
    function onError(error: Error, code: number, errorReqId: number) {
      if (errorReqId !== reqId) return;
      lastError = `secDefOptParams error for ${symbol} (code ${code}): ${error.message}`;
    }
    ib.on(EventName.securityDefinitionOptionParameter, onParams);
    ib.on(EventName.error, onError);
    ib.reqSecDefOptParams(reqId, symbol, "", "STK", conId);
  });
}

async function resolveTickerId(symbol: string): Promise<string | null> {
  const row = await db("tickers").where({ symbol }).first();
  return row?.id ?? null;
}

// 24h refresh, approved 2026-08-27 (see PROGRESS.md "Option chain cache") —
// this raw cross-expiry/cross-exchange union barely changes day to day (new
// weekly expiries roll forward periodically, existing ones don't change),
// but was being re-fetched live on every chain open/scan. Fails open (no
// caching, straight to lookupOptionParams) for a symbol with no tickers row.
export async function getCachedOptionParams(
  ib: IBApi,
  symbol: string,
  conId: number,
): Promise<{ expirations: string[]; strikes: number[] }> {
  const tickerId = await resolveTickerId(symbol);
  if (!tickerId) return lookupOptionParams(ib, symbol, conId);

  const optionParamsRefreshMs = 24 * 60 * 60 * 1000;
  const cached = await db("option_chain_params").where({ ticker_id: tickerId }).first();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < optionParamsRefreshMs) {
    return { expirations: cached.expirations, strikes: cached.strikes.map(Number) };
  }

  const fresh = await lookupOptionParams(ib, symbol, conId);
  await db("option_chain_params")
    .insert({ ticker_id: tickerId, expirations: fresh.expirations, strikes: fresh.strikes, fetched_at: new Date() })
    .onConflict("ticker_id")
    .merge();
  return fresh;
}

function pickExpiries(expirations: string[], dteRange: { min: number; max: number }): string[] {
  const today = new Date();
  return expirations
    .filter((expiry) => {
      const dte = daysBetween(today, parseExpiry(expiry));
      return dte >= dteRange.min && dte <= dteRange.max;
    })
    .sort()
    .slice(0, maxExpiries);
}

function pickStrikes(strikes: number[], spotPrice: number, countPerSide: number = strikesPerSide): number[] {
  const sorted = [...strikes].sort((a, b) => a - b);
  const below = sorted.filter((s) => s <= spotPrice).slice(-countPerSide);
  const above = sorted.filter((s) => s > spotPrice).slice(0, countPerSide);
  return [...below, ...above];
}

// Extra raw candidates pulled per side before validation, since some will
// turn out not to exist for the specific expiry being checked (see
// checkStrikeExists) — this buffer keeps the odds high of still landing on
// strikesPerSide real strikes per side after filtering.
const candidateBufferPerSide = 3;
const strikeCheckTimeoutMs = 5_000;

// reqSecDefOptParams's strikes array is a union across every expiry/exchange
// combination, not per-expiry — most of those strike x expiry pairs don't
// actually exist as real contracts for a given expiry. We used to discover
// the real per-expiry set with a wildcard contractDetails lookup (expiry
// set, strike/right unset), but IBKR's own docs say that's the wrong tool:
// "It is not recommended to use reqContractDetails to receive complete
// option chains... the return will be throttled and take longer the more
// ambiguous the contract definition" (this was the actual cause of AMAT's
// 25s prod timeout on 2026-08-14 — not network latency, not connection
// setup, measured at ~0.6-1.4s — see PROGRESS.md). A fully-qualified request
// (strike AND right both specified) isn't ambiguous and isn't throttled, so
// checking one candidate strike at a time in parallel replaces one slow
// throttled scan with many fast, unthrottled ones. Right=Call only — calls
// and puts always share the same listed strike grid.
export function checkStrikeExists(ib: IBApi, symbol: string, expiry: string, strike: number): Promise<boolean> {
  return new Promise((resolve) => {
    const reqId = nextLookupReqId++;
    let found = false;
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, strikeCheckTimeoutMs);

    function onDetails(id: number) {
      if (id !== reqId) return;
      found = true;
    }
    function onEnd(id: number) {
      if (id !== reqId) return;
      cleanup();
      resolve(found);
    }
    function onError(_error: Error, _code: number, id: number) {
      if (id !== reqId) return;
      cleanup();
      resolve(false);
    }
    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.contractDetails, onDetails);
      ib.removeListener(EventName.contractDetailsEnd, onEnd);
      ib.removeListener(EventName.error, onError);
    }

    const qualifiedOptionContract: Contract = {
      symbol,
      secType: SecType.OPT,
      lastTradeDateOrContractMonth: expiry,
      strike,
      right: OptionType.Call,
      exchange: "SMART",
      currency: "USD",
    };

    // .on(), not .once() — with many of these checks in flight concurrently
    // on one shared connection, EventEmitter.once() fires (and self-removes)
    // *every* currently-registered once-listener on the first
    // contractDetailsEnd for *any* reqId, not just the one whose id matches.
    // That orphans every other in-flight check, which then just times out.
    // Manual removeListener() inside onEnd (via cleanup(), gated on the id
    // check) is what actually scopes removal to this one request.
    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqContractDetails(reqId, qualifiedOptionContract);
  });
}

// Cached wrapper around checkStrikeExists, approved 2026-08-27 (see
// PROGRESS.md "Option chain cache") — this is the flagship caching win here:
// it's the exact call chain that caused the 2026-08-14 AMAT throttling
// outage (see checkStrikeExists' own doc comment), and fires dozens of times
// per chain open. Batches the whole candidate set for one expiry into a
// single Postgres read, then only fires IBKR checks for whatever wasn't
// already cached, instead of one DB round trip per candidate.
//
// exists=true is cached forever (a listed contract doesn't get delisted
// mid-life). exists=false gets a 24h re-check window instead, since
// exchanges do occasionally add new strikes to an already-listed expiry
// after a large price move — caching "doesn't exist" forever risks
// permanently hiding a strike that gets added later. Fails open for a
// symbol with no tickers row.
export async function getCachedValidStrikes(ib: IBApi, symbol: string, expiry: string, candidates: number[]): Promise<number[]> {
  if (candidates.length === 0) return [];
  const tickerId = await resolveTickerId(symbol);
  if (!tickerId) {
    const results = await Promise.all(
      candidates.map(async (strike) => ({ strike, exists: await checkStrikeExists(ib, symbol, expiry, strike) })),
    );
    return results.filter((r) => r.exists).map((r) => r.strike);
  }

  const negativeCheckRefreshMs = 24 * 60 * 60 * 1000;
  const cachedRows: { strike: string; exists: boolean; checked_at: Date }[] = await db("option_chain_strike_checks")
    .where({ ticker_id: tickerId, expiry })
    .whereIn("strike", candidates);
  const cachedByStrike = new Map(cachedRows.map((row) => [Number(row.strike), row]));

  const needsLiveCheck = candidates.filter((strike) => {
    const row = cachedByStrike.get(strike);
    if (!row) return true;
    if (row.exists) return false;
    return Date.now() - new Date(row.checked_at).getTime() >= negativeCheckRefreshMs;
  });

  const liveResults = await Promise.all(
    needsLiveCheck.map(async (strike) => ({ strike, exists: await checkStrikeExists(ib, symbol, expiry, strike) })),
  );

  if (liveResults.length > 0) {
    await db("option_chain_strike_checks")
      .insert(liveResults.map(({ strike, exists }) => ({ ticker_id: tickerId, expiry, strike, exists, checked_at: new Date() })))
      .onConflict(["ticker_id", "expiry", "strike"])
      .merge();
  }

  const liveByStrike = new Map(liveResults.map((r) => [r.strike, r.exists]));
  return candidates.filter((strike) => (liveByStrike.has(strike) ? liveByStrike.get(strike) : (cachedByStrike.get(strike)?.exists ?? false)));
}

// mustIncludeStrikes (approved 2026-08-26): a pending trade alert's strike
// has to show up in the chain even when it's well outside the plain
// near-the-money window — a covered-call alert can sit 20+ points OTM on a
// low-delta strike, which the standard ±strikesPerSide trim below would
// otherwise silently drop. Validated the same way as every other candidate
// (checkStrikeExists), then unioned back in AFTER the near-the-money trim
// so it survives regardless of how far it sits from spot.
async function lookupValidStrikesForExpiry(
  ib: IBApi,
  symbol: string,
  expiry: string,
  rawStrikes: number[],
  spotPrice: number,
  mustIncludeStrikes: number[] = [],
): Promise<number[]> {
  const nearTheMoneyCandidates = pickStrikes(rawStrikes, spotPrice, strikesPerSide + candidateBufferPerSide);
  const candidates = Array.from(new Set([...nearTheMoneyCandidates, ...mustIncludeStrikes]));
  const validStrikes = await getCachedValidStrikes(ib, symbol, expiry, candidates);
  const nearTheMoney = pickStrikes(validStrikes, spotPrice);
  const validMustInclude = validStrikes.filter((s) => mustIncludeStrikes.includes(s));
  return Array.from(new Set([...nearTheMoney, ...validMustInclude])).sort((a, b) => a - b);
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

// Exported for reuse by fetchOrderLegQuote.ts (Order Review panel's live
// bid/ask/Greeks/IV for a not-yet-confirmed order's option leg) — same
// underlying subscribe/collect/cancel logic, just a single contract instead
// of a whole chain.
function isQuoteReady(quote: OptionQuote): boolean {
  const hasPrice = (quote.bid !== null && quote.ask !== null) || quote.last !== null;
  return hasPrice && quote.delta !== null;
}


export async function fetchQuotesForContracts(
  ib: IBApi,
  symbol: string,
  contracts: { expiry: string; strike: number; right: OptionType }[],
  // Optional continuous mode (approved 2026-08-26, for the Ticker Detail
  // modal): when provided, this function keeps every contract's streaming
  // subscription open past the initial resolve and calls onUpdate with the
  // latest full quote list on a fixed interval, until `signal` aborts —
  // instead of cancelling and returning once. Every other caller (Order
  // Review's live quote, trade-alert generation/refresh, Greeks lookups)
  // omits this and keeps the original one-shot behavior unchanged.
  live?: { onUpdate: (quotes: OptionQuote[]) => void; signal: AbortSignal },
): Promise<OptionQuote[]> {
  const quotes = new Map<number, OptionQuote>();
  const reqIdToContract = new Map<number, { expiry: string; strike: number; right: "C" | "P" }>();
  const readyReqIds = new Set<number>();
  let nextReqId = 10_000;
  let onAllReady: (() => void) | null = null;

  // Streaming reqMktData subscriptions have no IBKR-side "done" event (unlike
  // snapshot mode's tickSnapshotEnd) — the fixed quoteTimeoutMs wait below is
  // a safety ceiling, not the expected path. Most contracts get both a price
  // and a modeled delta well before that, so this resolves as soon as every
  // contract is ready rather than always paying the full wait. Illiquid
  // strikes that never produce a delta tick still fall through to the
  // ceiling, same as before this change.
  //
  // Snapshot mode (reqMktData's snapshot=true, with tickSnapshotEnd as the
  // completion signal) was tried and measured worse on both axes: it never
  // resolved before the ceiling across a full 14-ticker test run, and
  // averaged ~54% price+delta completeness vs. ~83% for this streaming
  // approach — delayed-data snapshot requests for options are unreliable on
  // this account, consistent with the account's general delayed-data
  // limitations (see other IBKR notes in this codebase).
  function checkReady(reqId: number) {
    if (readyReqIds.has(reqId)) return;
    const quote = quotes.get(reqId);
    if (!quote || !isQuoteReady(quote)) return;
    readyReqIds.add(reqId);
    if (readyReqIds.size === reqIdToContract.size) onAllReady?.();
  }

  // True real-time push (approved 2026-08-27, replacing a fixed 1.5s
  // interval) once live mode is active — see the matching note in
  // fetchTickerOverview.ts's streamPricingUpdates. Coalesced only within
  // the same event-loop turn: a chain of 30+ contracts can have several
  // land back to back from one network read, and this still pushes on
  // every genuinely new batch of ticks, just not once per individual field.
  let liveMode: { onUpdate: (quotes: OptionQuote[]) => void; signal: AbortSignal } | null = null;
  let pushScheduled = false;
  function schedulePush() {
    if (!liveMode || pushScheduled) return;
    pushScheduled = true;
    setImmediate(() => {
      pushScheduled = false;
      liveMode?.onUpdate(Array.from(quotes.values()));
    });
  }

  function onTickPrice(reqId: number, tickType: number, price: number) {
    const quote = quotes.get(reqId);
    if (!quote) return;
    // IBKR sends -1 as an explicit "no data for this field right now" tick
    // (found 2026-08-27 investigating stale post-close option bid/ask that
    // never cleared) -- normalized to null here rather than silently
    // dropped, so a field that genuinely stops being quoted goes back to "no
    // data" instead of freezing on the last real value it ever held for the
    // rest of this streaming session.
    const value = price > 0 ? price : null;
    // Real-time tick types: bid=1, ask=2, last=4. Delayed: bid=66, ask=67,
    // last=68. Accepts both — see the tickOptionComputation comment below
    // for why (real-time entitlement enabled 2026-08-31 sends real-time
    // tick types regardless of what reqMarketDataType() requests).
    if (tickType === 1 || tickType === 66) quote.bid = value;
    if (tickType === 2 || tickType === 67) quote.ask = value;
    if (tickType === 4 || tickType === 68) quote.last = value;
    checkReady(reqId);
    schedulePush();
  }

  function onTickOptionComputation(
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
    _undPrice?: number,
  ) {
    const quote = quotes.get(reqId);
    // Model computation only — doesn't depend on a stale last trade the way
    // the last-computation tick (12/82) does. Accepts both the real-time
    // (13) and delayed (83) variants: this account held delayed-only
    // entitlements when 83-only was written, but real-time market data was
    // enabled 2026-08-31, and IBKR sends real-time-labeled ticks (13) once
    // that's active regardless of what reqMarketDataType() requests —
    // an 83-only filter silently discarded every tick from that point on,
    // which is exactly what caused that day's trade-alert outage (see
    // runTradeAlertGeneration.ts's history around 2026-08-31).
    if (!quote || (tickType !== 83 && tickType !== 13)) return;
    quote.impliedVolatility = impliedVol ?? null;
    quote.delta = delta ?? null;
    quote.gamma = gamma ?? null;
    quote.vega = vega ?? null;
    quote.theta = theta ?? null;
    checkReady(reqId);
    schedulePush();
  }

  function onError(error: Error, code: number, reqId: number) {
    if (!quotes.has(reqId)) return;
    // Informational "using delayed data" notices, expected wherever this
    // account isn't entitled for real-time on a given symbol.
    if (isDelayedDataFallbackNotice(code)) return;
    const contract = reqIdToContract.get(reqId);
    console.error(
      `Option quote error for ${symbol} ${contract?.expiry} ${contract?.strike}${contract?.right} (code ${code}): ${error.message}`,
    );
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickOptionComputation, onTickOptionComputation);
  ib.on(EventName.error, onError);

  for (const contract of contracts) {
    const reqId = nextReqId++;
    reqIdToContract.set(reqId, contract);
    quotes.set(reqId, {
      expiry: contract.expiry,
      strike: contract.strike,
      right: contract.right,
      bid: null,
      ask: null,
      last: null,
      impliedVolatility: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
    });
    ib.reqMktData(reqId, new Option(symbol, contract.expiry, contract.strike, contract.right, "SMART"), "", false, false);
  }

  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    if (reqIdToContract.size === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, quoteTimeoutMs);
    onAllReady = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  console.log(
    `${symbol}: quotes ready in ${Date.now() - startedAt}ms (${readyReqIds.size}/${reqIdToContract.size} contracts had price+delta)`,
  );

  function cleanup() {
    for (const reqId of reqIdToContract.keys()) {
      ib.cancelMktData(reqId);
    }
    ib.removeListener(EventName.tickPrice, onTickPrice);
    ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
    ib.removeListener(EventName.error, onError);
  }

  if (!live || live.signal.aborted) {
    cleanup();
    return Array.from(quotes.values());
  }

  // Deliberately NOT awaited: the initial ready/timeout wait above already
  // satisfies this function's promise (the caller — streamTickerDetail.ts —
  // needs that first chain painted right away, not once the whole streaming
  // session eventually ends). Arming liveMode makes schedulePush (above)
  // start pushing on every real-time tick for the rest of the connection's
  // life, cleaning itself up once `live.signal` aborts.
  liveMode = live;
  live.signal.addEventListener("abort", cleanup, { once: true });

  return Array.from(quotes.values());
}

export interface ExpiryStrikes {
  expiry: string;
  strikes: number[];
}

// Needs spotPrice up front now (unlike the old wildcard-scan version) to
// narrow reqSecDefOptParams's cross-expiry strike union to near-the-money
// candidates *before* validating them one at a time — see
// lookupValidStrikesForExpiry/checkStrikeExists above. That means this can
// no longer start until the pricing snapshot resolves, giving up the old
// "start as soon as conId is known" overlap with pricing — an acceptable
// trade since the per-strike checks below replace what used to be a 10-20s+
// throttled wildcard call per expiry.
// Takes conId as a parameter rather than looking it up itself — the caller
// already has it from its own contractDetails lookup (needed anyway for
// companyName/sector), and firing a second, redundant reqContractDetails
// call for the same underlying concurrently with the first was found to
// trigger real request-pacing contention on IBKR's side (a genuine
// "Pricing snapshot timeout" was reproduced from this).
//
// The two expiries are looked up concurrently, not sequentially — the
// second expiry's lookup has been observed taking 4-5x longer than the
// first when done sequentially in a loop, for reasons not fully
// understood; running them via Promise.all avoids paying that cost twice
// in serial.
// Does not call reqMarketDataType itself — see the note on
// lookupPricingSnapshot in fetchTickerOverview.ts. The caller (currently
// only streamTickerDetail.ts) sets it once for the whole shared connection.
export async function prepareOptionChainStrikes(
  connection: IbkrConnection,
  symbol: string,
  conId: number,
  spotPrice: number,
  dteRange: { min: number; max: number } = { min: defaultMinDaysToExpiry, max: defaultMaxDaysToExpiry },
  // Approved 2026-08-26: every pending trade alert's strike must show up in
  // the chain, even ones the near-the-money window alone would trim away
  // (see lookupValidStrikesForExpiry). Keyed by expiry in the same YYYYMMDD
  // shape used everywhere else in this file.
  alertStrikesByExpiry: Map<string, number[]> = new Map(),
): Promise<ExpiryStrikes[]> {
  const { ib } = connection;

  const { expirations, strikes } = await getCachedOptionParams(ib, symbol, conId);
  // A pending alert's expiry has to be browsable even if maxExpiries' trim
  // would otherwise cut it — same "every alert must be visible" requirement
  // as mustIncludeStrikes above, one level up (expiries, not just strikes
  // within an already-kept expiry).
  const chosenExpiries = Array.from(new Set([...pickExpiries(expirations, dteRange), ...alertStrikesByExpiry.keys()])).sort();

  return Promise.all(
    chosenExpiries.map(async (expiry) => ({
      expiry,
      strikes: await lookupValidStrikesForExpiry(ib, symbol, expiry, strikes, spotPrice, alertStrikesByExpiry.get(expiry) ?? []),
    })),
  );
}

// Strikes arriving here are already the final near-the-money, validated set
// from prepareOptionChainStrikes — just subscribe and collect quotes. `live`
// passes straight through to fetchQuotesForContracts — see its doc comment.
export async function quoteOptionChain(
  connection: IbkrConnection,
  symbol: string,
  expiryStrikes: ExpiryStrikes[],
  live?: { onUpdate: (quotes: OptionQuote[]) => void; signal: AbortSignal },
): Promise<OptionQuote[]> {
  const { ib } = connection;

  const contracts: { expiry: string; strike: number; right: OptionType }[] = [];
  for (const { expiry, strikes } of expiryStrikes) {
    for (const strike of strikes) {
      contracts.push({ expiry, strike, right: OptionType.Call });
      contracts.push({ expiry, strike, right: OptionType.Put });
    }
  }

  return fetchQuotesForContracts(ib, symbol, contracts, live);
}

