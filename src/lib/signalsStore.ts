import { db } from "../db/connection.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import { easternDateIso } from "./marketSessionStatus.js";
import type { SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import { computeUncompensatedByContract, scoreTicker, toScreenRow } from "./signalsLiveScoring.js";
import type { RoadmapCounts } from "./signalsRoadmap.js";
import type { AccountContext, PreviousClose, SignalsScreenRow, SnapshotHeader, TickerSignals, TickerSignalsInputs } from "./signalsTypes.js";
import { loadVolatilityForecast } from "./volatilityForecastStore.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew } from "./tiltMeasures.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";

// DB side of the Signals screen (mockup approved 2026-09-22). Loads one ticker's
// inputs once (loadTickerSignalsInputs); scoring itself is the pure scoreTicker in
// signalsLiveScoring.ts, so the REST routes and the live producers score the exact
// same way. Shares out for a covered call, and cash out for a cash-secured put, use
// the same live account/position queries the existing Trade Alerts flow uses.

export async function loadAccountContext(): Promise<AccountContext> {
  const [account, cashLockedInCsps] = await Promise.all([fetchAccountSummary(), computeCashLockedInCsps()]);
  const totalCashValue = account.totalCashValue ?? 0;
  return { freeCash: Math.max(0, totalCashValue - cashLockedInCsps) };
}

async function loadBarsForTilt(tickerId: string, asOfDateIso: string): Promise<DailyOhlcvBar[]> {
  const rows: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text <= ?", [asOfDateIso])
    .orderBy("trading_date", "desc")
    .limit(1500)
    .select(db.raw('trading_date::text as "tradingDate"'), db.raw("open_price as open"), db.raw("high_price as high"), db.raw("low_price as low"), db.raw("close_price as close"), "volume");
  return rows
    .filter((row) => row.open !== null && row.high !== null && row.low !== null && row.close !== null)
    .reverse()
    .map((row) => ({ tradingDate: row.tradingDate, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0) }));
}

/** The last stored close strictly before today's Eastern session date (decided 2026-09-22: bars, not IBKR's tick 9). */
export async function loadPreviousClose(tickerId: string, todayEasternIso: string): Promise<PreviousClose | null> {
  const row = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text < ?", [todayEasternIso])
    .whereNotNull("close_price")
    .orderBy("trading_date", "desc")
    .select(db.raw('trading_date::text as "dateIso"'), "close_price as close")
    .first();
  return row ? { close: Number(row.close), dateIso: row.dateIso } : null;
}

async function loadNextEarningsDate(tickerId: string, todayIso: string): Promise<string | null> {
  const row = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "earnings" })
    .where("event_date", ">=", todayIso)
    .orderBy("event_date")
    .select(db.raw('event_date::text as "eventDate"'))
    .first();
  return row?.eventDate ?? null;
}

export async function loadEarningsDatesForForecastWindow(tickerId: string): Promise<string[]> {
  // Only ever one past + one future row is kept by the calendar capture, but querying without a date
  // filter keeps this correct if that ever changes -- expirySpansEarnings only looks forward anyway.
  const rows: { eventDate: string }[] = await db("ticker_calendar_events").where({ ticker_id: tickerId, event_type: "earnings" }).select(db.raw('event_date::text as "eventDate"'));
  return rows.map((row) => row.eventDate);
}

export async function loadLatestSnapshot(tickerId: string): Promise<SnapshotHeader | null> {
  const row = await db("option_chain_snapshots")
    .where({ ticker_id: tickerId })
    .whereIn("status", ["complete", "partial"])
    .orderBy("trading_date", "desc")
    .select("id as snapshotId", db.raw('trading_date::text as "tradingDateIso"'), "captured_at as capturedAt", "underlying_price as underlyingPrice", "risk_free_rate_percent as riskFreeRatePercent")
    .first();
  if (!row) return null;
  return { snapshotId: row.snapshotId, tradingDateIso: row.tradingDateIso, capturedAt: row.capturedAt, underlyingPrice: row.underlyingPrice === null ? null : Number(row.underlyingPrice), riskFreeRatePercent: row.riskFreeRatePercent === null ? null : Number(row.riskFreeRatePercent) };
}

export async function loadSlices(snapshotId: string): Promise<SignalSurfaceSlice[]> {
  const rows = await db("option_surface_fits")
    .where({ snapshot_id: snapshotId })
    .select(db.raw('expiry::text as expiry'), "status", "years_to_expiry as yearsToExpiry", "forward_price as forwardPrice", "k_min as kMin", "k_max as kMax", "param_a as a", "param_b as b", "param_rho as rho", "param_m as m", "param_sigma as sigma");
  return rows.map((row) => ({
    expiry: row.expiry,
    status: row.status,
    yearsToExpiry: Number(row.yearsToExpiry),
    forwardPrice: Number(row.forwardPrice),
    kMin: row.kMin === null ? null : Number(row.kMin),
    kMax: row.kMax === null ? null : Number(row.kMax),
    parameters: row.a === null ? null : { a: Number(row.a), b: Number(row.b), rho: Number(row.rho), m: Number(row.m), sigma: Number(row.sigma) },
  }));
}

export async function loadQuotes(snapshotId: string): Promise<SignalQuote[]> {
  const rows = await db("option_quote_snapshots")
    .where({ snapshot_id: snapshotId })
    .select(db.raw('expiry::text as expiry'), "strike", db.raw('option_right as "right"'), "bid", "ask");
  return rows.map((row) => ({ expiry: row.expiry, strike: Number(row.strike), right: row.right, bid: row.bid === null ? null : Number(row.bid), ask: row.ask === null ? null : Number(row.ask), source: "snapshot" as const }));
}

export interface ShortlistTickerRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
}

