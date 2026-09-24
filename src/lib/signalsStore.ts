import { db } from "../db/connection.js";
import { isRegularDividendCadence } from "./impliedVolatilitySurface.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import { easternDateIso } from "./marketSessionStatus.js";
import type { SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import { computeUncompensatedByContract, scoreTicker, toScreenRow, type LiveOptionQuote } from "./signalsLiveScoring.js";
import { loadDayQuotesForTicker } from "./daySignalsStore.js";
import { loadUpcomingMajorMacroEvents } from "./macroEventCalendar.js";
import type { RoadmapCounts } from "./signalsRoadmap.js";
import { loadSignalSettings } from "./signalSettingsStore.js";
import type { AccountContext, PreviousClose, SignalsScreenRow, SnapshotHeader, TickerSignalsDetail, TickerSignalsInputs } from "./signalsTypes.js";
import { loadVolatilityForecast } from "./volatilityForecastStore.js";
import type { OpenShortLeg } from "./rollSignalCandidates.js";
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

export async function loadNextEarningsDate(tickerId: string, todayIso: string): Promise<string | null> {
  const row = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "earnings" })
    .where("event_date", ">=", todayIso)
    .orderBy("event_date")
    .select(db.raw('event_date::text as "eventDate"'))
    .first();
  return row?.eventDate ?? null;
}

/** True when there is an upcoming ex-dividend but no regular cadence could be inferred to project later ones into the forward (Formula: see impliedVolatilitySurface.ts projectDividendSchedule, approved 2026-09-23). */
export async function loadDividendCadenceUnknown(tickerId: string, todayIso: string): Promise<boolean> {
  const [next, past] = await Promise.all([
    db("ticker_calendar_events")
      .where({ ticker_id: tickerId, event_type: "ex_dividend" })
      .where("event_date", ">=", todayIso)
      .orderBy("event_date")
      .select(db.raw('event_date::text as "date"'), "amount")
      .first(),
    db("ticker_calendar_events")
      .where({ ticker_id: tickerId, event_type: "ex_dividend" })
      .where("event_date", "<", todayIso)
      .orderBy("event_date", "desc")
      .select(db.raw('event_date::text as "date"'), "amount")
      .first(),
  ]);
  if (!next) return false;
  return !isRegularDividendCadence({ date: next.date, amount: Number(next.amount) }, past ? { date: past.date, amount: Number(past.amount) } : null);
}

export async function loadEarningsDatesForForecastWindow(tickerId: string): Promise<string[]> {
  // Only ever one past + one future row is kept by the calendar capture, but querying without a date
  // filter keeps this correct if that ever changes -- expirySpansEarnings only looks forward anyway.
  const rows: { eventDate: string }[] = await db("ticker_calendar_events").where({ ticker_id: tickerId, event_type: "earnings" }).select(db.raw('event_date::text as "eventDate"'));
  return rows.map((row) => row.eventDate);
}

/** Same "resolved" check calendarConflict.ts uses: no TradingView symbol means earningsDatesIso is necessarily empty regardless of what's actually scheduled. */
export async function loadEarningsCalendarResolved(tickerId: string): Promise<boolean> {
  const row = await db("tickers").where({ id: tickerId }).first("tradingview_ticker");
  return !!row?.tradingview_ticker;
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
    .select(
      db.raw('expiry::text as expiry'),
      "status",
      "years_to_expiry as yearsToExpiry",
      "forward_price as forwardPrice",
      "k_min as kMin",
      "k_max as kMax",
      "param_a as a",
      "param_b as b",
      "param_rho as rho",
      "param_m as m",
      "param_sigma as sigma",
      "point_count as pointCount",
      "rmse_volatility as rmseVolatility",
      "min_butterfly_density as minButterflyDensity",
      "dropped_counts as droppedCounts",
      "calendar_checks as calendarChecks",
      "calendar_violations as calendarViolations",
    );
  return rows.map((row) => ({
    expiry: row.expiry,
    status: row.status,
    yearsToExpiry: Number(row.yearsToExpiry),
    forwardPrice: Number(row.forwardPrice),
    kMin: row.kMin === null ? null : Number(row.kMin),
    kMax: row.kMax === null ? null : Number(row.kMax),
    parameters: row.a === null ? null : { a: Number(row.a), b: Number(row.b), rho: Number(row.rho), m: Number(row.m), sigma: Number(row.sigma) },
    pointCount: row.pointCount,
    rmseVolatility: row.rmseVolatility === null ? null : Number(row.rmseVolatility),
    minButterflyDensity: row.minButterflyDensity === null ? null : Number(row.minButterflyDensity),
    droppedCounts: row.droppedCounts,
    calendarChecks: row.calendarChecks,
    calendarViolations: row.calendarViolations,
  }));
}

