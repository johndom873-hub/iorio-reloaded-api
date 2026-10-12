import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { detectPriceAdjustment, tradingDateOf, type StoredBarPrices } from "../ibkr/dailyBarSplitCheck.js";
import { fetchHistoricalBarsRaw, type PriceBar } from "../ibkr/fetchTickerOverview.js";
import { ivBarsToDateMap, storeFreshDailyBars } from "../ibkr/priceBarCache.js";
import { summarizeBackfillBars } from "../lib/backfillBarSummary.js";
import { normalizeBarVolume } from "../lib/normalizeBarVolume.js";

// IBKR daily history back to 2016-01-01 for backtesting (docs/backtesting/DATA-FILES.md): daily TRADES bars and the
// daily implied volatility (OPTION_IMPLIED_VOLATILITY) into daily_price_bars, the forecast's and settlement's input.
// Used by npm run backtest:backfill-history and by every download job for its symbol.
//
// Only what is missing is written: days with no row are inserted the way upsertDailyBars stores them, and a stored day
// without implied volatility gets IBKR's; stored prices are never changed. The one exception is the app's own split
// rule: when IBKR's prices show a split since the stored rows were fetched, the history goes through
// storeFreshDailyBars, which replaces it with a fresh full fetch so the two price bases never mix.

export const backtestHistoryStartDate = "2016-01-01";

/** IBKR's duration for daily bars reaching back to `startDateIso` (whole years: longer durations must be in years). */
export function historyDurationReaching(startDateIso: string, now: Date): string {
  const years = (now.getTime() - Date.parse(`${startDateIso}T00:00:00Z`)) / (365.25 * 86_400_000);
  return `${Math.max(1, Math.ceil(years))} Y`;
}

export interface BacktestHistoryBackfillResult {
  symbol: string;
  fetchedBars: number;
  fetchedImpliedVolatilityDays: number;
  insertedDays: number;
  impliedVolatilityFilledDays: number;
  /** True when a split since the stored rows made the app's full history replacement run instead. */
  historyReplacedAfterSplit: boolean;
  firstDateBefore: string | null;
  firstDateAfter: string | null;
  lastDateAfter: string | null;
  impliedVolatilityFirstDateAfter: string | null;
  /** Fetched bars with a non-positive price or high below low (stored as IBKR sent them). */
  invalidBarDates: string[];
  /** The implied-volatility request's failure; the bars are still written. */
  impliedVolatilityError: string | null;
}

interface StoredRange {
  firstDate: string | null;
  lastDate: string | null;
  impliedVolatilityFirstDate: string | null;
}

async function loadStoredRange(tickerId: string, connection: Knex): Promise<StoredRange> {
  const row: { first_date: string | null; last_date: string | null; iv_first_date: string | null } | undefined = await connection("daily_price_bars")
    .where({ ticker_id: tickerId })
    .first(
      connection.raw("min(trading_date)::text as first_date"),
      connection.raw("max(trading_date)::text as last_date"),
      connection.raw("(min(trading_date) filter (where implied_volatility is not null))::text as iv_first_date"),
    );
  return { firstDate: row?.first_date ?? null, lastDate: row?.last_date ?? null, impliedVolatilityFirstDate: row?.iv_first_date ?? null };
}

