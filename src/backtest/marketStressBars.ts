import { BarSizeSetting } from "@stoqey/ib";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { fetchHistoricalBarsRaw, type PriceBar } from "../ibkr/fetchTickerOverview.js";
import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { normalizeBarVolume } from "../lib/normalizeBarVolume.js";

// SPY's price inside the day, for the backtest's market-stress check (docs/backtesting/FORMULAS.md): IBKR's 30-minute
// TRADES bars of the regular session, stored in intraday_price_bars under the bar size the 1M chart already caches
// ("30 mins"; one row per bar, keyed by its start). The check reads, at a look time, the close of the bar that ends
// then, against the close of the previous session's last bar.
//
// IBKR serves a whole year of these bars in one historical request (probed 2026-10-12: 3,277 bars of 2020 in 6 s), so
// the backfill is one request per calendar year, a pause between them. Only bars that are not stored yet are written.

export const marketStressSymbol = "SPY";
export const marketStressBarSize = BarSizeSetting.MINUTES_THIRTY;
export const marketStressBarMinutes = 30;
/** The first year the option data files can hold (defaultDownloadStartDate). */
export const marketStressHistoryStartYear = 2020;
const requestTimeoutMilliseconds = 120_000;
const insertChunkSize = 1000;

/** IBKR's end time of a historical request: an instant in UTC. */
export function ibkrEndDateTime(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19)}`;
}

export interface MarketStressBackfillYear {
  year: number;
  fetchedBars: number;
  insertedBars: number;
}

/**
 * Fetches SPY's 30-minute bars year by year from `fromYear` to the year of `lastDateToStore` and stores the bars of
 * sessions up to that date that are not stored yet. `pause` runs between two requests.
 */
export async function backfillMarketStressBars(
  connection: IbkrConnection,
  options: { fromYear?: number; lastDateToStore: string; nextRequestId: () => number; pause: () => Promise<void>; onYear?: (year: MarketStressBackfillYear) => void; now?: Date },
  database: Knex = db,
): Promise<MarketStressBackfillYear[]> {
  const ticker: { id: string } | undefined = await database("tickers").where({ symbol: marketStressSymbol }).first("id");
  if (!ticker) throw new Error(`${marketStressSymbol} is not in the local tickers table: its bars are stored under its ticker.`);
  const lastYear = Number(options.lastDateToStore.slice(0, 4));
  const years: MarketStressBackfillYear[] = [];
  for (let year = options.fromYear ?? marketStressHistoryStartYear; year <= lastYear; year++) {
    if (years.length > 0) await options.pause();
    // The year ends at midnight Eastern of 1 January; 06:00 UTC is past it in winter time and the market is closed. The
    // running year is asked for up to now.
    const yearEnd = new Date(Math.min(Date.UTC(year + 1, 0, 1, 6, 0, 0), (options.now ?? new Date()).getTime()));
    const fetched = await fetchHistoricalBarsRaw(connection, marketStressSymbol, marketStressBarSize, "1 Y", options.nextRequestId(), undefined, { endDateTime: ibkrEndDateTime(yearEnd), timeoutMs: requestTimeoutMilliseconds });
    const bars = fetched.filter((bar) => {
      const tradingDate = easternIsoDate(new Date(bar.time * 1000));
      return tradingDate.startsWith(String(year)) && tradingDate <= options.lastDateToStore;
    });
    const result: MarketStressBackfillYear = { year, fetchedBars: bars.length, insertedBars: await insertMissingIntradayBars(ticker.id, bars, database) };
    years.push(result);
    options.onYear?.(result);
  }
  return years;
}

async function insertMissingIntradayBars(tickerId: string, bars: readonly PriceBar[], database: Knex): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < bars.length; start += insertChunkSize) {
    const rows = bars.slice(start, start + insertChunkSize).map((bar) => ({ ticker_id: tickerId, bar_size: marketStressBarSize, bar_time: new Date(bar.time * 1000), open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: normalizeBarVolume(bar.volume) }));
    const written = await database("intraday_price_bars").insert(rows).onConflict(["ticker_id", "bar_size", "bar_time"]).ignore().returning("id");
    inserted += written.length;
  }
  return inserted;
}

const formatClockTime = (minutesOfDay: number) => `${String(Math.floor(minutesOfDay / 60)).padStart(2, "0")}:${String(minutesOfDay % 60).padStart(2, "0")}`;

/** SPY inside the day, by session: the price at each half hour and the session's last price. */
export class MarketStressPrices {
  /** Per Eastern date: the close of the bar ending at each "HH:MM". */
  private readonly priceByDateAndTime = new Map<string, Map<string, number>>();
  /** Per Eastern date: the close of its last bar. */
  private readonly lastPriceByDate = new Map<string, number>();
  /** The dates with bars, ascending. */
  private readonly dates: string[];

  constructor(bars: readonly { barTime: Date; close: number }[]) {
    const ascending = [...bars].sort((a, b) => a.barTime.getTime() - b.barTime.getTime());
    for (const bar of ascending) {
      if (!(bar.close > 0)) continue;
      const dateIso = easternIsoDate(bar.barTime);
      const endsAt = formatClockTime(easternMinutesOfDay(bar.barTime) + marketStressBarMinutes);
      let prices = this.priceByDateAndTime.get(dateIso);
      if (!prices) this.priceByDateAndTime.set(dateIso, (prices = new Map()));
      prices.set(endsAt, bar.close);
      this.lastPriceByDate.set(dateIso, bar.close);
    }
    this.dates = [...this.lastPriceByDate.keys()].sort();
  }

  get firstDate(): string | null {
    return this.dates[0] ?? null;
  }

  get lastDate(): string | null {
    return this.dates.at(-1) ?? null;
  }

  hasDate(dateIso: string): boolean {
    return this.priceByDateAndTime.has(dateIso);
  }

  /** SPY's price at `lookTimeEt` ("HH:MM") on a day: the close of the bar ending then; null when it is not stored. */
  priceAt(dateIso: string, lookTimeEt: string): number | null {
    return this.priceByDateAndTime.get(dateIso)?.get(lookTimeEt) ?? null;
  }

  /**
   * SPY's change on the day at `lookTimeEt` ("HH:MM"), in percent: the price then against the last price of the session
   * before `dateIso`. Null when either is not stored.
   */
  dayChangePercentAt(dateIso: string, lookTimeEt: string): number | null {
    const price = this.priceByDateAndTime.get(dateIso)?.get(lookTimeEt);
    if (price === undefined) return null;
    const previousDate = this.previousDateBefore(dateIso);
    const previousClose = previousDate === null ? undefined : this.lastPriceByDate.get(previousDate);
    if (previousClose === undefined || !(previousClose > 0)) return null;
    return ((price - previousClose) / previousClose) * 100;
  }

  private previousDateBefore(dateIso: string): string | null {
    let low = 0;
    let high = this.dates.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.dates[middle]! < dateIso) low = middle + 1;
      else high = middle;
    }
    return low > 0 ? this.dates[low - 1]! : null;
  }
}

/** SPY's stored 30-minute bars from the session before `fromDateIso` through `toDateIso`. Empty when none are stored. */
export async function loadMarketStressPrices(fromDateIso: string, toDateIso: string, database: Knex = db): Promise<MarketStressPrices> {
  const ticker: { id: string } | undefined = await database("tickers").where({ symbol: marketStressSymbol }).first("id");
  if (!ticker) return new MarketStressPrices([]);
  // Ten calendar days back reach the session before the first day across any holiday.
  const rows: { barTime: Date; close: string | null }[] = await database("intraday_price_bars")
    .where({ ticker_id: ticker.id, bar_size: marketStressBarSize })
    .whereRaw("bar_time >= (?::date - 10)::timestamp AT TIME ZONE 'America/New_York'", [fromDateIso])
    .whereRaw("bar_time < (?::date + 1)::timestamp AT TIME ZONE 'America/New_York'", [toDateIso])
    .orderBy("bar_time")
    .select("bar_time as barTime", "close_price as close");
  return new MarketStressPrices(rows.flatMap((row) => (row.close === null ? [] : [{ barTime: new Date(row.barTime), close: Number(row.close) }])));
}
