import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { fetchPooledPricesOnly, fetchPricesPoolFirst, streamPooledPrices } from "../ibkr/pricePool.js";
import { dedupeInFlight } from "./dedupeInFlight.js";
import { loadFallbackStockPrices } from "./priceService.js";
import { sleepUnlessAborted } from "./sleepUnlessAborted.js";

// Position "exposure"/"value" = full market value across every open leg
// (stock + option together), option legs priced as a liability at their
// mark (bid/ask mid, else last: optionMarkPrice via pricePool.ts) — the
// platform-wide valuation standard (decided 2026-08-28, see
// project_position_valuation_full_market_value memory). Single source of
// truth shared by riskLimits.ts (concentration/allocation limits) and
// dashboard.ts (Portfolio section, Allocation card). A leg with no live
// quote (e.g. an option that has not traded, outside market hours) is
// valued by legPriceOf (shares at the stock's last recorded price, then the
// contract's latest nightly close, then the entry price) rather than
// dropping the position from every view.
interface OpenLegRow {
  legId: string;
  positionId: string;
  strategyKey: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entryPrice: string;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  symbol: string;
  /** The position's ticker (the books' leg ownership, src/books). */
  tickerId?: string;
  /** The contract's latest nightly closing price (position_leg_price_snapshots); null/absent when it has none yet. */
  lastClosingPrice?: string | null;
  /** Stock legs: the last price recorded for the stock (priceService), loaded only for a leg without a live price. */
  storedStockPrice?: number | null;
}

export type LegPriceSource = "live" | "lastKnown" | "lastClose" | "entry";

/**
 * Pure: the price a leg is valued at, and where it came from: a live price, else (shares) the last price recorded for the
 * stock, else the contract's last nightly close, else the leg's entry price. Example: NVDA shares with no live price, last
 * recorded at 147.90 a minute ago, entry 169.85 → 147.90 ("lastKnown"), not the entry price.
 */
export function legPriceOf(leg: OpenLegRow, livePrice: number | null | undefined): { price: number; priceSource: LegPriceSource } {
  if (livePrice !== null && livePrice !== undefined) return { price: livePrice, priceSource: "live" };
  if (leg.legType === "stock" && leg.storedStockPrice !== null && leg.storedStockPrice !== undefined) return { price: leg.storedStockPrice, priceSource: "lastKnown" };
  if (leg.lastClosingPrice !== null && leg.lastClosingPrice !== undefined) return { price: Number(leg.lastClosingPrice), priceSource: "lastClose" };
  return { price: Number(leg.entryPrice), priceSource: "entry" };
}

/** The stock legs without a live price get their stock's last recorded price (never throws: priceService logs a failed read). */
async function withStoredStockPrices(legs: OpenLegRow[], pricesByKey: Record<string, number | null>): Promise<OpenLegRow[]> {
  const unpriced = legs.filter((leg, index) => leg.legType === "stock" && (pricesByKey[String(index)] ?? null) === null);
  if (unpriced.length === 0) return legs;
  const stored = await loadFallbackStockPrices(unpriced.map((leg) => leg.symbol));
  return legs.map((leg) => (leg.legType === "stock" && stored.has(leg.symbol) ? { ...leg, storedStockPrice: stored.get(leg.symbol)!.price } : leg));
}

function warnLivePricesUnavailable(caller: string, legCount: number, error: unknown): void {
  console.warn(`${caller}: live prices unavailable for ${legCount} leg(s), valued at stored prices — ${error instanceof Error ? error.message : String(error)}`);
}

export interface PositionExposureRow {
  positionId: string;
  strategyKey: string;
  symbol: string;
  sector: string;
  exposure: number;
}

// The cash reserved to cover assignment on open cash-secured puts — same
// figure embedded inside a CSP's exposure above, exposed separately since
// "cash locked" (a cash-availability question) and "position exposure" (a
// valuation question) are asked by different callers (Available Cash,
// Portfolio section, Order Review cash-sufficiency).
export async function computeCashLockedInCsps(): Promise<number> {
  const result = await db.raw(`
    SELECT COALESCE(SUM(
      (SELECT pl.strike_price * pl.multiplier * pl.quantity
       FROM position_legs pl
       WHERE pl.position_id = p.id AND pl.leg_type = 'option'
       ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
       LIMIT 1)
    ), 0) AS reserved
    FROM positions p
    WHERE p.status = 'open' AND p.strategy_key = 'cash_secured_put'
  `);
  return Number(result.rows[0]?.reserved ?? 0);
}

