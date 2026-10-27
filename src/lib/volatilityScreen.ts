import { db } from "../db/connection.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { computeIvMetrics } from "./ivMetrics.js";
import { loadTradingSessionsBetween } from "./marketSessionStatus.js";
import { calendarDaysUntilExpiry } from "./optionChainExpiryRange.js";
import { loadOptionDataUniverse, type OptionDataTicker } from "./optionDataUniverse.js";
import { coveredCallYieldAfterCosts } from "./premiumYield.js";
import { deltaFromQuoteMid, yearsToSessionClose } from "./quoteOwnDelta.js";
import { getRiskFreeRate } from "./riskFreeRate.js";
import { loadNextEarningsDate } from "./tickerCalendarQueries.js";
import { loadTradingSettings } from "./tradingSettingsStore.js";
import { loadVolatilityForecasts } from "./volatilityForecastStore.js";
import { readTickerLiveState, type DeltaBand, type LiveCallQuote } from "./volatilityLive.js";

// The Volatility screen (Marcelo 2026-10-27, replacing Signals): per option-data ticker, the price, IBKR's 30-day IV
// (live, else the last close's), the 21- and 63-day realized volatility forecasts, IV Rank and IV Percentile, the next
// earnings date, and the best Call yield inside a delta band for each expiry window. Pulse's Top premiums reads the same
// rows. Daily figures are read from daily_price_bars once per trading day (and again after dailyFiguresRefreshMs); the
// live part comes from the market quote loop (volatilityLive.ts).

export const expiryWindows = [
  { key: "upTo7", minDays: 0, maxDays: 7 },
  { key: "from8To21", minDays: 8, maxDays: 21 },
  { key: "from22To45", minDays: 22, maxDays: 45 },
] as const;
export type ExpiryWindowKey = (typeof expiryWindows)[number]["key"];

/** A live Call quote older than this is not used for a best yield. */
export const callQuoteMaxAgeMs = 15 * 60_000;
const dailyFiguresRefreshMs = 10 * 60_000;

export interface BestCallYield {
  /** Yield a year after costs, as a fraction (1.10 = 110%). */
  yield: number;
  expiry: string;
  daysToExpiry: number;
  strike: number;
  delta: number;
  bid: number;
  ask: number;
  earningsBeforeExpiry: boolean;
  quotedAt: string;
}

export interface VolatilityRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  price: number | null;
  priceSource: "live" | "close" | null;
  /** Percent, e.g. -2.1. */
  dayChangePercent: number | null;
  /** IBKR's 30-day implied volatility, as a fraction. */
  atmImpliedVolatility: number | null;
  atmImpliedVolatilitySource: "live" | "close" | null;
  /** 21- and 63-day Yang-Zhang realized volatility to the last close, annualized on sessions, as fractions. */
  forecast21: number | null;
  forecast63: number | null;
  /** 0-100. */
  ivRank: number | null;
  ivPercentile: number | null;
  ivWindowDays: number;
  dailyBarCount: number;
  nextEarningsDateIso: string | null;
  bestCallYields: Record<ExpiryWindowKey, BestCallYield | null>;
}

interface DailyFigures {
  latestClose: number | null;
  previousClose: number | null;
  closeImpliedVolatility: number | null;
  forecast21: number | null;
  forecast63: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  ivWindowDays: number;
  dailyBarCount: number;
  nextEarningsDateIso: string | null;
}

let dailyCache: { tradingDateIso: string; loadedAtMs: number; byTicker: Map<string, DailyFigures> } | null = null;