async function loadStoredPricesOn(tickerId: string, tradingDates: readonly string[], connection: Knex): Promise<StoredBarPrices[]> {
  if (tradingDates.length === 0) return [];
  const rows: { tradingDate: string; open: string; high: string; low: string; close: string }[] = await connection("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereIn("trading_date", tradingDates)
    .select(connection.raw('trading_date::text as "tradingDate"'), "open_price as open", "high_price as high", "low_price as low", "close_price as close");
  return rows.map((row) => ({ tradingDate: row.tradingDate, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
}

const insertChunkSize = 1000;

/** Inserts the bars for days with no row (same row shape as upsertDailyBars); returns how many were inserted. */
export async function insertMissingDailyBars(tickerId: string, bars: readonly PriceBar[], impliedVolatilityByDate: ReadonlyMap<string, number>, connection: Knex = db): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < bars.length; start += insertChunkSize) {
    const rows = bars.slice(start, start + insertChunkSize).map((bar) => {
      const tradingDate = tradingDateOf(bar);
      return {
        ticker_id: tickerId,
        trading_date: tradingDate,
        open_price: bar.open,
        high_price: bar.high,
        low_price: bar.low,
        close_price: bar.close,
        volume: normalizeBarVolume(bar.volume),
        implied_volatility: impliedVolatilityByDate.get(tradingDate) ?? null,
      };
    });
    const written = await connection("daily_price_bars").insert(rows).onConflict(["ticker_id", "trading_date"]).ignore().returning("id");
    inserted += written.length;
  }
  return inserted;
}

/** Sets IBKR's implied volatility on stored days that have none; a stored value is never changed. Returns the days filled. */
export async function fillMissingImpliedVolatility(tickerId: string, impliedVolatilityByDate: ReadonlyMap<string, number>, connection: Knex = db): Promise<number> {
  if (impliedVolatilityByDate.size === 0) return 0;
  const result = await connection.raw(
    `
    UPDATE daily_price_bars AS bars
    SET implied_volatility = fresh.implied_volatility
    FROM (SELECT unnest(?::date[]) AS trading_date, unnest(?::numeric[]) AS implied_volatility) AS fresh
    WHERE bars.ticker_id = ?
      AND bars.trading_date = fresh.trading_date
      AND bars.implied_volatility IS NULL
    `,
    [[...impliedVolatilityByDate.keys()], [...impliedVolatilityByDate.values()], tickerId],
  );
  return result.rowCount ?? 0;
}

/**
 * Fetches the ticker's daily bars and implied volatility from `backtestHistoryStartDate` to now (2 historical requests)
 * and stores what is missing up to `lastDateToStore` (the last finished session, so a still-forming bar is never stored).
 * Throws when the bars request fails; an implied-volatility failure is reported in the result.
 */
export async function backfillDailyHistoryForBacktest(
  connection: IbkrConnection,
  ticker: { id: string; symbol: string },
  options: { lastDateToStore: string; nextRequestId: () => number; now?: Date },
): Promise<BacktestHistoryBackfillResult> {
  const before = await loadStoredRange(ticker.id, db);
  const duration = historyDurationReaching(backtestHistoryStartDate, options.now ?? new Date());
  const isInRange = (bar: PriceBar) => {
    const tradingDate = tradingDateOf(bar);
    return tradingDate >= backtestHistoryStartDate && tradingDate <= options.lastDateToStore;
  };

  const bars = (await fetchHistoricalBarsRaw(connection, ticker.symbol, BarSizeSetting.DAYS_ONE, duration, options.nextRequestId())).filter(isInRange);
  let impliedVolatilityError: string | null = null;
  const impliedVolatilityBars = await fetchHistoricalBarsRaw(connection, ticker.symbol, BarSizeSetting.DAYS_ONE, duration, options.nextRequestId(), WhatToShow.OPTION_IMPLIED_VOLATILITY).catch((error: unknown) => {
    impliedVolatilityError = error instanceof Error ? error.message : String(error);
    return [] as PriceBar[];
  });
  const impliedVolatilityByDate = ivBarsToDateMap(impliedVolatilityBars.filter(isInRange));
  const summary = summarizeBackfillBars(bars.map((bar) => ({ tradingDate: tradingDateOf(bar), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })));

  const stored = await loadStoredPricesOn(ticker.id, bars.map(tradingDateOf), db);
  let insertedDays = 0;
  let impliedVolatilityFilledDays = 0;
  let historyReplacedAfterSplit = false;
  if (detectPriceAdjustment(stored, bars)) {
    await storeFreshDailyBars(connection, ticker.id, ticker.symbol, { bars, ivByDate: impliedVolatilityByDate }, options.nextRequestId());
    historyReplacedAfterSplit = true;
  } else {
    insertedDays = await insertMissingDailyBars(ticker.id, bars, impliedVolatilityByDate);
    impliedVolatilityFilledDays = await fillMissingImpliedVolatility(ticker.id, impliedVolatilityByDate);
  }

  const after = await loadStoredRange(ticker.id, db);
  return {
    symbol: ticker.symbol,
    fetchedBars: bars.length,
    fetchedImpliedVolatilityDays: impliedVolatilityByDate.size,
    insertedDays,
    impliedVolatilityFilledDays,
    historyReplacedAfterSplit,
    firstDateBefore: before.firstDate,
    firstDateAfter: after.firstDate,
    lastDateAfter: after.lastDate,
    impliedVolatilityFirstDateAfter: after.impliedVolatilityFirstDate,
    invalidBarDates: summary.invalidBarDates,
    impliedVolatilityError,
  };
}

export function describeBacktestHistoryBackfill(result: BacktestHistoryBackfillResult): string {
  const parts = [
    `${result.symbol}: ${result.fetchedBars} bars and ${result.fetchedImpliedVolatilityDays} implied-volatility days fetched`,
    result.historyReplacedAfterSplit ? "a split since the stored rows: history replaced by a full fetch" : `${result.insertedDays} days inserted, ${result.impliedVolatilityFilledDays} days given implied volatility`,
    `first day ${result.firstDateBefore ?? "none"} → ${result.firstDateAfter ?? "none"}, last ${result.lastDateAfter ?? "none"}, implied volatility from ${result.impliedVolatilityFirstDateAfter ?? "none"}`,
  ];
  if (result.invalidBarDates.length > 0) parts.push(`invalid bars on ${result.invalidBarDates.join(", ")}`);
  if (result.impliedVolatilityError) parts.push(`implied volatility request failed: ${result.impliedVolatilityError}`);
  return parts.join("; ");
}

/** A failure that means IBKR is pacing or not answering (not "no data for this symbol"): a batch stops instead of hammering it. */
export function isIbkrPacingOrOutageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|pacing|not connected|code 1100\b|code 502\b|code 504\b/i.test(message) && !/returned no data/i.test(message);
}
