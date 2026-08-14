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

// Strategy-relevant window, not the full chain: covered calls / CSPs both
// trade in the ~15-60 DTE range at strikes near the money. Capping expiries
// and strikes-per-side keeps the number of concurrent IBKR market data
// subscriptions well under the default 100-line-per-connection limit —
// verified empirically (tmp/test-option-chain.ts) that per-contract Greeks
// stream fine on delayed data, but a full chain (every strike x every
// expiry) was never tested and risks hitting that limit.
const minDaysToExpiry = 15;
const maxDaysToExpiry = 60;
const maxExpiries = 2;
const strikesPerSide = 4;
const quoteTimeoutMs = 8_000;

function parseExpiry(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00Z`);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

// Monotonic, not Date.now()-based — two lookups issued within the same
// millisecond (e.g. back-to-back expiries in the loop below) would
// otherwise collide on the same reqId and cross-resolve each other's
// listeners. Starts high to stay clear of the small fixed reqIds
// (contractDetailsReqId=1, pricingReqId=2, etc.) used by sibling callers
// sharing the same connection.
let nextLookupReqId = 5_000;

async function lookupOptionParams(
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

function pickStrikes(strikes: number[], spotPrice: number): number[] {
  const sorted = [...strikes].sort((a, b) => a - b);
  const below = sorted.filter((s) => s <= spotPrice).slice(-strikesPerSide);
  const above = sorted.filter((s) => s > spotPrice).slice(0, strikesPerSide);
  return [...below, ...above];
}

// reqSecDefOptParams's strikes array is a union across every expiry/exchange
// combination, not per-expiry — most of those strike x expiry pairs don't
// actually exist as real contracts (verified empirically: requesting a
// blindly-picked near-money strike for a real expiry returned IBKR error 200
// "No security definition has been found" for most of them). A wildcard
// contractDetails lookup (expiry set, strike/right unset) returns every
// contract IBKR actually lists for that specific expiry, which we then
// narrow to the near-the-money window.
function requestValidStrikesForExpiry(ib: IBApi, symbol: string, expiry: string, timeoutMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reqId = nextLookupReqId++;
    const strikes = new Set<number>();
    const timer = setTimeout(() => reject(new Error(`contractDetails (option) timeout for ${symbol} ${expiry}`)), timeoutMs);

    function onDetails(id: number, details: { contract: { strike?: number } }) {
      if (id !== reqId) return;
      if (details.contract.strike) strikes.add(details.contract.strike);
    }
    function onEnd(id: number) {
      if (id !== reqId) return;
      clearTimeout(timer);
      ib.removeListener(EventName.contractDetails, onDetails);
      ib.removeListener(EventName.contractDetailsEnd, onEnd);
      resolve(Array.from(strikes));
    }

    const wildcardOptionContract: Contract = {
      symbol,
      secType: SecType.OPT,
      lastTradeDateOrContractMonth: expiry,
      exchange: "SMART",
      currency: "USD",
    };

    ib.on(EventName.contractDetails, onDetails);
    ib.once(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, wildcardOptionContract);
  });
}

// One retry — this lookup has been observed to occasionally time out when
// IBKR is already servicing another concurrent contractDetails request on
// the same account (e.g. the daily capture job running, or a user quickly
// reopening the modal), even though a solo request reliably succeeds.
async function lookupValidStrikesForExpiry(ib: IBApi, symbol: string, expiry: string): Promise<number[]> {
  try {
    return await requestValidStrikesForExpiry(ib, symbol, expiry, 10_000);
  } catch {
    return requestValidStrikesForExpiry(ib, symbol, expiry, 10_000);
  }
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

async function fetchQuotesForContracts(
  ib: IBApi,
  symbol: string,
  contracts: { expiry: string; strike: number; right: OptionType }[],
): Promise<OptionQuote[]> {
  const quotes = new Map<number, OptionQuote>();
  const reqIdToContract = new Map<number, { expiry: string; strike: number; right: "C" | "P" }>();
  let nextReqId = 10_000;

  function onTickPrice(reqId: number, tickType: number, price: number) {
    const quote = quotes.get(reqId);
    if (!quote || price < 0) return;
    // Delayed tick types: bid=66, ask=67, last=68.
    if (tickType === 66) quote.bid = price;
    if (tickType === 67) quote.ask = price;
    if (tickType === 68) quote.last = price;
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

  await new Promise((resolve) => setTimeout(resolve, quoteTimeoutMs));

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

// The metadata half of an option chain lookup — every valid strike per
// chosen expiry — needs only the symbol's conId, never the spot price (only
// the final near-the-money narrowing in quoteOptionChain does). Split out
// so callers (see streamTickerDetail.ts) can kick this off as soon as
// conId is known, without waiting for the (often slower) pricing snapshot.
// Takes conId as a parameter rather than looking it up itself — the caller
// already has it from its own contractDetails lookup (needed anyway for
// companyName/sector), and firing a second, redundant reqContractDetails
// call for the same underlying concurrently with the first was found to
// trigger real request-pacing contention on IBKR's side (a genuine
// "Pricing snapshot timeout" was reproduced from this, not just the
// already-documented per-expiry strikes slowdown below).
//
// The two expiries are looked up concurrently, not sequentially — the
// second expiry's lookup has been observed taking 4-5x longer than the
// first when done sequentially in a loop, for reasons not fully
// understood; running them via Promise.all avoids paying that cost twice
// in serial.
// Does not call reqMarketDataType itself — see the note on
// lookupPricingSnapshot in fetchTickerOverview.ts. The caller (currently
// only streamTickerDetail.ts) sets it once for the whole shared connection.
export async function prepareOptionChainStrikes(connection: IbkrConnection, symbol: string, conId: number): Promise<ExpiryStrikes[]> {
  const { ib } = connection;

  const { expirations } = await lookupOptionParams(ib, symbol, conId);
  const chosenExpiries = pickExpiries(expirations);

  return Promise.all(
    chosenExpiries.map(async (expiry) => ({
      expiry,
      strikes: await lookupValidStrikesForExpiry(ib, symbol, expiry),
    })),
  );
}

// The pricing half — narrows each expiry's valid strikes to the
// near-the-money window using spotPrice, then subscribes and collects
// quotes. Shares the connection's reqId space with prepareOptionChainStrikes
// (both draw from nextLookupReqId/nextReqId), so it's safe to call after
// prepareOptionChainStrikes has resolved even though they ran concurrently.
export async function quoteOptionChain(
  connection: IbkrConnection,
  symbol: string,
  spotPrice: number,
  expiryStrikes: ExpiryStrikes[],
): Promise<OptionQuote[]> {
  const { ib } = connection;

  const contracts: { expiry: string; strike: number; right: OptionType }[] = [];
  for (const { expiry, strikes } of expiryStrikes) {
    const chosenStrikes = pickStrikes(strikes, spotPrice);
    for (const strike of chosenStrikes) {
      contracts.push({ expiry, strike, right: OptionType.Call });
      contracts.push({ expiry, strike, right: OptionType.Put });
    }
  }

  return fetchQuotesForContracts(ib, symbol, contracts);
}