// Deduplicated (see dedupeInFlight.ts) — /dashboard/portfolio and
// /risk-limits/exposure both call this with no arguments, and load together
// on the Dashboard.
export const computePositionExposures = dedupeInFlight(computePositionExposuresUncached);

interface OpenPositionRow {
  positionId: string;
  strategyKey: string;
  symbol: string;
  sector: string;
}

async function resolveOpenPositionsAndLegs(symbol?: string): Promise<{ positions: OpenPositionRow[]; legs: OpenLegRow[] }> {
  const positions: OpenPositionRow[] = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .modify((builder) => {
      if (symbol !== undefined) builder.where("t.symbol", symbol);
    })
    .select("p.id as positionId", "p.strategy_key as strategyKey", "t.symbol", db.raw("COALESCE(NULLIF(t.sector, ''), 'Unknown') AS sector"));

  if (positions.length === 0) return { positions, legs: [] };

  const legs: OpenLegRow[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .modify((builder) => {
      if (symbol !== undefined) builder.where("t.symbol", symbol);
    })
    .whereNull("pl.exit_at")
    .select(
      "pl.id as legId",
      "pl.position_id as positionId",
      "p.strategy_key as strategyKey",
      "pl.leg_type as legType",
      "pl.side",
      "pl.quantity",
      "pl.multiplier",
      "pl.entry_price as entryPrice",
      "pl.option_type as optionType",
      "pl.strike_price as strikePrice",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as \"expiryDate\""),
      "t.symbol",
      "p.ticker_id as tickerId",
      // The contract's latest nightly close, from any leg of it: reconciliation starts a new leg whenever shares move
      // between positions, and a leg started today has no close of its own yet.
      db.raw(
        `(SELECT lps.price FROM position_leg_price_snapshots lps JOIN position_legs same_contract ON same_contract.id = lps.position_leg_id
          WHERE same_contract.id = pl.id OR (pl.ibkr_contract_id IS NOT NULL AND same_contract.ibkr_contract_id = pl.ibkr_contract_id)
          ORDER BY lps.snapshot_date DESC, lps.captured_at DESC LIMIT 1) AS "lastClosingPrice"`,
      ),
    );

  return { positions, legs };
}

export function legsToPriceContracts(legs: OpenLegRow[]): PriceContract[] {
  return legs.map((leg, index) => ({
    key: String(index),
    legType: leg.legType,
    symbol: leg.symbol,
    expiry: leg.expiryDate ?? undefined,
    strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
    right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
  }));
}

// Pure function of whatever prices are currently known — a leg with no
// price yet falls back to a stored price (legPriceOf), so this always produces a full result. Used both by the one-shot computePositionExposures below and by
// streamPositionExposures, called again on every price update; since a
// missing price already defaults to a stored price rather than showing
// nothing, there's no "regress to null" risk the way greeks/pnl have to
// guard against — every update only ever gets more accurate as more real
// prices arrive.
export function computeExposureRows(positions: OpenPositionRow[], legs: OpenLegRow[], pricesByKey: Record<string, number | null>): PositionExposureRow[] {
  const exposureByPositionId = new Map<string, number>();
  legs.forEach((leg, index) => {
    const { price } = legPriceOf(leg, pricesByKey[String(index)]);
    const sign = leg.side === "short" ? -1 : 1;
    let legValue = price * leg.quantity * leg.multiplier * sign;

    // A CSP has no "cash" leg of its own — the collateral behind the short
    // put is only implicit in the strike, never a row in position_legs. Add
    // it explicitly so CSP exposure reflects the cash actually locked, not
    // just the option's own (much smaller) market value.
    if (leg.strategyKey === "cash_secured_put" && leg.legType === "option" && leg.strikePrice !== null) {
      legValue += Number(leg.strikePrice) * leg.multiplier * leg.quantity;
    }

    exposureByPositionId.set(leg.positionId, (exposureByPositionId.get(leg.positionId) ?? 0) + legValue);
  });

  return positions.map((p) => ({
    positionId: p.positionId,
    strategyKey: p.strategyKey,
    symbol: p.symbol,
    sector: p.sector,
    exposure: exposureByPositionId.get(p.positionId) ?? 0,
  }));
}

