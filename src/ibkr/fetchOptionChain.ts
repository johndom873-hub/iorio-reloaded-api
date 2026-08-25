import { EventName, Option, OptionType, SecType } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

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
const minDaysToExpiry = 0;
const maxDaysToExpiry = 60;
const maxExpiries = 6;
const strikesPerSide = 4;
const quoteTimeoutMs = 8_000;

// Exported for reuse by the trade-alert candidate generator, which needs
// its own per-strategy DTE window instead of this file's fixed one.
export function parseExpiry(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00Z`);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
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
    const timer = setTimeout(() => reject(new Error(`secDefOptParams timeout for ${symbol}`)), 10_000);
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
      clearTimeout(timer);
      ib.removeListener(EventName.securityDefinitionOptionParameter, onParams);
      resolve({ expirations: Array.from(expirations), strikes: Array.from(strikes) });
    }
    ib.on(EventName.securityDefinitionOptionParameter, onParams);
    ib.reqSecDefOptParams(reqId, symbol, "", "STK", conId);
  });
}

function pickExpiries(expirations: string[]): string[] {
  const today = new Date();
  return expirations
    .filter((expiry) => {
      const dte = daysBetween(today, parseExpiry(expiry));
      return dte >= minDaysToExpiry && dte <= maxDaysToExpiry;
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

async function lookupValidStrikesForExpiry(ib: IBApi, symbol: string, expiry: string, rawStrikes: number[], spotPrice: number): Promise<number[]> {
  const candidates = pickStrikes(rawStrikes, spotPrice, strikesPerSide + candidateBufferPerSide);
  const results = await Promise.all(
    candidates.map(async (strike) => ({ strike, exists: await checkStrikeExists(ib, symbol, expiry, strike) })),
  );
  const validStrikes = results.filter((r) => r.exists).map((r) => r.strike);
  return pickStrikes(validStrikes, spotPrice);
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

  function onTickPrice(reqId: number, tickType: number, price: number) {
    const quote = quotes.get(reqId);
    if (!quote || price < 0) return;
    // Delayed tick types: bid=66, ask=67, last=68.
    if (tickType === 66) quote.bid = price;
    if (tickType === 67) quote.ask = price;
    if (tickType === 68) quote.last = price;
    checkReady(reqId);
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
    // Prefer the model computation (delayed model = 83) — doesn't depend on
    // a stale last trade the way the last-computation tick (82) does.
    if (!quote || tickType !== 83) return;
    quote.impliedVolatility = impliedVol ?? null;
    quote.delta = delta ?? null;
    quote.gamma = gamma ?? null;
    quote.vega = vega ?? null;
    quote.theta = theta ?? null;
    checkReady(reqId);
  }

  function onError(error: Error, code: number, reqId: number) {
    if (!quotes.has(reqId)) return;
    // 10167/10091: informational "using delayed data" notices, expected —
    // this account isn't subscribed to real-time data by design.
    if (code === 10167 || code === 10091) return;
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

  for (const reqId of reqIdToContract.keys()) {
    ib.cancelMktData(reqId);
  }
  ib.removeListener(EventName.tickPrice, onTickPrice);
  ib.removeListener(EventName.tickOptionComputation, onTickOptionComputation);
  ib.removeListener(EventName.error, onError);

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
): Promise<ExpiryStrikes[]> {
  const { ib } = connection;

  const { expirations, strikes } = await lookupOptionParams(ib, symbol, conId);
  const chosenExpiries = pickExpiries(expirations);

  return Promise.all(
    chosenExpiries.map(async (expiry) => ({
      expiry,
      strikes: await lookupValidStrikesForExpiry(ib, symbol, expiry, strikes, spotPrice),
    })),
  );
}

// Strikes arriving here are already the final near-the-money, validated set
// from prepareOptionChainStrikes — just subscribe and collect quotes.
export async function quoteOptionChain(connection: IbkrConnection, symbol: string, expiryStrikes: ExpiryStrikes[]): Promise<OptionQuote[]> {
  const { ib } = connection;

  const contracts: { expiry: string; strike: number; right: OptionType }[] = [];
  for (const { expiry, strikes } of expiryStrikes) {
    for (const strike of strikes) {
      contracts.push({ expiry, strike, right: OptionType.Call });
      contracts.push({ expiry, strike, right: OptionType.Put });
    }
  }

  return fetchQuotesForContracts(ib, symbol, contracts);
}

