import type { EffectiveBacktestSettings } from "../backtestTypes.js";
import { tickerPathPrices, tradingDaysPerYear, type DayPath, type TickerDayHistory } from "./portfolioDayHistory.js";
import { simulateBookDays, type SimulatedTickerFigures, type SimulationSources } from "./portfolioDaySimulator.js";
import { anchorFactorAt, observedDaysNearest, type AnchorCurve, type ObservedChainDay } from "./portfolioObservedChain.js";

// The portfolio simulator's projection (D1–D6, Marcelo 2026-11-03): each path is the book run through v4's own day
// (portfolioDaySimulator.ts) on simulated sessions, the weekdays after today. A ticker's 10:00 price and close follow its
// history days' moves from today's price (portfolioDayHistory.ts); its next expiry is the first session on or after the
// day falling on one of today's expiry weekdays (D3); its chain is one of its last 60 sessions' chains with the same days
// to expiry, drawn per path, ticker and day, read at the day's anchor (the 30-day IV × the ticker's factor at the day's
// elevation; portfolioObservedChain.ts); cash earns the T-bill now.

/** What one ticker brings to a projection: plain arrays, so a worker thread can take them. */
export interface ProjectionTicker {
  symbol: string;
  history: TickerDayHistory;
  /** Today's price, as traded. */
  todaysPrice: number;
  strikeSpacing: number;
  /** 0 Sunday … 6 Saturday. */
  expiryWeekdays: number[];
  /** u: the chain's pricing where an observed day has no IV to read. */
  sameDayVolatilityUplift: number;
  /** The last 60 sessions' chains, each against its own anchor. */
  observedDays: ObservedChainDay[];
  anchorCurve: AnchorCurve;
  /** Where a day without its own moves takes its leftover from (tickerPathPrices): the book's shared days, or its own. */
  leftoverDays: Int32Array;
}

export interface ProjectionInput {
  asOfIso: string;
  tickers: ProjectionTicker[];
  /** The lab's settings with the book's allocations (volFarmerV4.tickerAllocationPct). */
  settings: EffectiveBacktestSettings;
  accountDollars: number;
  horizonYears: number;
  drift: "as_it_happened" | "neutral";
  riskFreeRatePercent: number;
  seed: number;
}

export interface PathOutcome {
  cagr: number;
  maxDrawdown: number;
  /** The Max drawdown's peak and trough, simulated day indexes. */
  maxDrawdownFrom: number;
  maxDrawdownTo: number;
  endValue: number;
  /** The account at the end of each simulated year. */
  yearEndValues: number[];
  sources: SimulationSources;
  byTicker: SimulatedTickerFigures[];
}

