import { lookupExpiryStrikes, lookupOptionParams } from "./fetchOptionChain.js";
import { borrowSharedConnectionOrConnect, sharedReadConnection } from "./sharedReadConnection.js";

// An expiry's listed strikes and a ticker's listed expiries looked up live from IBKR, kept for the trading day (they
// rarely change within a day): the Ticker window's chain past the stored grid, and Pluto's LEAPS (Vol Farmer v2).

const liveStrikesCache = new Map<string, number[]>();
const liveExpirationsCache = new Map<string, string[]>();

async function withIbkr<T>(label: string, run: (ib: Parameters<typeof lookupExpiryStrikes>[0]) => Promise<T>): Promise<T> {
  const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, label);
  try {
    return await run(connection.ib);
  } finally {
    connection.disconnect();
  }
}

/** The ticker's listed expiries (YYYYMMDD), looked up once a trading day. */
export async function liveListedExpirations(ticker: { id: string; symbol: string; contractId: number }, todayIso: string, label: string): Promise<string[]> {
  const cacheKey = `${ticker.id}|${todayIso}`;
  let live = liveExpirationsCache.get(cacheKey);
  if (!live) {
    live = (await withIbkr(label, (ib) => lookupOptionParams(ib, ticker.symbol, ticker.contractId))).expirations;
    liveExpirationsCache.set(cacheKey, live);
  }
  return live;
}

/** An expiry's (YYYYMMDD) listed strikes, looked up once a trading day; an empty answer is not kept. */
export async function liveExpiryStrikes(ticker: { id: string; symbol: string }, expiryYyyymmdd: string, todayIso: string, label: string): Promise<number[]> {
  const cacheKey = `${ticker.id}|${expiryYyyymmdd}|${todayIso}`;
  let live = liveStrikesCache.get(cacheKey);
  if (!live) {
    live = (await withIbkr(label, (ib) => lookupExpiryStrikes(ib, ticker.symbol, expiryYyyymmdd))).strikes;
    if (live.length > 0) liveStrikesCache.set(cacheKey, live);
  }
  return live;
}