export async function loadQuotes(snapshotId: string): Promise<SignalQuote[]> {
  const rows = await db("option_quote_snapshots")
    .where({ snapshot_id: snapshotId })
    .select(db.raw('expiry::text as expiry'), "strike", db.raw('option_right as "right"'), "bid", "ask");
  return rows.map((row) => ({ expiry: row.expiry, strike: Number(row.strike), right: row.right, bid: row.bid === null ? null : Number(row.bid), ask: row.ask === null ? null : Number(row.ask), source: "snapshot" as const }));
}

export interface SignalsTickerRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
}

// The Signals universe: the shortlist plus every ticker with an open short
// option leg (Roll Signals, 2026-09-24) -- a position on a ticker removed
// from the shortlist still needs its roll scored.
function signalsUniverseQuery() {
  return db("tickers as t")
    .where((builder) =>
      builder
        .whereIn("t.id", db("shortlist_entries").whereNull("removed_at").select("ticker_id"))
        .orWhereIn("t.id", openShortLegPositionsQuery().select("p.ticker_id")),
    )
    .select("t.id as tickerId", "t.symbol", "t.company_name as companyName", db.raw("NULLIF(t.sector, '') as sector"));
}

function openShortLegPositionsQuery() {
  return db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.status": "open", "pl.leg_type": "option", "pl.side": "short" })
    .whereIn("p.strategy_key", ["covered_call", "cash_secured_put"])
    .whereNull("pl.exit_at");
}

export async function loadSignalsUniverseTickers(): Promise<SignalsTickerRow[]> {
  return signalsUniverseQuery().orderBy("t.symbol");
}

export async function loadSignalsUniverseTicker(symbol: string): Promise<SignalsTickerRow | null> {
  const row = await signalsUniverseQuery().where("t.symbol", symbol.toUpperCase()).first();
  return row ?? null;
}

/** Every open short option leg on a covered-call or cash-secured-put position of this ticker (Roll Signals' A side). */
export async function loadOpenShortLegs(tickerId: string): Promise<OpenShortLeg[]> {
  const rows: { legId: string; positionId: string; strategyKey: string; expiry: string; strike: string; optionType: "call" | "put"; quantity: number; entryPrice: string; entryAt: Date }[] = await openShortLegPositionsQuery()
    .where("p.ticker_id", tickerId)
    .select("pl.id as legId", "p.id as positionId", "p.strategy_key as strategyKey", db.raw('pl.expiry_date::text as expiry'), "pl.strike_price as strike", "pl.option_type as optionType", "pl.quantity", "pl.entry_price as entryPrice", "pl.entry_at as entryAt")
    .orderBy(["pl.expiry_date", "pl.strike_price"]);
  return rows.map((row) => ({
    legId: row.legId,
    positionId: row.positionId,
    strategyKey: row.strategyKey as OpenShortLeg["strategyKey"],
    expiry: row.expiry,
    strike: Number(row.strike),
    right: row.optionType === "call" ? "C" : "P",
    quantity: Number(row.quantity),
    entryPrice: Number(row.entryPrice),
    entryAtIso: new Date(row.entryAt).toISOString(),
  }));
}