export interface OpenLegMarketValue {
  legId: string;
  positionId: string;
  strategyKey: string;
  tickerId: string;
  symbol: string;
  legType: "stock" | "option";
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  /** YYYYMMDD, options only. */
  expiryDate: string | null;
  quantity: number;
  /** The price the leg is valued at, and where it came from (legPriceOf). */
  price: number;
  priceSource: LegPriceSource;
  /** The leg's market value at its mark, a short leg negative: what the books count as the position's worth (no Put collateral, which is cash). */
  marketValue: number;
}

/** Pure: each open leg's market value, priced as computeExposureRows prices it (legPriceOf). */
export function computeLegMarketValues(legs: OpenLegRow[], pricesByKey: Record<string, number | null>): OpenLegMarketValue[] {
  return legs.map((leg, index) => {
    const { price, priceSource } = legPriceOf(leg, pricesByKey[String(index)]);
    return {
      legId: leg.legId,
      positionId: leg.positionId,
      strategyKey: leg.strategyKey,
      tickerId: leg.tickerId ?? "",
      symbol: leg.symbol,
      legType: leg.legType,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice === null ? null : Number(leg.strikePrice),
      expiryDate: leg.expiryDate,
      quantity: Number(leg.quantity),
      price,
      priceSource,
      marketValue: price * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1),
    };
  });
}

/** Every open leg's market value now (pool first, as the one-shot exposures). */
export async function loadOpenLegMarketValues(): Promise<OpenLegMarketValue[]> {
  const { legs } = await resolveOpenPositionsAndLegs();
  if (legs.length === 0) return [];
  let pricesByKey: Record<string, number | null> = {};
  try {
    pricesByKey = await fetchPricesPoolFirst(legsToPriceContracts(legs), { settleGraceMs: exposurePriceSettleGraceMs });
  } catch (error) {
    warnLivePricesUnavailable("loadOpenLegMarketValues", legs.length, error);
  }
  return computeLegMarketValues(await withStoredStockPrices(legs, pricesByKey), pricesByKey);
}

// The one-shot exposures (Dashboard, Risk & Limits) stop waiting this long after the last leg price arrived: a leg that
// never gets a price (no last trade, nor an option's two-sided quote) is valued at its closing or entry price either way, and used to hold them to the 6 s ceiling.
// A grace after the latest arrival, not a flat cap, so a slow leg that is still pricing is not cut off.
const exposurePriceSettleGraceMs = 1_000;

// Pool first (2026-09-24): legs already held by an open Positions/Pulse/
// Dashboard stream are priced from the pool with no IBKR request at all;
// only legs nobody has pooled fall back to a one-shot snapshot. The Signals
// order-limit check calls this on every debounced keystroke, on confirm and
// every 10s from the Order Review quote stream, so this is what keeps those
// from opening a snapshot per open leg each time.
async function computePositionExposuresUncached(): Promise<PositionExposureRow[]> {
  const { positions, legs } = await resolveOpenPositionsAndLegs();
  if (positions.length === 0) return [];

  let pricesByKey: Record<string, number | null> = {};
  try {
    pricesByKey = await fetchPricesPoolFirst(legsToPriceContracts(legs), { settleGraceMs: exposurePriceSettleGraceMs });
  } catch (error) {
    warnLivePricesUnavailable("computePositionExposures", legs.length, error);
  }

  return computeExposureRows(positions, await withStoredStockPrices(legs, pricesByKey), pricesByKey);
}

// How long the order-limits check waits for a leg's price before valuing that leg at its closing or entry price. A leg that never
// ticks (a thin LEAP) otherwise holds the whole snapshot to its 6 s ceiling, and the check runs on every form edit,
// every 10 s of an open Order Review and on confirm.
const tickerExposurePriceTimeoutMs = 1_500;

