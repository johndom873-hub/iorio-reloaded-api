import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { DailyOhlcvBar } from "../../lib/realizedVolatility.js";

// One ticker's IBKR daily bars from the local DB, read once per session and sliced per day so that a day only ever sees
// the bars before it (the live loaders read "up to today" from the DB on a live day; on a past day the same query is a
// slice of this history).

export interface StoredDailyBar {
  tradingDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  impliedVolatility: number | null;
}

const numberOrNull = (value: string | number | null): number | null => (value === null ? null : Number(value));

export function isCompleteBar(bar: StoredDailyBar): bar is StoredDailyBar & { open: number; high: number; low: number; close: number } {
  return bar.open !== null && bar.high !== null && bar.low !== null && bar.close !== null;
}

/** The rows as the live loaders map them: complete rows only, volume 0 when missing. */
export function toOhlcvBars(rows: readonly StoredDailyBar[]): DailyOhlcvBar[] {
  return rows.filter(isCompleteBar).map((row) => ({ tradingDate: row.tradingDate, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? 0 }));
}

export class BacktestBarHistory {
  /** `rows` ascending by date. */
  constructor(readonly rows: readonly StoredDailyBar[]) {}

  /** How many rows are dated before `dateIso`. */
  countBefore(dateIso: string): number {
    let low = 0;
    let high = this.rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.rows[middle]!.tradingDate < dateIso) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The last `limit` rows dated before `dateIso`, ascending (the live "order by date desc limit N", reversed). */
  rowsBefore(dateIso: string, limit: number): readonly StoredDailyBar[] {
    const end = this.countBefore(dateIso);
    return this.rows.slice(Math.max(0, end - limit), end);
  }

  /** The close stored for exactly `dateIso`. */
  closeOn(dateIso: string): number | null {
    const index = this.countBefore(dateIso);
    const row = this.rows[index];
    return row && row.tradingDate === dateIso ? row.close : null;
  }

  /** The last close before `dateIso` with its date (loadPreviousClose). */
  previousClose(dateIso: string): { close: number; dateIso: string } | null {
    for (let index = this.countBefore(dateIso) - 1; index >= 0; index--) {
      const row = this.rows[index]!;
      if (row.close !== null) return { close: row.close, dateIso: row.tradingDate };
    }
    return null;
  }

  lastDateIso(): string | null {
    return this.rows.at(-1)?.tradingDate ?? null;
  }

  /** Every price × `factor` (volume and implied volatility unchanged): the split-adjusted bars on a day's traded scale (splitFactors.ts). */
  scaled(factor: number): BacktestBarHistory {
    if (factor === 1) return this;
    const scale = (price: number | null) => (price === null ? null : price * factor);
    return new BacktestBarHistory(this.rows.map((row) => ({ ...row, open: scale(row.open), high: scale(row.high), low: scale(row.low), close: scale(row.close) })));
  }
}

export async function loadBacktestBarHistory(tickerId: string, connection: Knex = db): Promise<BacktestBarHistory> {
  const rows: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null; impliedVolatility: string | null }[] = await connection("daily_price_bars")
    .where({ ticker_id: tickerId })
    .orderBy("trading_date")
    .select(connection.raw('trading_date::text as "tradingDate"'), "open_price as open", "high_price as high", "low_price as low", "close_price as close", "volume", "implied_volatility as impliedVolatility");
  return new BacktestBarHistory(rows.map((row) => ({ tradingDate: row.tradingDate, open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: numberOrNull(row.close), volume: numberOrNull(row.volume), impliedVolatility: numberOrNull(row.impliedVolatility) })));
}
