import { BarSizeSetting, MarketDataType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { fetchHistoricalBarsRaw, type ChartRange, type PriceBar } from "./fetchTickerOverview.js";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

/**
 * Cache-then-delta-fetch layer for the Ticker Detail modal's chart, approved
 * 2026-08-27 (see PROGRESS.md "Chart bar caching"). Historical bars for past
 * dates never change, so once a ticker/bar-size combo has been fetched once,
 * repeat views only need to top up with whatever's new since the last cached
 * bar instead of re-pulling the whole range from IBKR every time.
 *
 * Two cache tables, chosen to reuse what already existed rather than adding
 * a table per granularity:
 * - `intraday_price_bars` (new): minute/hour bars, one row per
 *   (ticker, bar_size, bar_time). Backs 1D/5D/1M/3M/6M — each maps to a
 *   distinct IBKR bar size, so no collisions within the table.
 * - `daily_price_bars` (already existed, fed nightly by the daily job with
 *   just the latest bar): now also backfilled here with real history on
 *   first use, and used for all three of 1Y/5Y/All — 1Y reads it directly,
 *   5Y/All resample it to weekly bars in SQL rather than caching a separate
 *   weekly granularity. A single cold backfill (20 years) covers all three.
 *
 * Known limitation, deliberately not handled (approved as an acceptable
 * tradeoff, not an oversight): bars are unadjusted (`WhatToShow.TRADES`), so
 * a stock split will leave a visible price discontinuity between
 * pre-existing cached bars and newly fetched ones until that ticker's cache
 * rows are manually cleared. No automatic split detection — splits are rare
 * enough for this 2-user tool that a manual `DELETE ... WHERE ticker_id = x`
 * is an acceptable fix when it happens.
 */

// Found 2026-08-28: the cache below was write-through but not actually
// skipping the live IBKR call on a hot repeat view — every getCachedChartBars
// call unconditionally re-fetched a "top up" window from IBKR before reading
// from the DB, so reopening the same symbol/range seconds later paid for a
// full IBKR round-trip again even though nothing could have changed that
// fast. Tracked in-process (not a DB column) since it's a perf optimization,
// not a correctness concern — worst case after a dyno restart is one extra
// live fetch, same as today's behavior everywhere.
const lastLiveFetchAtByKey = new Map<string, number>();
const liveFetchFreshnessMs = 30_000;

function isFreshEnoughToSkipLiveFetch(symbol: string, range: ChartRange): boolean {
  const lastFetchedAt = lastLiveFetchAtByKey.get(`${symbol}:${range}`);
  return lastFetchedAt !== undefined && Date.now() - lastFetchedAt < liveFetchFreshnessMs;
}

function markLiveFetched(symbol: string, range: ChartRange): void {
  lastLiveFetchAtByKey.set(`${symbol}:${range}`, Date.now());
}

type IntradayRange = Exclude<ChartRange, "1Y" | "5Y" | "All">;

const intradayConfig: Record<IntradayRange, { barSize: BarSizeSetting; fullDuration: string; topUpDuration: string }> = {
  "1D": { barSize: BarSizeSetting.MINUTES_ONE, fullDuration: "2 D", topUpDuration: "2 D" },
  "5D": { barSize: BarSizeSetting.MINUTES_FIVE, fullDuration: "7 D", topUpDuration: "2 D" },
  "1M": { barSize: BarSizeSetting.MINUTES_THIRTY, fullDuration: "1 M", topUpDuration: "3 D" },
  "3M": { barSize: BarSizeSetting.HOURS_ONE, fullDuration: "3 M", topUpDuration: "5 D" },
  "6M": { barSize: BarSizeSetting.HOURS_TWO, fullDuration: "6 M", topUpDuration: "5 D" },
};

// 1Y/5Y/All all share the same daily-bar cache — a 20-year backfill on first
// use covers "All", so there's never a second cold fetch needed for the
// other two once a ticker's daily cache is warm.
const dailyBackfillDuration = "20 Y";
const dailyTopUpDuration = "5 D";

function subtractDuration(from: Date, duration: string): Date {
  const match = duration.trim().match(/^(\d+)\s*([DWMY])$/i);
  if (!match) throw new Error(`Unrecognized IBKR duration string: ${duration}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const result = new Date(from);
  if (unit === "D") result.setUTCDate(result.getUTCDate() - amount);
  else if (unit === "W") result.setUTCDate(result.getUTCDate() - amount * 7);
  else if (unit === "M") result.setUTCMonth(result.getUTCMonth() - amount);
  else if (unit === "Y") result.setUTCFullYear(result.getUTCFullYear() - amount);
  return result;
}

async function resolveTickerId(symbol: string): Promise<string | null> {
  const row = await db("tickers").where({ symbol }).first();
  return row?.id ?? null;
}

async function getLatestIntradayBarTime(tickerId: string, barSize: string): Promise<Date | null> {
  const row = await db("intraday_price_bars").where({ ticker_id: tickerId, bar_size: barSize }).max({ latest: "bar_time" }).first();
  return row?.latest ? new Date(row.latest) : null;
}

async function upsertIntradayBars(tickerId: string, barSize: string, bars: PriceBar[]): Promise<void> {
  if (bars.length === 0) return;
  const rows = bars.map((bar) => ({
    ticker_id: tickerId,
    bar_size: barSize,
    bar_time: new Date(bar.time * 1000),
    open_price: bar.open,
    high_price: bar.high,
    low_price: bar.low,
    close_price: bar.close,
    volume: bar.volume,
  }));
  await db("intraday_price_bars").insert(rows).onConflict(["ticker_id", "bar_size", "bar_time"]).merge();
}

async function readIntradayBars(tickerId: string, barSize: string, since: Date): Promise<PriceBar[]> {
  const rows = await db("intraday_price_bars")
    .where({ ticker_id: tickerId, bar_size: barSize })
    .andWhere("bar_time", ">=", since)
    .orderBy("bar_time", "asc");
  return rows.map((row) => ({
    time: Math.floor(new Date(row.bar_time).getTime() / 1000),
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    volume: Number(row.volume),
  }));
}

function toDateOnlyString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

async function getLatestDailyBarDate(tickerId: string): Promise<Date | null> {
  const row = await db("daily_price_bars").where({ ticker_id: tickerId }).max({ latest: "trading_date" }).first();
  return row?.latest ? new Date(row.latest) : null;
}

// Matches the daily job's own insert shape (run-daily-market-data-job.ts) —
// same trading_date derivation, same onConflict target, so a backfill here
// and that job's nightly top-up coexist on the same rows without conflict.
async function upsertDailyBars(tickerId: string, bars: PriceBar[]): Promise<void> {
  if (bars.length === 0) return;
  const rows = bars.map((bar) => ({
    ticker_id: tickerId,
    trading_date: new Date(bar.time * 1000).toISOString().slice(0, 10),
    open_price: bar.open,
    high_price: bar.high,
    low_price: bar.low,
    close_price: bar.close,
    volume: bar.volume,
  }));
  await db("daily_price_bars").insert(rows).onConflict(["ticker_id", "trading_date"]).merge();
}

async function readDailyBars(tickerId: string, since: Date): Promise<PriceBar[]> {
  const rows = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .andWhere("trading_date", ">=", toDateOnlyString(since))
    .orderBy("trading_date", "asc");
  return rows.map((row) => ({
    time: Math.floor(new Date(`${toDateOnlyString(row.trading_date)}T00:00:00Z`).getTime() / 1000),
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    volume: Number(row.volume),
  }));
}

// Resamples daily rows to weekly OHLCV in SQL rather than caching a separate
// weekly granularity — 5Y/All are the only ranges that need weekly bars, and
// both are served from the same daily_price_bars rows 1Y already reads.
async function readWeeklyResampledBars(tickerId: string, since: Date | null): Promise<PriceBar[]> {
  const result = await db.raw(
    `
    WITH weekly AS (
      SELECT
        date_trunc('week', trading_date)::date AS week_start,
        trading_date, open_price, high_price, low_price, close_price, volume,
        row_number() OVER (PARTITION BY date_trunc('week', trading_date) ORDER BY trading_date ASC) AS rn_asc,
        row_number() OVER (PARTITION BY date_trunc('week', trading_date) ORDER BY trading_date DESC) AS rn_desc
      FROM daily_price_bars
      WHERE ticker_id = ?
        AND (?::date IS NULL OR trading_date >= ?::date)
    )
    SELECT
      week_start,
      max(CASE WHEN rn_asc = 1 THEN open_price END) AS open_price,
      max(high_price) AS high_price,
      min(low_price) AS low_price,
      max(CASE WHEN rn_desc = 1 THEN close_price END) AS close_price,
      sum(volume) AS volume
    FROM weekly
    GROUP BY week_start
    ORDER BY week_start ASC
    `,
    [tickerId, since ? toDateOnlyString(since) : null, since ? toDateOnlyString(since) : null],
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    time: Math.floor(new Date(`${toDateOnlyString(row.week_start as string | Date)}T00:00:00Z`).getTime() / 1000),
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    volume: Number(row.volume),
  }));
}

/**
 * Chart bars for one range, cached — call on an already-open connection
 * (the Ticker Detail SSE stream's shared connection). See
 * fetchCachedPriceBars below for the open-own-connection variant the plain
 * /chart route uses for range switches after the modal is already open.
 *
 * A symbol with no `tickers` row (shouldn't happen in practice — every path
 * that opens the modal already resolved/created one) fails open: skips
 * caching and fetches live directly, rather than blocking the chart on it.
 */
export async function getCachedChartBars(connection: IbkrConnection, symbol: string, range: ChartRange, reqId = 1): Promise<PriceBar[]> {
  const tickerId = await resolveTickerId(symbol);

  if (range === "1Y" || range === "5Y" || range === "All") {
    if (!tickerId) {
      const duration = range === "1Y" ? "1 Y" : range === "5Y" ? "5 Y" : "20 Y";
      return fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, duration, reqId);
    }

    const latestCached = await getLatestDailyBarDate(tickerId);
    if (!latestCached || !isFreshEnoughToSkipLiveFetch(symbol, range)) {
      const fetchDuration = latestCached ? dailyTopUpDuration : dailyBackfillDuration;
      const freshBars = await fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, fetchDuration, reqId);
      await upsertDailyBars(tickerId, freshBars);
      markLiveFetched(symbol, range);
    }

    if (range === "1Y") return readDailyBars(tickerId, subtractDuration(new Date(), "1 Y"));
    if (range === "5Y") return readWeeklyResampledBars(tickerId, subtractDuration(new Date(), "5 Y"));
    return readWeeklyResampledBars(tickerId, null);
  }

  const cfg = intradayConfig[range];
  if (!tickerId) {
    return fetchHistoricalBarsRaw(connection, symbol, cfg.barSize, cfg.fullDuration, reqId);
  }

  const latestCached = await getLatestIntradayBarTime(tickerId, cfg.barSize);
  if (!latestCached || !isFreshEnoughToSkipLiveFetch(symbol, range)) {
    const fetchDuration = latestCached ? cfg.topUpDuration : cfg.fullDuration;
    const freshBars = await fetchHistoricalBarsRaw(connection, symbol, cfg.barSize, fetchDuration, reqId);
    await upsertIntradayBars(tickerId, cfg.barSize, freshBars);
    markLiveFetched(symbol, range);
  }

  return readIntradayBars(tickerId, cfg.barSize, subtractDuration(new Date(), cfg.fullDuration));
}

/** Open-own-connection variant — mirrors fetchTickerOverview.ts's fetchPriceBars, cached. */
export async function fetchCachedPriceBars(symbol: string, range: ChartRange): Promise<PriceBar[]> {
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);
    return await getCachedChartBars(connection, symbol, range);
  } finally {
    connection.disconnect();
  }
}
