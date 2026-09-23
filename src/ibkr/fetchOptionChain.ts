import { EventName, Option, OptionType, SecType } from "@stoqey/ib";
import type { Contract, ContractDetails, IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import { db } from "../db/connection.js";
import { calendarDaysUntilExpiry, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry } from "../lib/optionChainCaptureWindow.js";

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
// the covered-call/CSP monthly range. maxExpiries=6 x strikesPerSide(4) x 2
// sides x 2 rights = 96 reqMktData lines (the only lines this connection
// opens — the pricing lookup is a snapshot and doesn't count) is the target
// budget, kept at or under 96 of IBKR's 100-line-per-connection cap.
// pickExpiries sorts ascending and takes the first N, so the nearest
// (weekly/intra-weekly) expiries are always the ones kept if more than 6
// exist in the window.
//
// mustIncludeStrikes/alertStrikesByExpiry (see prepareOptionChainStrikes)
// spend from this same 96-line budget rather than adding to it — regression
// found 2026-09-15: an earlier version of this file unioned must-include
// expiries/strikes on top of the 96-line target, which could push a given
// connection's subscription count past IBKR's actual 100-line cap. Contracts
// requested past that cap never receive tickPrice/tickOptionComputation
// ticks, so their bid/ask/delta stayed null forever and their yield
// silently rendered blank — while the must-include strikes themselves (early
// in subscription order) kept working, which is what made it look like only
// "regular" strikes were affected.
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
): Promise<{ expirations: string[] }> {
  return new Promise((resolve, reject) => {
    const reqId = nextReqIdFor(ib, () => nextLookupReqId++);
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
    ) {
      if (id !== reqId || exchange !== "SMART") return;
      cleanup();
      resolve({ expirations: Array.from(expirations) });
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

// Option-chain structure model (Marcelo, 2026-09-23): the nightly capture (and
// the new-ticker pipeline's chain_warmup) is the ONLY thing that asks IBKR for
// expiries and strikes — refreshStoredOptionChain below. Everything else (the
// Ticker Detail chain, position quotes, the alert scan) reads what it stored
// and never goes to IBKR for chain structure. A ticker with nothing stored is
// "not prepared yet", not a reason to fetch.
export interface StoredOptionChain {
  /** Every listed expiry, from reqSecDefOptParams. */
  expirations: string[];
  /** The real strike grid per expiry, stored for expiries inside the 0-90 DTE capture window only. */
  strikesByExpiry: Map<string, number[]>;
  fetchedAt: Date | null;
}

export async function loadStoredOptionChain(tickerId: string): Promise<StoredOptionChain> {
  const [params, gridRows] = await Promise.all([
    db("option_chain_params").where({ ticker_id: tickerId }).first(),
    db("option_chain_expiry_strikes").where({ ticker_id: tickerId }).select("expiry", "strikes", "fetched_at") as Promise<{ expiry: string; strikes: (string | number)[]; fetched_at: Date }[]>,
  ]);
  return {
    expirations: params ? (params.expirations as string[]) : [],
    strikesByExpiry: new Map(gridRows.map((row) => [row.expiry, row.strikes.map(Number)])),
    fetchedAt: params ? new Date(params.fetched_at) : null,
  };
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

// reqSecDefOptParams's strikes array is a union across every expiry/exchange
// combination, not per-expiry: measured 2026-09-23 on AMAT, 49% of those
// strike x expiry pairs don't exist (28% on the front expiry, ~60% a month
// out). The real grid for one expiry comes from ONE reqContractDetails with
// expiry and right fixed and strike left unset. IBKR spends ~4.5s "thinking"
// before the first contract arrives, then streams the whole list in well
// under a second — bounded and reliable, with two hard rules learned the
// same day:
//   1. One at a time per connection, always. IBKR queues these per client:
//      concurrency 1, 2 and 4 all took the same total time (1 was slightly
//      faster), and firing 17 at once earlier timed out 14 of them.
//   2. Never the fully ambiguous form (no expiry either) — that is what
//      throttled AMAT for 25s in prod on 2026-08-14.
// This replaced per-strike probing (one fully-qualified reqContractDetails
// per candidate strike): 36s for AMAT's 8 in-window expiries vs ~6 min for
// the 641 probes the same window needed, and ~1,370 requests per ticker on
// a big chain. Right=Call only — calls and puts share the listed grid.
const expiryStrikesTimeoutMs = 30_000;

// The per-connection queue behind rule 1: whoever calls, no two wildcard
// lookups are ever in flight on the same ib at once.
const wildcardQueueByIb = new WeakMap<IBApi, Promise<unknown>>();
function runOneAtATime<T>(ib: IBApi, task: () => Promise<T>): Promise<T> {
  const previous = wildcardQueueByIb.get(ib) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  wildcardQueueByIb.set(ib, next);
  return next;
}

export interface ExpiryStrikesLookup {
  strikes: number[];
  contractCount: number;
  elapsedMs: number;
}

export function lookupExpiryStrikes(ib: IBApi, symbol: string, expiry: string): Promise<ExpiryStrikesLookup> {
  return runOneAtATime(
    ib,
    () =>
      new Promise((resolve, reject) => {
        const reqId = nextReqIdFor(ib, () => nextLookupReqId++);
        const startedAt = Date.now();
        const strikes = new Set<number>();
        let contractCount = 0;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`strike grid lookup for ${symbol} ${expiry} timed out after ${expiryStrikesTimeoutMs / 1000}s`));
        }, expiryStrikesTimeoutMs);

        function onDetails(id: number, details: ContractDetails) {
          if (id !== reqId) return;
          contractCount++;
          if (details.contract.strike) strikes.add(details.contract.strike);
        }
        function onEnd(id: number) {
          if (id !== reqId) return;
          cleanup();
          resolve({ strikes: [...strikes].sort((a, b) => a - b), contractCount, elapsedMs: Date.now() - startedAt });
        }
        function onError(error: Error, code: number, id: number) {
          if (id !== reqId) return;
          cleanup();
          // 200 = "No security definition has been found": an expiry with no listed calls, not a failure.
          if (code === 200) resolve({ strikes: [], contractCount: 0, elapsedMs: Date.now() - startedAt });
          else reject(new Error(`strike grid lookup for ${symbol} ${expiry} failed (code ${code}): ${error.message}`));
        }
        function cleanup() {
          clearTimeout(timer);
          ib.removeListener(EventName.contractDetails, onDetails);
          ib.removeListener(EventName.contractDetailsEnd, onEnd);
          ib.removeListener(EventName.error, onError);
        }

        const expiryWildcard: Contract = {
          symbol,
          secType: SecType.OPT,
          lastTradeDateOrContractMonth: expiry,
          right: OptionType.Call,
          exchange: "SMART",
          currency: "USD",
        };
        ib.on(EventName.contractDetails, onDetails);
        ib.on(EventName.contractDetailsEnd, onEnd);
        ib.on(EventName.error, onError);
        ib.reqContractDetails(reqId, expiryWildcard);
      }),
  );
}

