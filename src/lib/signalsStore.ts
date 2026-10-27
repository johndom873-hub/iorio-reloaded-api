import { db } from "../db/connection.js";
import { isRegularDividendCadence } from "./impliedVolatilitySurface.js";
import { fetchAccountSummary, type AccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import type { SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import { computeUncompensatedByContract, scoreTicker, toScreenRow, type LiveOptionQuote } from "./signalsLiveScoring.js";
import { loadDayQuotesForTicker } from "./daySignalsStore.js";
import { loadUpcomingMajorMacroEvents } from "./macroEventCalendar.js";
import { addCalendarDays, type RoadmapCounts } from "./signalsRoadmap.js";
import { loadOpenDaysBetween, loadTradingSessionsBetween } from "./marketSessionStatus.js";
import { loadTradingSettings } from "./tradingSettingsStore.js";
import type { AccountContext, PreviousClose, SignalsScreenRow, SnapshotHeader, TickerSignalsDetail, TickerSignalsInputs } from "./signalsTypes.js";
import { loadVolatilityForecasts } from "./volatilityForecastStore.js";
import type { OpenShortLeg } from "./rollSignalCandidates.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew } from "./tiltMeasures.js";
import { computeIvMetrics } from "./ivMetrics.js";
import type { DailyOhlcvBar } from "./realizedVolatility.js";
import { activeShortlistTickerIdsQuery } from "./shortlistQueries.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { earningsNextDateDoubt, isEtfSector, tickerCalendarProfile } from "./tickerCalendarRelevance.js";
import { loadLastEarningsReportDate } from "../ibkr/calendarConflict.js";
import { loadOpenShortLegs, openShortLegPositionsQuery } from "./openShortLegs.js";
export { loadOpenShortLegs };
import { loadDividendCadenceUnknown, loadEarningsDatesForForecastWindow, loadEarningsDatesNotYetReported, loadNextEarningsDate, loadPreviousClose } from "./tickerCalendarQueries.js";
export { loadDividendCadenceUnknown, loadEarningsDatesForForecastWindow, loadEarningsDatesNotYetReported, loadNextEarningsDate, loadPreviousClose };

// DB side of the Signals screen (mockup approved 2026-09-22). Loads one ticker's
// inputs once (loadTickerSignalsInputs); scoring itself is the pure scoreTicker in
// signalsLiveScoring.ts, so the REST routes and the live producers score the exact
// same way. Shares out for a covered call, and cash out for a cash-secured put, use
// the same live account/position queries the order-limit checks use.

export { accountContextFromTotalCash, loadAccountContext } from "./accountContext.js";
import { loadAccountContext } from "./accountContext.js";

/** Stored daily bars up to and including `asOfDateIso`, oldest first (the tilt measures and Pluto's move context). */
export async function loadBarsForTilt(tickerId: string, asOfDateIso: string): Promise<DailyOhlcvBar[]> {
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






export async function loadLatestSnapshot(tickerId: string): Promise<SnapshotHeader | null> {
  const row = await db("option_chain_snapshots")
    .where({ ticker_id: tickerId })
    .whereIn("status", ["complete", "partial"])
    .orderBy("trading_date", "desc")
    .select("id as snapshotId", db.raw('trading_date::text as "tradingDateIso"'), "captured_at as capturedAt", "underlying_price as underlyingPrice", "risk_free_rate_percent as riskFreeRatePercent", "fit_completed_at as fitCompletedAt", "fit_issue as fitIssue")
    .first();
  if (!row) return null;
  return {
    snapshotId: row.snapshotId,
    tradingDateIso: row.tradingDateIso,
    capturedAt: row.capturedAt,
    underlyingPrice: row.underlyingPrice === null ? null : Number(row.underlyingPrice),
    riskFreeRatePercent: row.riskFreeRatePercent === null ? null : Number(row.riskFreeRatePercent),
    fitCompletedAt: row.fitCompletedAt === null ? null : new Date(row.fitCompletedAt).toISOString(),
    fitIssue: row.fitIssue,
  };
}

/**
 * One cheap read for the live streams' change check: per ticker, a token that changes whenever its latest usable snapshot
 * changes or its surface fit finishes. A ticker with no snapshot has no entry.
 */
export async function loadSnapshotVersions(tickerIds: string[]): Promise<Map<string, string>> {
  if (tickerIds.length === 0) return new Map();
  const rows: { tickerId: string; snapshotId: string; fitCompletedAt: Date | null }[] = await db("option_chain_snapshots")
    .whereIn("ticker_id", tickerIds)
    .whereIn("status", ["complete", "partial"])
    .distinctOn("ticker_id")
    .orderBy([{ column: "ticker_id" }, { column: "trading_date", order: "desc" }])
    .select("ticker_id as tickerId", "id as snapshotId", "fit_completed_at as fitCompletedAt");
  return new Map(rows.map((row) => [row.tickerId, `${row.snapshotId}|${row.fitCompletedAt === null ? "pending" : new Date(row.fitCompletedAt).toISOString()}`]));
}

export async function loadSlices(snapshotId: string): Promise<SignalSurfaceSlice[]> {
  const rows = await db("option_surface_fits")
    .where({ snapshot_id: snapshotId })
    .select(
      db.raw('expiry::text as expiry'),
      "status",
      "years_to_expiry as yearsToExpiry",
      "forward_price as forwardPrice",
      "underlying_price as fitUnderlyingPrice",
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
    fitUnderlyingPrice: row.fitUnderlyingPrice === null ? null : Number(row.fitUnderlyingPrice),
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
    .select(db.raw('expiry::text as expiry'), "strike", db.raw('option_right as "right"'), "bid", "ask", "open_interest", "volume", "bid_size", "ask_size");
  const toCount = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return rows.map((row) => ({
    expiry: row.expiry,
    strike: Number(row.strike),
    right: row.right,
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
    source: "snapshot" as const,
    openInterest: toCount(row.open_interest),
    volume: toCount(row.volume),
    bidSize: toCount(row.bid_size),
    askSize: toCount(row.ask_size),
  }));
}

export interface SignalsTickerRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
}

// The Signals universe: the shortlist tickers with Signals on plus every ticker
// with an open short option leg (Roll Signals, 2026-09-24) -- a position on a
// ticker removed from the shortlist still needs its roll scored.
function signalsUniverseQuery() {
  return db("tickers as t")
    .where((builder) =>
      builder
        .whereIn("t.id", activeShortlistTickerIdsQuery())
        .orWhereIn("t.id", openShortLegPositionsQuery().select("p.ticker_id")),
    )
    .select("t.id as tickerId", "t.symbol", "t.company_name as companyName", db.raw("NULLIF(t.sector, '') as sector"));
}

export async function loadSignalsUniverseTickers(): Promise<SignalsTickerRow[]> {
  return signalsUniverseQuery().orderBy("t.symbol");
}

export async function loadSignalsUniverseTicker(symbol: string): Promise<SignalsTickerRow | null> {
  const row = await signalsUniverseQuery().where("t.symbol", symbol.toUpperCase()).first();
  return row ?? null;
}


/** Everything scoring needs for one ticker, from the DB only (no IBKR). Loaded once per REST call or stream start. */
export async function loadTickerSignalsInputs(ticker: SignalsTickerRow, now: Date = new Date()): Promise<TickerSignalsInputs> {
  const todayEastern = easternIsoDate(now);
  const [bars, storedNextEarningsDateIso, storedEarningsDatesIso, lastEarningsReportIso, tickerRow, previousClose, header, freeShares, dailyBarCount, dividendCadenceUnknown, macroEvents, openShortLegs] = await Promise.all([
    loadBarsForTilt(ticker.tickerId, todayEastern),
    loadNextEarningsDate(ticker.tickerId, todayEastern),
    loadEarningsDatesNotYetReported(ticker.tickerId, todayEastern),
    loadLastEarningsReportDate(ticker.tickerId, todayEastern),
    db("tickers").where({ id: ticker.tickerId }).first<{ tradingview_ticker: string | null; sector: string | null } | undefined>("tradingview_ticker", "sector"),
    loadPreviousClose(ticker.tickerId, todayEastern),
    loadLatestSnapshot(ticker.tickerId),
    fetchAvailableUncoveredShares(ticker.tickerId),
    db("daily_price_bars").where({ ticker_id: ticker.tickerId }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    loadDividendCadenceUnknown(ticker.tickerId, todayEastern),
    loadUpcomingMajorMacroEvents(),
    loadOpenShortLegs(ticker.tickerId),
  ]);
  // Same "resolved" rule as calendarConflict.ts. An ETF has no earnings, so a stray row (a symbol collision) cannot exclude anything.
  const calendarProfile = tickerCalendarProfile(tickerRow);
  // A doubtful next date (TradingView's stand-in, or one far past the usual quarter) is unknown, not clear.
  const earningsCalendarResolved = calendarProfile.earningsCalendarResolved && (!calendarProfile.calendarChecksApply || earningsNextDateDoubt(lastEarningsReportIso, storedNextEarningsDateIso, todayEastern) === null);
  const earningsDatesIso = calendarProfile.calendarChecksApply ? storedEarningsDatesIso : [];
  const nextEarningsDateIso = calendarProfile.calendarChecksApply ? storedNextEarningsDateIso : null;
  const momentum = computeMomentum(bars.map((bar) => bar.close));
  const elevatedVolatility = computeElevatedVolatilityFlag(bars);

  const [[slices, quotes, forecasts, dayQuotes], ivMetrics] = await Promise.all([
    header
      ? Promise.all([loadSlices(header.snapshotId), loadQuotes(header.snapshotId), loadVolatilityForecasts(ticker.tickerId, header.tradingDateIso, todayEastern), loadDayQuotesAsLiveQuotes(ticker.tickerId, header.tradingDateIso)])
      : ([[] as SignalSurfaceSlice[], [] as SignalQuote[], { model: null, yangZhang63: null }, [] as LiveOptionQuote[]] as const),
    computeIvMetrics(ticker.tickerId),
  ]);
  const furthestExpiry = slices.map((slice) => slice.expiry).sort().at(-1);
  // From the snapshot's own date: a surface fitted on an earlier day is rolled to today on the variance clock.
  const tradingSessions = header && furthestExpiry ? await loadTradingSessionsBetween(header.tradingDateIso < todayEastern ? header.tradingDateIso : todayEastern, furthestExpiry) : [];

  return { ...ticker, header, slices, quotes, dayQuotes, modelForecast: forecasts.model, yangZhang63Forecast: forecasts.yangZhang63, ivMetrics, tradingSessions, valuationGroup: isEtfSector(tickerRow?.sector) ? "etf" : "stock", earningsDatesIso, earningsCalendarResolved, macroEvents, momentum, elevatedVolatility, skew: computeSkew(slices), nextEarningsDateIso, previousClose, freeShares, openShortLegs, dailyBarCount, dividendCadenceUnknown, todayEasternIso: todayEastern };
}

/**
 * The Day Signals loop's quotes for one ticker, only when they belong to the snapshot date being scored and were received
 * during today's session (US/Eastern): before the new day's snapshot lands, the loop's rows from the previous session's close
 * still match the (previous-day) snapshot date, and would otherwise price an order from yesterday. Contracts that errored carry no quote.
 */
export async function loadDayQuotesAsLiveQuotes(tickerId: string, snapshotTradingDateIso: string, now: Date = new Date()): Promise<LiveOptionQuote[]> {
  const todayEastern = easternIsoDate(now);
  const rows = await loadDayQuotesForTicker(tickerId, snapshotTradingDateIso);
  return rows.filter((row) => row.errorCode === null && easternIsoDate(new Date(row.quotedAt)) === todayEastern).map((row) => ({ expiry: row.expiry, strike: row.strike, right: row.right, bid: row.bid, ask: row.ask, quotedAt: row.quotedAt }));
}

/** One ticker, snapshot prices, with the Monte Carlo attached (REST first paint for the modal). Includes the raw
 * fitted-surface slices (unscaled by live spot) for the volatility-surface modal. */
export async function loadTickerSignals(ticker: SignalsTickerRow, accountContext: AccountContext, options: { withUncompensatedShare?: boolean } = {}): Promise<TickerSignalsDetail> {
  const [inputs, settings] = await Promise.all([loadTickerSignalsInputs(ticker), loadTradingSettings()]);
  const scored = scoreTicker(inputs, accountContext, settings);
  if (!options.withUncompensatedShare || !inputs.header?.underlyingPrice || scored.candidates.length === 0) return { ...scored, slices: inputs.slices };
  const uncompensatedByContract = computeUncompensatedByContract(scored.candidates, inputs.header.underlyingPrice, inputs.slices);
  const rescored = scoreTicker(inputs, accountContext, settings, { spotPrice: inputs.header.underlyingPrice, priceSource: "snapshot", uncompensatedByContract });
  return { ...rescored, slices: inputs.slices };
}

/** The counts and settings the roadmap reads. */
export async function loadRoadmapCounts(): Promise<RoadmapCounts> {
  const [signalsOrderFills, settings] = await Promise.all([
    // Open orders only: a roll's fill is a different friction sample (two legs, one combo), so it is counted apart (decided 2026-09-24).
    db("order_requests").whereNotNull("signal_snapshot").where("request_type", "like", "open_%").whereIn("status", ["filled", "partially_filled", "cancelled_partially_filled"]).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    loadTradingSettings(),
  ]);
  return { signalsOrderFills, spreadCostChargedPct: settings.spreadCostChargedPct };
}

/** The whole Signals screen at snapshot prices: one account-context fetch shared across every ticker, no candidate lists. */
export async function loadSignalsScreen(): Promise<SignalsScreenRow[]> {
  const [tickers, accountContext, settings] = await Promise.all([loadSignalsUniverseTickers(), loadAccountContext(), loadTradingSettings()]);
  const inputs = await Promise.all(tickers.map((ticker) => loadTickerSignalsInputs(ticker)));
  return inputs.map((tickerInputs) => toScreenRow(scoreTicker(tickerInputs, accountContext, settings)));
}