/**
 * One ticker's total exposure, for the Signals order-limits check and Pluto's rounds: only that ticker's open legs are
 * priced, so another ticker's illiquid leg cannot stall it. Stock legs: pool first, then a snapshot capped at
 * tickerExposurePriceTimeoutMs. Option legs (Marcelo 2026-11-11): the pool only, never a snapshot; one nobody streams is
 * valued at the contract's last closing price, else its entry price (legPriceOf). A short option's value is small next to
 * the shares it covers, and its snapshots went unanswered by the thousand (a same-day Call never ticks).
 */
export async function computeTickerExposure(symbol: string): Promise<number> {
  const { positions, legs } = await resolveOpenPositionsAndLegs(symbol);
  if (positions.length === 0) return 0;

  const contracts = legsToPriceContracts(legs);
  let pricesByKey: Record<string, number | null> = fetchPooledPricesOnly(contracts.filter((contract) => contract.legType === "option"));
  try {
    Object.assign(pricesByKey, await fetchPricesPoolFirst(contracts.filter((contract) => contract.legType !== "option"), { snapshotTimeoutMs: tickerExposurePriceTimeoutMs }));
  } catch (error) {
    warnLivePricesUnavailable(`computeTickerExposure(${symbol})`, legs.length, error);
  }
  return computeExposureRows(positions, await withStoredStockPrices(legs, pricesByKey), pricesByKey).reduce((sum, row) => sum + row.exposure, 0);
}

/** While no position is open, the stream stays up and re-reads this often (an empty reading each time, so the caller can refresh its account figures). */
export const noOpenPositionsRecheckIntervalMs = 60_000;

/**
 * Loads open positions; while there are none, calls `onEmpty`, waits `recheckIntervalMs` and loads again.
 * Returns the first non-empty load, or null if `signal` aborts first. Ending instead would make every browser
 * re-subscribe on its backoff, re-running the caller's setup (an IBKR account read) each time.
 */
export async function waitForOpenPositions<T extends { positions: unknown[] }>(
  load: () => Promise<T>,
  onEmpty: () => void,
  recheckIntervalMs: number,
  signal: AbortSignal,
): Promise<T | null> {
  for (;;) {
    const loaded = await load();
    if (signal.aborted) return null;
    if (loaded.positions.length > 0) return loaded;
    onEmpty();
    await sleepUnlessAborted(recheckIntervalMs, signal);
    if (signal.aborted) return null;
  }
}

/**
 * Live-upgrading variant for the SSE-backed Dashboard/Risk & Limits screens
 * (approved 2026-09-09): emits exposure rows computed from FROZEN prices
 * first, then keeps recomputing and re-emitting as streamLivePrices reports
 * genuinely new live prices, until `signal` aborts. See streamLivePrices.ts
 * for the FROZEN-then-REALTIME mechanics.
 */
export async function streamPositionExposures(onUpdate: (rows: PositionExposureRow[]) => void, signal: AbortSignal): Promise<void> {
  const open = await waitForOpenPositions(resolveOpenPositionsAndLegs, () => onUpdate([]), noOpenPositionsRecheckIntervalMs, signal);
  if (open === null) return;
  const { positions, legs } = open;

  // Hold the first reading until every leg has a price or the frozen phase
  // has ended (approved 2026-09-19). Without this, legs not yet priced fall
  // back to a stored price and the first ~0.5s shows wrong totals that then
  // jump (Dashboard covered calls read 29,443 -> 29,725). After the first
  // reading every update goes out as before.
  let hasEmitted = false;
  await streamPooledPrices(
    legsToPriceContracts(legs),
    (pricesByKey, { frozenPhaseComplete }) => {
      const everyLegPriced = legs.every((_, index) => pricesByKey[String(index)] !== null && pricesByKey[String(index)] !== undefined);
      if (!hasEmitted && !everyLegPriced && !frozenPhaseComplete) return;
      hasEmitted = true;
      onUpdate(computeExposureRows(positions, legs, pricesByKey));
    },
    signal,
  );
}