export interface OptionChainRefreshTimings {
  optionParamsMs: number;
  expiries: { expiry: string; strikeCount: number; elapsedMs: number }[];
  totalMs: number;
}

export interface StoredOptionChainRefresh {
  expirations: string[];
  strikesByExpiry: Map<string, number[]>;
  timings: OptionChainRefreshTimings;
}

/**
 * The one place chain structure is fetched from IBKR: every listed expiry
 * (reqSecDefOptParams), then the real strike grid for each expiry inside the
 * 0-90 DTE capture window, one wildcard at a time, each stored as soon as it
 * lands so a failure part-way keeps the expiries already done. Always
 * refreshes — the nightly capture is the schedule, there is no TTL.
 */
export async function refreshStoredOptionChain(
  ib: IBApi,
  ticker: { tickerId: string; symbol: string; contractId: number },
  todayIso: string,
): Promise<StoredOptionChainRefresh> {
  const startedAt = Date.now();
  const { expirations } = await lookupOptionParams(ib, ticker.symbol, ticker.contractId);
  const optionParamsMs = Date.now() - startedAt;
  await db("option_chain_params")
    .insert({ ticker_id: ticker.tickerId, expirations, fetched_at: new Date() })
    .onConflict("ticker_id")
    .merge();

  const expiriesInWindow = expirations
    .filter((expiry) => {
      const daysToExpiry = calendarDaysUntilExpiry(todayIso, expiry);
      return daysToExpiry >= captureMinimumDaysToExpiry && daysToExpiry <= captureMaximumDaysToExpiry;
    })
    .sort();

  const strikesByExpiry = new Map<string, number[]>();
  const expiryTimings: OptionChainRefreshTimings["expiries"] = [];
  for (const expiry of expiriesInWindow) {
    const lookup = await lookupExpiryStrikes(ib, ticker.symbol, expiry);
    strikesByExpiry.set(expiry, lookup.strikes);
    expiryTimings.push({ expiry, strikeCount: lookup.strikes.length, elapsedMs: lookup.elapsedMs });
    await db("option_chain_expiry_strikes")
      .insert({ ticker_id: ticker.tickerId, expiry, strikes: lookup.strikes, fetched_at: new Date() })
      .onConflict(["ticker_id", "expiry"])
      .merge();
  }
  // Grids for expiries that have expired or rolled past the window are no longer read by anyone.
  await db("option_chain_expiry_strikes").where({ ticker_id: ticker.tickerId }).whereNotIn("expiry", expiriesInWindow).delete();

  return { expirations, strikesByExpiry, timings: { optionParamsMs, expiries: expiryTimings, totalMs: Date.now() - startedAt } };
}

