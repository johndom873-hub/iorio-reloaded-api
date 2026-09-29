import { EventName, Option, OptionType, SecType } from "@stoqey/ib";
import type { Contract, ContractDetails, IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { db } from "../db/connection.js";
import { calendarDaysUntilExpiry, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry } from "../lib/optionChainCaptureWindow.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";


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
// the covered-call/CSP monthly range. maxExpiries=4 x strikesPerSide(3) x 2
// sides x 2 rights = 48 reqMktData lines (the only lines this connection
// opens — the pricing lookup is a snapshot and doesn't count) is the target
// budget. IBKR's 100-line cap is per TWS USERNAME, shared across every
// connection on that login (verified against IBKR's docs 2026-09-21) — NOT
// per connection, which this budget wrongly assumed at 96 until a staging
// incident (2026-09-23) where this live chain and the nightly capture job's
// own 60-line batches (captureOptionQuoteBatch.ts, which already accounted
// for the shared cap correctly) ran concurrently and both starved. 48 leaves
// real headroom instead of claiming nearly the whole shared budget for one
// connection; marketDataLineBudget.ts's cross-process reservation is what
// actually enforces the shared total now — this constant just keeps one
// connection's own ask reasonable. pickExpiries sorts ascending and takes
// the first N, so the nearest (weekly/intra-weekly) expiries are always the
// ones kept if more than 4 exist in the window.
const defaultMinDaysToExpiry = 0;
const defaultMaxDaysToExpiry = 60;
const maxExpiries = 4;
const strikesPerSide = 3;
const quoteTimeoutMs = 8_000;

export function parseExpiry(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00Z`);
}

/**
 * Calendar days from `from` to `to` (an expiry parsed by parseExpiry, i.e. a
 * UTC-midnight date). `from` is taken on the US Eastern calendar (2026-09-24):
 * every caller passes "now", and the UTC date runs one day ahead of the
 * market's between 20:00 and 00:00 ET, which reported an expiry as already
 * expired the evening before, and every DTE one day short.
 */
export function daysBetween(from: Date, to: Date): number {
  const fromMidnightUtc = Date.parse(`${easternDateIso(from)}T00:00:00Z`);
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

/**
 * An IBKR contract-definition request that never answered. It cannot be cancelled (the API has no
 * cancel for reqContractDetails/reqSecDefOptParams), so it stays queued in the Gateway's session and
 * everything sent after it waits behind it — callers should stop sending, not carry on.
 */
export class IbkrLookupTimeoutError extends Error {}

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
      reject(new IbkrLookupTimeoutError(lastError ?? `secDefOptParams timeout for ${symbol}`));
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
          reject(new IbkrLookupTimeoutError(`strike grid lookup for ${symbol} ${expiry} timed out after ${expiryStrikesTimeoutMs / 1000}s`));
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
  /** reused: the stored grid was fresh enough and no IBKR lookup was made for this expiry. */
  expiries: { expiry: string; strikeCount: number; elapsedMs: number; reused?: boolean }[];
  totalMs: number;
}

export interface StoredOptionChainRefresh {
  expirations: string[];
  strikesByExpiry: Map<string, number[]>;
  timings: OptionChainRefreshTimings;
}

export interface StoredGridReuse {
  /** A stored grid younger than this is reused instead of looked up again. */
  maxAgeDays: number;
  /** A stored grid is only reused while spot sits inside its strike range; null = decide on age alone. */
  spotPrice: number | null;
}

/** Pure: whether a stored strike grid can stand in for a fresh wildcard lookup. */
export function canReuseStoredGrid(stored: { strikes: number[]; fetchedAt: Date } | undefined, reuse: StoredGridReuse, now: Date): boolean {
  if (!stored || stored.strikes.length === 0) return false;
  if (now.getTime() - stored.fetchedAt.getTime() > reuse.maxAgeDays * 86_400_000) return false;
  if (reuse.spotPrice === null) return true;
  return reuse.spotPrice >= Math.min(...stored.strikes) && reuse.spotPrice <= Math.max(...stored.strikes);
}

/**
 * The one place chain structure is fetched from IBKR: every listed expiry
 * (reqSecDefOptParams), then the real strike grid for each expiry inside the
 * 0-90 DTE capture window, one wildcard at a time, each stored as soon as it
 * lands so a failure part-way keeps the expiries already done.
 *
 * With `reuse` (the daily structure job), a stored grid that is still fresh is
 * kept instead of looked up: a run of ~180 back-to-back wildcard lookups got
 * throttled by IBKR, stalling the whole Gateway session. Without it
 * (new-ticker warmup, the shortlist route), every expiry is looked up.
 *
 * option_chain_params (whose fetched_at is what the capture checks as "today's
 * structure") is written last, so a ticker interrupted part-way never looks
 * complete.
 */
export async function refreshStoredOptionChain(
  ib: IBApi,
  ticker: { tickerId: string; symbol: string; contractId: number },
  todayIso: string,
  reuse?: StoredGridReuse,
): Promise<StoredOptionChainRefresh> {
  const startedAt = Date.now();
  const { expirations } = await lookupOptionParams(ib, ticker.symbol, ticker.contractId);
  const optionParamsMs = Date.now() - startedAt;

  const expiriesInWindow = expirations
    .filter((expiry) => {
      const daysToExpiry = calendarDaysUntilExpiry(todayIso, expiry);
      return daysToExpiry >= captureMinimumDaysToExpiry && daysToExpiry <= captureMaximumDaysToExpiry;
    })
    .sort();

  const strikesByExpiry = new Map<string, number[]>();
  const expiryTimings: OptionChainRefreshTimings["expiries"] = [];
  const storedGrids = new Map<string, { strikes: number[]; fetchedAt: Date }>(
    (await db("option_chain_expiry_strikes").where({ ticker_id: ticker.tickerId }).select("expiry", "strikes", "fetched_at")).map((row: { expiry: string; strikes: (string | number)[]; fetched_at: Date }) => [
      String(row.expiry).slice(0, 10).replaceAll("-", ""),
      { strikes: row.strikes.map(Number), fetchedAt: new Date(row.fetched_at) },
    ]),
  );
  const now = new Date();
  for (const expiry of expiriesInWindow) {
    const storedGrid = storedGrids.get(expiry);
    if (reuse && canReuseStoredGrid(storedGrid, reuse, now)) {
      strikesByExpiry.set(expiry, storedGrid!.strikes);
      expiryTimings.push({ expiry, strikeCount: storedGrid!.strikes.length, elapsedMs: 0, reused: true });
      continue;
    }
    const lookup = await lookupExpiryStrikes(ib, ticker.symbol, expiry);
    const stored = storedGrid?.strikes ?? [];
    // An empty lookup (IBKR error 200 / no definitions right now) must not
    // replace a grid we already have (2026-09-24): downstream, an empty grid
    // means "no contracts" and the next alert refresh expires everything.
    if (lookup.strikes.length === 0 && stored.length > 0) {
      console.warn(`${ticker.symbol} ${expiry}: strike lookup came back empty — keeping the stored grid (${stored.length} strikes).`);
      strikesByExpiry.set(expiry, stored);
      expiryTimings.push({ expiry, strikeCount: stored.length, elapsedMs: lookup.elapsedMs });
      continue;
    }
    strikesByExpiry.set(expiry, lookup.strikes);
    expiryTimings.push({ expiry, strikeCount: lookup.strikes.length, elapsedMs: lookup.elapsedMs });
    await db("option_chain_expiry_strikes")
      .insert({ ticker_id: ticker.tickerId, expiry, strikes: lookup.strikes, fetched_at: new Date() })
      .onConflict(["ticker_id", "expiry"])
      .merge();
  }
  // Grids for expiries that have expired or rolled past the window are no longer read by anyone.
  // Guard the empty-array case: Knex compiles whereNotIn([]) as always-true, which would wipe
  // every stored expiry for this ticker if expiriesInWindow ever came back empty.
  if (expiriesInWindow.length > 0) {
    await db("option_chain_expiry_strikes").where({ ticker_id: ticker.tickerId }).whereNotIn("expiry", expiriesInWindow).delete();
  }
  await db("option_chain_params")
    .insert({ ticker_id: ticker.tickerId, expirations, fetched_at: new Date() })
    .onConflict("ticker_id")
    .merge();

  return { expirations, strikesByExpiry, timings: { optionParamsMs, expiries: expiryTimings, totalMs: Date.now() - startedAt } };
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

/**
 * Largest single reqMktData batch any caller opens at once — the line budget
 * is 90 for the whole login, so one call must never ask for more than what
 * leaves room for the pool (live screens) and the chain capture's 50.
 */
export const maximumQuoteBatchSize = 40;

export interface ExpiryStrikes {
  expiry: string;
  strikes: number[];
}

// Reads chain structure from the DB only (see StoredOptionChain) — no IBKR
// call, so it costs a couple of Postgres reads regardless of how many
// expiries are shown. spotPrice picks the near-the-money strikes.
export async function prepareOptionChainStrikes(symbol: string, spotPrice: number): Promise<ExpiryStrikes[]> {
  const tickerId = await resolveTickerId(symbol);
  const stored = tickerId ? await loadStoredOptionChain(tickerId) : null;
  if (!stored || stored.strikesByExpiry.size === 0) {
    throw new Error(`Option chain for ${symbol} is not prepared yet — it is stored by the nightly chain capture, or when the ticker is added to the Shortlist.`);
  }
  return pickExpiries(stored.expirations, { min: defaultMinDaysToExpiry, max: defaultMaxDaysToExpiry })
    .map((expiry) => ({ expiry, strikes: pickStrikes(stored.strikesByExpiry.get(expiry) ?? [], spotPrice) }))
    .filter(({ strikes }) => strikes.length > 0);
}