/** Everything scoring needs for one ticker, from the DB only (no IBKR). Loaded once per REST call or stream start. */
export async function loadTickerSignalsInputs(ticker: SignalsTickerRow, now: Date = new Date()): Promise<TickerSignalsInputs> {
  const todayEastern = easternDateIso(now);
  const [bars, nextEarningsDateIso, earningsDatesIso, earningsCalendarResolved, previousClose, header, freeShares, dailyBarCount, dividendCadenceUnknown, macroEvents, openShortLegs] = await Promise.all([
    loadBarsForTilt(ticker.tickerId, todayEastern),
    loadNextEarningsDate(ticker.tickerId, todayEastern),
    loadEarningsDatesForForecastWindow(ticker.tickerId),
    loadEarningsCalendarResolved(ticker.tickerId),
    loadPreviousClose(ticker.tickerId, todayEastern),
    loadLatestSnapshot(ticker.tickerId),
    fetchAvailableUncoveredShares(ticker.tickerId),
    db("daily_price_bars").where({ ticker_id: ticker.tickerId }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    loadDividendCadenceUnknown(ticker.tickerId, todayEastern),
    loadUpcomingMajorMacroEvents(),
    loadOpenShortLegs(ticker.tickerId),
  ]);
  const momentum = computeMomentum(bars.map((bar) => bar.close));
  const elevatedVolatility = computeElevatedVolatilityFlag(bars);

  const [slices, quotes, forecastSelection, dayQuotes] = header
    ? await Promise.all([loadSlices(header.snapshotId), loadQuotes(header.snapshotId), loadVolatilityForecast(ticker.tickerId, header.tradingDateIso), loadDayQuotesAsLiveQuotes(ticker.tickerId, header.tradingDateIso)])
    : [[], [], { forecast: null, suspectedSplitDateIso: null }, []];

  return { ...ticker, header, slices, quotes, dayQuotes, forecast: forecastSelection.forecast, suspectedSplitDateIso: forecastSelection.suspectedSplitDateIso, earningsDatesIso, earningsCalendarResolved, macroEvents, momentum, elevatedVolatility, skew: computeSkew(slices), nextEarningsDateIso, previousClose, freeShares, openShortLegs, dailyBarCount, dividendCadenceUnknown, todayEasternIso: todayEastern };
}

/** The Day Signals loop's quotes for one ticker, only when they belong to the snapshot date being scored (contracts that errored carry no quote). */
export async function loadDayQuotesAsLiveQuotes(tickerId: string, snapshotTradingDateIso: string): Promise<LiveOptionQuote[]> {
  const rows = await loadDayQuotesForTicker(tickerId, snapshotTradingDateIso);
  return rows.filter((row) => row.errorCode === null).map((row) => ({ expiry: row.expiry, strike: row.strike, right: row.right, bid: row.bid, ask: row.ask, quotedAt: row.quotedAt }));
}

/** One ticker, snapshot prices, with the Monte Carlo attached (REST first paint for the modal). Includes the raw
 * fitted-surface slices (unscaled by live spot) for the volatility-surface modal. */
export async function loadTickerSignals(ticker: SignalsTickerRow, accountContext: AccountContext, options: { withUncompensatedShare?: boolean } = {}): Promise<TickerSignalsDetail> {
  const [inputs, settings] = await Promise.all([loadTickerSignalsInputs(ticker), loadSignalSettings()]);
  const scored = scoreTicker(inputs, accountContext, settings);
  if (!options.withUncompensatedShare || !inputs.header?.underlyingPrice || scored.candidates.length === 0) return { ...scored, slices: inputs.slices };
  const uncompensatedByContract = computeUncompensatedByContract(scored.candidates, inputs.header.underlyingPrice, inputs.slices);
  const rescored = scoreTicker(inputs, accountContext, settings, { spotPrice: inputs.header.underlyingPrice, priceSource: "snapshot", uncompensatedByContract });
  return { ...rescored, slices: inputs.slices };
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
    // Open orders only: a roll's fill is a different friction sample (two legs, one combo), so it is counted apart (decided 2026-09-24).
    db("order_requests").whereNotNull("signal_snapshot").where("request_type", "like", "open_%").whereIn("status", ["filled", "partially_filled"]).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
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
  const [tickers, accountContext, settings] = await Promise.all([loadSignalsUniverseTickers(), loadAccountContext(), loadSignalSettings()]);
  const inputs = await Promise.all(tickers.map((ticker) => loadTickerSignalsInputs(ticker)));
  return inputs.map((tickerInputs) => toScreenRow(scoreTicker(tickerInputs, accountContext, settings)));
}