// mustIncludeStrikes (approved 2026-08-26): a pending trade alert's strike
// has to show up in the chain even when it's well outside the plain
// near-the-money window — a covered-call alert can sit 20+ points OTM on a
// low-delta strike, which the standard ±strikesPerSide trim would otherwise
// silently drop. They come from real quotes (an alert or a held leg), so
// they are unioned in as-is rather than checked against the stored grid.
function pickExpiryStrikes(gridStrikes: number[], spotPrice: number, mustIncludeStrikes: number[], nearTheMoneyCountPerSide: number): number[] {
  const nearTheMoney = pickStrikes(gridStrikes, spotPrice, nearTheMoneyCountPerSide);
  return Array.from(new Set([...nearTheMoney, ...mustIncludeStrikes])).sort((a, b) => a - b);
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
    const reqId = nextReqIdFor(ib, () => nextReqId++);
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

// Reads chain structure from the DB only (see StoredOptionChain) — no IBKR
// call, so it costs a couple of Postgres reads regardless of how many
// expiries are shown. spotPrice picks the near-the-money strikes.
export async function prepareOptionChainStrikes(
  symbol: string,
  spotPrice: number,
  dteRange: { min: number; max: number } = { min: defaultMinDaysToExpiry, max: defaultMaxDaysToExpiry },
  // Approved 2026-08-26: every pending trade alert's strike must show up in
  // the chain, even ones the near-the-money window alone would trim away
  // (see pickExpiryStrikes). Keyed by expiry in the same YYYYMMDD shape used
  // everywhere else in this file.
  alertStrikesByExpiry: Map<string, number[]> = new Map(),
): Promise<ExpiryStrikes[]> {
  const tickerId = await resolveTickerId(symbol);
  const stored = tickerId ? await loadStoredOptionChain(tickerId) : null;
  if (!stored || stored.strikesByExpiry.size === 0) {
    throw new Error(`Option chain for ${symbol} is not prepared yet — it is stored by the nightly chain capture, or when the ticker is added to the Shortlist.`);
  }
  const { expirations } = stored;

  // A pending alert's/held position's expiry has to be browsable even if
  // maxExpiries' trim would otherwise cut it — same "every must-include
  // strike must be visible" requirement as mustIncludeStrikes below, one
  // level up (expiries, not just strikes within an already-kept expiry).
  // Must-include expiries always survive; only the remaining slots up to
  // maxExpiries are filled with the nearest regular expiries, so this no
  // longer just appends on top of maxExpiries (see the file-level budget
  // comment). The one accepted edge case: more must-include expiries than
  // maxExpiries for a single ticker at once goes over budget rather than
  // dropping one of them — showing every held position/alert wins over the
  // line-count margin in that rare situation.
  const mustExpiries = Array.from(alertStrikesByExpiry.keys()).sort();
  const regularExpiries = pickExpiries(expirations, dteRange).filter((expiry) => !alertStrikesByExpiry.has(expiry));
  const remainingExpirySlots = Math.max(0, maxExpiries - mustExpiries.length);
  const chosenExpiries = Array.from(new Set([...mustExpiries, ...regularExpiries.slice(0, remainingExpirySlots)])).sort();

  // Spend the shared 96-line budget: reserve slots for must-include strikes
  // first (counted pre-validation — a couple of lines' slack either way
  // doesn't threaten the 96/100 margin), then split whatever's left evenly
  // across the chosen expiries for the normal near-the-money picks, never
  // exceeding the default strikesPerSide. This is what keeps must-include
  // strikes from just piling on top of the budget the way the regression
  // did — see the file-level comment.
  const totalStrikeSlots = maxExpiries * strikesPerSide * 2;
  const mustSlotsUsed = chosenExpiries.reduce((sum, expiry) => sum + (alertStrikesByExpiry.get(expiry)?.length ?? 0), 0);
  const remainingSlotsForNearTheMoney = Math.max(0, totalStrikeSlots - mustSlotsUsed);
  const nearTheMoneyCountPerSide =
    chosenExpiries.length === 0
      ? strikesPerSide
      : Math.min(strikesPerSide, Math.floor(remainingSlotsForNearTheMoney / (chosenExpiries.length * 2)));

  // A must-include expiry outside the stored 0-90 DTE window has no grid; its
  // must-include strikes (a held leg, a pending alert) still show on their own.
  return chosenExpiries
    .map((expiry) => ({
      expiry,
      strikes: pickExpiryStrikes(stored.strikesByExpiry.get(expiry) ?? [], spotPrice, alertStrikesByExpiry.get(expiry) ?? [], nearTheMoneyCountPerSide),
    }))
    .filter(({ strikes: expiryStrikes }) => expiryStrikes.length > 0);
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

