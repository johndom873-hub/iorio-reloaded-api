import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { loadDailyBarsOf } from "../analysis/analysisFigures.js";
import { expiryDaysAmong } from "../analysis/analysisDayInputs.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { observedChainDayOf, type ObservedChainDay } from "./portfolioObservedChain.js";
import { expirySettlementInstant } from "../engine/ledger/ledgerEvents.js";
import { captureLookTimeEt, lookInstantMs } from "../engine/backtestTickerInputs.js";

// What the portfolio simulator reads of each ticker today (D3, D4, Marcelo 2026-11-03): the weekdays an expiry ends on
// now, the strikes' spacing listed now, and u, how much higher a same-day Call's own IV ran than IBKR's 30-day IV when
// v4 sold one in the ticker's analysis backtest.

/** The data file's last complete days read for today's expiry weekdays: about 4 weeks. */
export const expiryCalendarDays = 20;

/**
 * One day of the ticker's chain as the simulator reads it: the expiry the day trades (the first on or after it: the day's
 * own on an expiry day), its Calls' and Puts' 10:00 quotes and the previous file day's volumes; null without either.
 */
export function loadObservedChainDay(file: BacktestSymbolFile, input: { dateIso: string; previousFileDay: string | null; stockPrice: number; impliedVolatility: number; riskFreeRate: number }): ObservedChainDay | null {
  const expiry = file.loadCallExpiries(input.dateIso).find((candidate) => candidate >= input.dateIso);
  if (expiry === undefined || input.previousFileDay === null) return null;
  const everyStrike = [0, Number.POSITIVE_INFINITY] as const;
  const quotes = (["C", "P"] as const).flatMap((right) => file.loadQuotesOfContract(input.dateIso, { expiry, right }, ...everyStrike));
  const previousEndOfDay = (["C", "P"] as const).flatMap((right) => file.loadEndOfDayOfContract(input.previousFileDay!, { expiry, right }, ...everyStrike));
  const yearsToExpiry = (expirySettlementInstant(expiry).getTime() - lookInstantMs(input.dateIso, captureLookTimeEt)) / (365 * 86_400_000);
  return observedChainDayOf({ dateIso: input.dateIso, expiry, quotes, previousEndOfDay, stockPrice: input.stockPrice, impliedVolatility: input.impliedVolatility, yearsToExpiry, riskFreeRate: input.riskFreeRate });
}

/** The most frequent gap between neighbouring strikes, among those within `band` of the price; null with fewer than 3. */
export function strikeSpacingOf(strikes: readonly number[], price: number, band = 0.1): number | null {
  const near = [...new Set(strikes.filter((strike) => Math.abs(strike / price - 1) <= band))].sort((a, b) => a - b);
  if (near.length < 3) return null;
  const countByGap = new Map<number, number>();
  for (let index = 1; index < near.length; index++) {
    const gap = Math.round((near[index]! - near[index - 1]!) * 100) / 100;
    countByGap.set(gap, (countByGap.get(gap) ?? 0) + 1);
  }
  return [...countByGap].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

/** u (D4): the median of each Call sale's own IV ÷ IBKR's 30-day IV of the session before; null with no sale to read. */
export function sameDayVolatilityUpliftOf(sales: readonly { date: string; impliedVolatility: number | null }[], thirtyDayIvBefore: (dateIso: string) => number | null): number | null {
  const ratios = sales.flatMap((sale) => {
    const thirtyDay = thirtyDayIvBefore(sale.date);
    return sale.impliedVolatility !== null && sale.impliedVolatility > 0 && thirtyDay !== null && thirtyDay > 0 ? [sale.impliedVolatility / thirtyDay] : [];
  });
  if (ratios.length === 0) return null;
  const sorted = ratios.sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface TickerCalibration {
  symbol: string;
  /** Today's price, as traded: the last daily close. */
  price: number;
  priceDateIso: string;
  /** The weekdays (0 Sunday … 6 Saturday) an expiry ended on in the file's last 4 weeks. */
  expiryWeekdays: number[];
  strikeSpacing: number;
  /** Null when the ticker's analysis sold no Call with an IV to read. */
  sameDayVolatilityUplift: number | null;
}

/** Today's calendar, spacing, price and u of a ticker with a data file and an analysis. */
export async function loadTickerCalibration(symbol: string, connection: Knex = db): Promise<TickerCalibration> {
  const { bars } = await loadDailyBarsOf(symbol, connection);
  const last = [...bars].reverse().find((bar) => bar.close !== null);
  if (!last) throw new Error(`${symbol}: no daily bars`);
  const file = BacktestSymbolFile.open(symbol);
  let expiryWeekdays: number[];
  let strikeSpacing: number | null;
  try {
    const completeDays = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
    const recent = completeDays.slice(-expiryCalendarDays);
    expiryWeekdays = [...new Set([...expiryDaysAmong(file, recent)].map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()))].sort();
    const lastDay = completeDays.at(-1)!;
    const quotes = file.loadQuotes(lastDay).filter((quote) => quote.right === "C");
    const nearestExpiry = quotes.reduce<string | null>((nearest, quote) => (nearest === null || quote.expiry < nearest ? quote.expiry : nearest), null);
    strikeSpacing = strikeSpacingOf(quotes.filter((quote) => quote.expiry === nearestExpiry).map((quote) => quote.strike), last.close!);
  } finally {
    file.close();
  }
  const analysis: { figures: { analysisBacktest?: { callSales?: [string, number, number, number, number | null, number | null][] } } | null } | undefined = await connection("backtest_ticker_analyses").where({ symbol, status: "succeeded" }).orderBy("created_at", "desc").first("figures");
  const sales = (analysis?.figures?.analysisBacktest?.callSales ?? []).map(([date, , , , impliedVolatility]) => ({ date, impliedVolatility }));
  const ivByDate = new Map(bars.filter((bar) => bar.impliedVolatility !== null).map((bar) => [bar.tradingDate, bar.impliedVolatility!]));
  const datesWithIv = [...ivByDate.keys()].sort();
  const thirtyDayIvBefore = (dateIso: string) => {
    let low = 0;
    let high = datesWithIv.length - 1;
    let found: string | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (datesWithIv[middle]! < dateIso) {
        found = datesWithIv[middle]!;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found === null ? null : ivByDate.get(found)!;
  };
  return {
    symbol,
    price: last.close!,
    priceDateIso: last.tradingDate,
    expiryWeekdays,
    strikeSpacing: strikeSpacing ?? (last.close! < 25 ? 0.5 : last.close! < 200 ? 1 : 2.5),
    sameDayVolatilityUplift: sameDayVolatilityUpliftOf(sales, thirtyDayIvBefore),
  };
}