/** `count` weekdays after `asOfIso` (holidays are not left out). */
export function simulatedSessionsAfter(asOfIso: string, count: number): string[] {
  const dates: string[] = [];
  for (let at = Date.parse(`${asOfIso}T00:00:00Z`) + 86_400_000; dates.length < count; at += 86_400_000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** Each session's next expiry: the first date on or after it falling on one of `weekdays` (Friday with none). */
export function nextExpiriesOf(dates: readonly string[], weekdays: readonly number[]): string[] {
  const days = weekdays.length > 0 ? new Set(weekdays) : new Set([5]);
  return dates.map((date) => {
    for (let at = Date.parse(`${date}T00:00:00Z`); ; at += 86_400_000) if (days.has(new Date(at).getUTCDay())) return new Date(at).toISOString().slice(0, 10);
  });
}

const calendarDaysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/** A ticker's key in projectionDraw: its symbol's 32-bit FNV-1a hash, so its draws are the same in any book. */
export function tickerDrawKey(symbol: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < symbol.length; at++) hash = Math.imul(hash ^ symbol.charCodeAt(at), 0x01000193) >>> 0;
  return hash;
}

/** A draw in [0, 1) for a path, ticker (tickerDrawKey) and day: the same each run (mulberry32 on the three). */
export function projectionDraw(seed: number, pathIndex: number, tickerKey: number, dayIndex: number): number {
  let state = (Math.imul(seed ^ 0x9e3779b9, 31) + pathIndex * 1_000_003 + Math.imul(tickerKey, 10_007) + dayIndex * 7_919) >>> 0;
  state = (state + 0x6d2b79f5) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

/** Max drawdown on the daily values: the deepest fall from a peak, with its peak and trough. */
export function maxDrawdownOf(values: ArrayLike<number>): { maxDrawdown: number; from: number; to: number } {
  let peak = values[0]!;
  let peakAt = 0;
  let worst = 0;
  let from = 0;
  let to = 0;
  for (let at = 0; at < values.length; at++) {
    if (values[at]! > peak) [peak, peakAt] = [values[at]!, at];
    const fall = values[at]! / peak - 1;
    if (fall < worst) [worst, from, to] = [fall, peakAt, at];
  }
  return { maxDrawdown: worst, from, to };
}

/** One path through v4's own day on `dates` (the path as long as them): the simulator's result. */
function simulatePath(input: ProjectionInput, path: DayPath, pathIndex: number, dates: readonly string[], expiriesByTicker: readonly string[][]) {
  const prices = input.tickers.map((ticker) => tickerPathPrices(ticker.history, path, ticker.todaysPrice, input.drift, ticker.leftoverDays));
  const drawKeys = input.tickers.map((ticker) => tickerDrawKey(ticker.symbol));
  return simulateBookDays({
    dates,
    tickers: input.tickers.map((ticker) => ({ symbol: ticker.symbol, sameDayVolatilityUplift: ticker.sameDayVolatilityUplift })),
    dayOf: (tickerIndex, day) => {
      const ticker = input.tickers[tickerIndex]!;
      const price = prices[tickerIndex]!;
      const nextExpiry = expiriesByTicker[tickerIndex]![day]!;
      const candidates = observedDaysNearest(ticker.observedDays, calendarDaysBetween(dates[day]!, nextExpiry));
      const elevation = price.elevation[day]!;
      const impliedVolatility = price.iv[day]!;
      return {
        tenOclockPrice: price.tenOclock[day]!,
        close: price.close[day]!,
        impliedVolatility,
        nextExpiry,
        strikeSpacing: ticker.strikeSpacing,
        observedChain:
          candidates.length === 0
            ? null
            : { day: candidates[Math.floor(projectionDraw(input.seed, pathIndex, drawKeys[tickerIndex]!, day) * candidates.length)]!, volatilityAnchor: impliedVolatility * anchorFactorAt(ticker.anchorCurve, Number.isFinite(elevation) ? elevation : null) },
      };
    },
    settings: input.settings,
    startingValue: input.accountDollars,
    riskFreeRatePercent: input.riskFreeRatePercent,
  });
}

/** Runs the paths `paths` (their indexes from `firstPathIndex`): one outcome each. */
export async function runProjectionPaths(input: ProjectionInput, paths: readonly DayPath[], firstPathIndex: number, onPathDone?: () => void): Promise<PathOutcome[]> {
  const horizonDays = Math.round(input.horizonYears * tradingDaysPerYear);
  const dates = simulatedSessionsAfter(input.asOfIso, horizonDays);
  const expiriesByTicker = input.tickers.map((ticker) => nextExpiriesOf(dates, ticker.expiryWeekdays));
  const outcomes: PathOutcome[] = [];
  for (let offset = 0; offset < paths.length; offset++) {
    const result = await simulatePath(input, paths[offset]!, firstPathIndex + offset, dates, expiriesByTicker);
    const values = result.accountValues;
    const endValue = values[values.length - 1]!;
    const { maxDrawdown, from, to } = maxDrawdownOf(values);
    const yearEndValues: number[] = [];
    for (let year = 1; year * tradingDaysPerYear <= horizonDays; year++) yearEndValues.push(values[Math.min(values.length - 1, year * tradingDaysPerYear)]!);
    outcomes.push({ cagr: (endValue / input.accountDollars) ** (1 / input.horizonYears) - 1, maxDrawdown, maxDrawdownFrom: from, maxDrawdownTo: to, endValue, yearEndValues, sources: result.sources, byTicker: result.byTicker });
    onPathDone?.();
  }
  return outcomes;
}

export interface ReplayWindow {
  name: string;
  /** The window's history days (indexes into the market's dates), in order. */
  days: Int32Array;
}

export interface ReplayOutcome {
  name: string;
  bookReturn: number;
  maxDrawdown: number;
  sources: SimulationSources;
}

/**
 * Each window replayed as one path: today's book from today's prices through the window's days in order, at their
 * actual moves (the input's drift), on simulated sessions after today; a ticker's day before its listing is β × SPY's
 * moves with no leftover.
 */
export async function runReplayPaths(input: ProjectionInput, windows: readonly ReplayWindow[]): Promise<ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];
  for (const window of windows) {
    const dates = simulatedSessionsAfter(input.asOfIso, window.days.length);
    const expiriesByTicker = input.tickers.map((ticker) => nextExpiriesOf(dates, ticker.expiryWeekdays));
    const result = await simulatePath({ ...input, tickers: input.tickers.map((ticker) => ({ ...ticker, leftoverDays: new Int32Array(0) })) }, { days: window.days, leftoverDraws: new Float64Array(window.days.length) }, 0, dates, expiriesByTicker);
    const values = result.accountValues;
    outcomes.push({ name: window.name, bookReturn: values[values.length - 1]! / input.accountDollars - 1, maxDrawdown: maxDrawdownOf(values).maxDrawdown, sources: result.sources });
  }
  return outcomes;
}