/** The last two closes strictly before today, the latest stored IV, and the bar count. */
async function loadCloses(tickerId: string, todayIso: string): Promise<{ latestClose: number | null; previousClose: number | null; closeImpliedVolatility: number | null; dailyBarCount: number }> {
  const [closes, impliedVolatility, count] = await Promise.all([
    db("daily_price_bars").where({ ticker_id: tickerId }).whereRaw("trading_date::text < ?", [todayIso]).whereNotNull("close_price").orderBy("trading_date", "desc").limit(2).select("close_price as close"),
    db("daily_price_bars").where({ ticker_id: tickerId }).whereNotNull("implied_volatility").orderBy("trading_date", "desc").first("implied_volatility as impliedVolatility"),
    db("daily_price_bars").where({ ticker_id: tickerId }).whereNotNull("close_price").count<{ count: string }[]>("* as count"),
  ]);
  return {
    latestClose: closes[0] ? Number(closes[0].close) : null,
    previousClose: closes[1] ? Number(closes[1].close) : null,
    closeImpliedVolatility: impliedVolatility ? Number(impliedVolatility.impliedVolatility) : null,
    dailyBarCount: Number(count[0]?.count ?? 0),
  };
}

/** The latest stored IBKR daily IV per ticker (the loop's fallback when the live IV tick did not arrive). */
export async function loadCloseImpliedVolatilities(tickerIds: string[]): Promise<Map<string, number>> {
  if (tickerIds.length === 0) return new Map();
  const rows: { tickerId: string; impliedVolatility: string }[] = await db("daily_price_bars")
    .distinctOn("ticker_id")
    .whereIn("ticker_id", tickerIds)
    .whereNotNull("implied_volatility")
    .orderBy([{ column: "ticker_id" }, { column: "trading_date", order: "desc" }])
    .select("ticker_id as tickerId", "implied_volatility as impliedVolatility");
  return new Map(rows.map((row) => [row.tickerId, Number(row.impliedVolatility)]));
}

async function loadDailyFigures(tickers: OptionDataTicker[], todayIso: string, nowMs: number): Promise<Map<string, DailyFigures>> {
  if (!dailyCache || dailyCache.tradingDateIso !== todayIso || nowMs - dailyCache.loadedAtMs > dailyFiguresRefreshMs) dailyCache = { tradingDateIso: todayIso, loadedAtMs: nowMs, byTicker: new Map() };
  const cache = dailyCache;
  await Promise.all(
    tickers
      .filter((ticker) => !cache.byTicker.has(ticker.tickerId))
      .map(async (ticker) => {
        const [closes, forecasts, ivMetrics, nextEarningsDateIso] = await Promise.all([loadCloses(ticker.tickerId, todayIso), loadVolatilityForecasts(ticker.tickerId, todayIso, todayIso), computeIvMetrics(ticker.tickerId), loadNextEarningsDate(ticker.tickerId, todayIso)]);
        cache.byTicker.set(ticker.tickerId, {
          ...closes,
          forecast21: forecasts.model?.annualizedVolatility ?? null,
          forecast63: forecasts.yangZhang63?.annualizedVolatility ?? null,
          ivRank: ivMetrics.ivRank,
          ivPercentile: ivMetrics.ivPercentile,
          ivWindowDays: ivMetrics.ivWindowDays,
          nextEarningsDateIso,
        });
      }),
  );
  return cache.byTicker;
}

export interface BestCallYieldContext {
  todayIso: string;
  nowMs: number;
  band: DeltaBand;
  /** λ, 0..1. */
  spreadShareCharged: number;
  riskFreeRate: number;
  yearsToTodaysClose: number;
  nextEarningsDateIso: string | null;
}