export async function loadShortlistTickers(): Promise<ShortlistTickerRow[]> {
  return db("shortlist_entries as se")
    .join("tickers as t", "t.id", "se.ticker_id")
    .whereNull("se.removed_at")
    .select("t.id as tickerId", "t.symbol", "t.company_name as companyName", db.raw("NULLIF(t.sector, '') as sector"))
    .orderBy("t.symbol");
}

export async function loadShortlistTicker(symbol: string): Promise<ShortlistTickerRow | null> {
  const row = await db("shortlist_entries as se")
    .join("tickers as t", "t.id", "se.ticker_id")
    .whereNull("se.removed_at")
    .where("t.symbol", symbol.toUpperCase())
    .select("t.id as tickerId", "t.symbol", "t.company_name as companyName", db.raw("NULLIF(t.sector, '') as sector"))
    .first();
  return row ?? null;
}

/** Everything scoring needs for one ticker, from the DB only (no IBKR). Loaded once per REST call or stream start. */
export async function loadTickerSignalsInputs(ticker: ShortlistTickerRow, now: Date = new Date()): Promise<TickerSignalsInputs> {
  const todayEastern = easternDateIso(now);
  const [bars, nextEarningsDateIso, earningsDatesIso, previousClose, header, freeShares, dailyBarCount, hasDividendEvents] = await Promise.all([
    loadBarsForTilt(ticker.tickerId, todayEastern),
    loadNextEarningsDate(ticker.tickerId, todayEastern),
    loadEarningsDatesForForecastWindow(ticker.tickerId),
    loadPreviousClose(ticker.tickerId, todayEastern),
    loadLatestSnapshot(ticker.tickerId),
    fetchAvailableUncoveredShares(ticker.tickerId),
    db("daily_price_bars").where({ ticker_id: ticker.tickerId }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    db("ticker_calendar_events").where({ ticker_id: ticker.tickerId, event_type: "ex_dividend" }).first("id").then((row) => row !== undefined),
  ]);
  const momentum = computeMomentum(bars.map((bar) => bar.close));
  const elevatedVolatility = computeElevatedVolatilityFlag(bars);

  const [slices, quotes, forecast] = header
    ? await Promise.all([loadSlices(header.snapshotId), loadQuotes(header.snapshotId), loadVolatilityForecast(ticker.tickerId, header.tradingDateIso)])
    : [[], [], null];

  return { ...ticker, header, slices, quotes, forecast, earningsDatesIso, momentum, elevatedVolatility, skew: computeSkew(slices), nextEarningsDateIso, previousClose, freeShares, dailyBarCount, hasDividendEvents, todayEasternIso: todayEastern };
}

/** One ticker, snapshot prices, with the Monte Carlo attached (REST first paint for the modal). */
export async function loadTickerSignals(ticker: ShortlistTickerRow, accountContext: AccountContext, options: { withUncompensatedShare?: boolean } = {}): Promise<TickerSignals> {
  const inputs = await loadTickerSignalsInputs(ticker);
  const scored = scoreTicker(inputs, accountContext);
  if (!options.withUncompensatedShare || !inputs.header?.underlyingPrice || scored.candidates.length === 0) return scored;
  const uncompensatedByContract = computeUncompensatedByContract(scored.candidates, inputs.header.underlyingPrice, inputs.slices);
  return scoreTicker(inputs, accountContext, { spotPrice: inputs.header.underlyingPrice, priceSource: "snapshot", uncompensatedByContract });
}

/** The counts the roadmap's ETAs are projected from. */
export async function loadRoadmapCounts(now: Date = new Date()): Promise<RoadmapCounts> {
  const todayEastern = easternDateIso(now);
  const [snapshotNights, fittedNights, leastCoveredTicker, signalsOrderFills] = await Promise.all([
    db("option_chain_snapshots").whereIn("status", ["complete", "partial"]).countDistinct<{ count: string }[]>("trading_date as count").then((rows) => Number(rows[0]?.count ?? 0)),
    db("option_surface_fits as f").join("option_chain_snapshots as s", "s.id", "f.snapshot_id").where("f.status", "ok").countDistinct<{ count: string }[]>("s.trading_date as count").then((rows) => Number(rows[0]?.count ?? 0)),
    // Only tickers that report at all (an ETF has no earnings and would otherwise pin the minimum at 0 forever).
    db("shortlist_entries as se")
      .whereNull("se.removed_at")
      .whereExists(db("ticker_calendar_events as any_earnings").whereRaw("any_earnings.ticker_id = se.ticker_id").where("any_earnings.event_type", "earnings"))
      .select(db.raw("(SELECT count(*) FROM ticker_calendar_events e WHERE e.ticker_id = se.ticker_id AND e.event_type = 'earnings' AND e.event_date < ?) AS past_earnings", [todayEastern]))
      .orderBy("past_earnings")
      .first<{ past_earnings: string } | undefined>(),
    db("order_requests").whereNotNull("signal_snapshot").whereIn("status", ["filled", "partially_filled"]).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
  ]);
  return {
    snapshotNights,
    fittedNights,
    minimumPastEarningsPerTicker: leastCoveredTicker ? Number(leastCoveredTicker.past_earnings) : 0,
    signalsOrderFills,
  };
}

/** The whole Signals screen at snapshot prices: one account-context fetch shared across every ticker, no candidate lists. */
export async function loadSignalsScreen(): Promise<SignalsScreenRow[]> {
  const [tickers, accountContext] = await Promise.all([loadShortlistTickers(), loadAccountContext()]);
  const inputs = await Promise.all(tickers.map((ticker) => loadTickerSignalsInputs(ticker)));
  return inputs.map((tickerInputs) => toScreenRow(scoreTicker(tickerInputs, accountContext)));
}
