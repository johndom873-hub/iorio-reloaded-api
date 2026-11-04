// The portfolio simulator's weekly price and IV history (P5 and P6, approved by Marcelo 2026-11-03), from which a book's
// correlation, worst weeks together and groups are read:
// - A week runs Monday to Sunday; its close is the last daily close in it and its IV the last IBKR 30-day IV in it. A
//   ticker's week return is its close ÷ the previous week's close − 1.
// - The history runs on SPY's weeks from 2006 (IBKR's IV starts in 2006-01). A ticker's own weeks are those it traded with
//   a previous week; before its listing a week is β × SPY's move around SPY's average plus one of its own leftover weeks
//   (β from its own weeks: cov ÷ var of SPY), and its IV is SPY's IV × (its median IV ÷ SPY's median IV), as is any week its
//   own IV is missing. Example: a ticker with β 1.5, average week 0.4% against SPY's 0.2%, in a week SPY fell 3%: 0.4% +
//   1.5 × (−3% − 0.2%) = −4.4%, plus the leftover week drawn.
// - IV is capped at `ivCap` when one is given.
// - Neutral drift (P6): every week of a ticker moves by the same amount so its average week becomes T-bill now + β ×
//   (SPY's average week − the T-bill's average week). Example: NVDA's weeks averaged 41.9% a year since 2006; with β 1.62,
//   T-bill now 3.99% and SPY's 10.13% against the T-bill's 1.51%, neutral counts 3.99 + 1.62 × 8.62 = 17.95% a year.

export const weeksPerYear = 52.1775;
export const historyStartIso = "2006-01-01";

export interface DailyCloseAndIv {
  tradingDate: string;
  close: number | null;
  impliedVolatility: number | null;
}

export interface WeeklyBar {
  /** The week's Monday. */
  week: string;
  close: number;
  impliedVolatility: number | null;
}

/** The Monday of `dateIso`'s week. */
export function mondayOf(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - weekday * 86_400_000).toISOString().slice(0, 10);
}

/** Daily bars from `fromIso` into weeks: the last close and the last IV of each. */
export function weeklyBarsOf(dailyBars: readonly DailyCloseAndIv[], fromIso = historyStartIso): WeeklyBar[] {
  const weeks: WeeklyBar[] = [];
  for (const bar of dailyBars) {
    if (bar.close === null || bar.tradingDate < fromIso) continue;
    const week = mondayOf(bar.tradingDate);
    const last = weeks.at(-1);
    if (last && last.week === week) {
      last.close = bar.close;
      if (bar.impliedVolatility !== null) last.impliedVolatility = bar.impliedVolatility;
    } else weeks.push({ week, close: bar.close, impliedVolatility: bar.impliedVolatility });
  }
  return weeks;
}

/** A ticker's week returns and IVs on `weeks` (the history's index): null where it has no own value. */
export function alignToWeeks(bars: readonly WeeklyBar[], weeks: readonly string[]): { returns: (number | null)[]; ivs: (number | null)[] } {
  const at = new Map(weeks.map((week, index) => [week, index]));
  const returns: (number | null)[] = weeks.map(() => null);
  const ivs: (number | null)[] = weeks.map(() => null);
  bars.forEach((bar, index) => {
    const position = at.get(bar.week);
    if (position === undefined) return;
    if (index > 0 && bars[index - 1]!.close > 0) returns[position] = bar.close / bars[index - 1]!.close - 1;
    ivs[position] = bar.impliedVolatility;
  });
  return { returns, ivs };
}