/** Pure: the best Call yield per expiry window among live quotes whose own delta lies inside the band (exported for tests). */
export function bestCallYieldsByWindow(quotes: Iterable<LiveCallQuote>, context: BestCallYieldContext): Record<ExpiryWindowKey, BestCallYield | null> {
  const best: Record<ExpiryWindowKey, BestCallYield | null> = { upTo7: null, from8To21: null, from22To45: null };
  for (const quote of quotes) {
    if (quote.bid === null || quote.ask === null || quote.stockPrice === null || context.nowMs - quote.quotedAt.getTime() > callQuoteMaxAgeMs) continue;
    const daysToExpiry = calendarDaysUntilExpiry(context.todayIso, quote.expiry.replaceAll("-", ""));
    const window = expiryWindows.find((entry) => daysToExpiry >= entry.minDays && daysToExpiry <= entry.maxDays);
    if (!window) continue;
    const delta = deltaFromQuoteMid({ bid: quote.bid, ask: quote.ask, spotPrice: quote.stockPrice, strike: quote.strike, isCall: true, yearsToExpiry: daysToExpiry === 0 ? context.yearsToTodaysClose : daysToExpiry / 365, riskFreeRate: context.riskFreeRate });
    if (delta === null || delta < context.band.min || delta > context.band.max) continue;
    const yieldAYear = coveredCallYieldAfterCosts({ bid: quote.bid, ask: quote.ask, spotPrice: quote.stockPrice, daysToExpiry, spreadShareCharged: context.spreadShareCharged });
    if (yieldAYear === null) continue;
    const current = best[window.key];
    if (current && current.yield >= yieldAYear) continue;
    best[window.key] = {
      yield: yieldAYear,
      expiry: quote.expiry,
      daysToExpiry,
      strike: quote.strike,
      delta,
      bid: quote.bid,
      ask: quote.ask,
      earningsBeforeExpiry: context.nextEarningsDateIso !== null && context.nextEarningsDateIso <= quote.expiry,
      quotedAt: quote.quotedAt.toISOString(),
    };
  }
  return best;
}

export interface VolatilityScreen {
  asOf: string;
  todayIso: string;
  deltaBand: DeltaBand;
  rows: VolatilityRow[];
}

export async function loadVolatilityScreen(band: DeltaBand, now: Date = new Date()): Promise<VolatilityScreen> {
  const todayIso = easternIsoDate(now);
  const nowMs = now.getTime();
  const [tickers, settings, riskFreeRate, sessions] = await Promise.all([loadOptionDataUniverse(), loadTradingSettings(), getRiskFreeRate(), loadTradingSessionsBetween(todayIso, todayIso)]);
  const daily = await loadDailyFigures(tickers, todayIso, nowMs);
  const yearsToTodaysClose = sessions[0] ? yearsToSessionClose(now, sessions[0].closeMinutesEt) : 0;
  const rows = tickers.map((ticker): VolatilityRow => {
    const figures = daily.get(ticker.tickerId);
    const live = readTickerLiveState(ticker.tickerId, todayIso);
    const livePrice = live?.spotPrice ?? null;
    const price = livePrice ?? figures?.latestClose ?? null;
    const reference = livePrice !== null ? (figures?.latestClose ?? null) : (figures?.previousClose ?? null);
    const liveImpliedVolatility = live?.impliedVolatility ?? null;
    return {
      tickerId: ticker.tickerId,
      symbol: ticker.symbol,
      companyName: ticker.companyName,
      price,
      priceSource: livePrice !== null ? "live" : price !== null ? "close" : null,
      dayChangePercent: price !== null && reference !== null && reference > 0 ? ((price - reference) / reference) * 100 : null,
      atmImpliedVolatility: liveImpliedVolatility ?? figures?.closeImpliedVolatility ?? null,
      atmImpliedVolatilitySource: liveImpliedVolatility !== null ? "live" : figures?.closeImpliedVolatility != null ? "close" : null,
      forecast21: figures?.forecast21 ?? null,
      forecast63: figures?.forecast63 ?? null,
      ivRank: figures?.ivRank ?? null,
      ivPercentile: figures?.ivPercentile ?? null,
      ivWindowDays: figures?.ivWindowDays ?? 0,
      dailyBarCount: figures?.dailyBarCount ?? 0,
      nextEarningsDateIso: figures?.nextEarningsDateIso ?? null,
      bestCallYields: live
        ? bestCallYieldsByWindow(live.callQuotes.values(), { todayIso, nowMs, band, spreadShareCharged: settings.spreadCostChargedPct / 100, riskFreeRate: riskFreeRate ?? 0, yearsToTodaysClose, nextEarningsDateIso: figures?.nextEarningsDateIso ?? null })
        : { upTo7: null, from8To21: null, from22To45: null },
    };
  });
  return { asOf: now.toISOString(), todayIso, deltaBand: band, rows };
}