export const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** β of `own` on `market` over the weeks both have: cov ÷ var(market), with both averages. */
export function betaOf(own: readonly (number | null)[], market: readonly (number | null)[]): { beta: number; ownMean: number; marketMean: number; residuals: number[]; ownWeeks: number } {
  const pairs: [number, number][] = [];
  own.forEach((value, index) => {
    const marketValue = market[index];
    if (value !== null && marketValue !== null && marketValue !== undefined) pairs.push([value, marketValue]);
  });
  const ownMean = mean(pairs.map((pair) => pair[0]));
  const marketMean = mean(pairs.map((pair) => pair[1]));
  let covariance = 0;
  let variance = 0;
  for (const [value, marketValue] of pairs) {
    covariance += (value - ownMean) * (marketValue - marketMean);
    variance += (marketValue - marketMean) ** 2;
  }
  const beta = variance > 0 ? covariance / variance : 0;
  return { beta, ownMean, marketMean, residuals: pairs.map(([value, marketValue]) => value - ownMean - beta * (marketValue - marketMean)), ownWeeks: pairs.length };
}

/** A ticker's history on the index, ready for the paths. */
export interface TickerHistory {
  symbol: string;
  /** Its own week return, or (before its listing) β × SPY's move around SPY's average plus its average: no leftover yet. */
  returns: Float64Array;
  /** 1 on a week of its own, 0 on a week modelled from SPY (the paths add one of `residuals`). */
  ownWeek: Uint8Array;
  /** IV at each week's end, its own or SPY's scaled, capped at `ivCap`. */
  ivs: Float64Array;
  /** The same uncapped, for the cap's effect. */
  ivsUncapped: Float64Array;
  residuals: Float64Array;
  beta: number;
  ownWeeks: number;
  /** Added to every week for the neutral drift (P6). */
  neutralShift: number;
  ivCap: number | null;
}

export interface MarketHistory {
  weeks: string[];
  spyReturns: (number | null)[];
  spyIvs: (number | null)[];
  spyMedianIv: number;
  /** SPY's average week over the history. */
  spyMeanWeek: number;
}

export function marketHistoryOf(spyBars: readonly WeeklyBar[]): MarketHistory {
  const weeks = spyBars.map((bar) => bar.week);
  const { returns, ivs } = alignToWeeks(spyBars, weeks);
  const knownIvs = ivs.filter((iv): iv is number => iv !== null);
  return { weeks, spyReturns: returns, spyIvs: ivs, spyMedianIv: median(knownIvs) ?? 0.2, spyMeanWeek: mean(returns.filter((value): value is number => value !== null)) };
}

/**
 * P5 and P6 for one ticker: `riskFreeNowWeek` and `riskFreeMeanWeek` are the T-bill's rate now and on average, a week;
 * `ivCap` the highest weekly IV in its backtest (null: no cap).
 */
export function tickerHistoryOf(symbol: string, bars: readonly WeeklyBar[], market: MarketHistory, ivCap: number | null, riskFreeNowWeek: number, riskFreeMeanWeek: number): TickerHistory {
  const { returns: own, ivs: ownIvs } = alignToWeeks(bars, market.weeks);
  const { beta, ownMean, marketMean, residuals, ownWeeks } = betaOf(own, market.spyReturns);
  const knownIvs = ownIvs.filter((iv): iv is number => iv !== null);
  const ivRatio = knownIvs.length > 0 ? (median(knownIvs) ?? market.spyMedianIv) / market.spyMedianIv : 1;
  const count = market.weeks.length;
  const returns = new Float64Array(count);
  const ownWeek = new Uint8Array(count);
  const ivs = new Float64Array(count);
  const ivsUncapped = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const value = own[index];
    if (value !== null && value !== undefined) {
      returns[index] = value;
      ownWeek[index] = 1;
    } else returns[index] = ownMean + beta * ((market.spyReturns[index] ?? marketMean) - marketMean);
    const iv = ownIvs[index] ?? (market.spyIvs[index] ?? market.spyMedianIv) * ivRatio;
    ivsUncapped[index] = iv;
    ivs[index] = ivCap === null ? iv : Math.min(iv, ivCap);
  }
  const historyMean = mean(Array.from(returns));
  const neutralShift = riskFreeNowWeek + beta * (market.spyMeanWeek - riskFreeMeanWeek) - historyMean;
  return { symbol, returns, ownWeek, ivs, ivsUncapped, residuals: Float64Array.from(residuals.length > 0 ? residuals : [0]), beta, ownWeeks, neutralShift, ivCap };
}
