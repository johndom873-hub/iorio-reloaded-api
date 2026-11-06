import type { EffectiveBacktestSettings } from "../backtestTypes.js";
import { tickerPathPrices, tradingDaysPerYear, type DayPath, type TickerDayHistory, type VolatilityStart } from "./portfolioDayHistory.js";
import { simulateBookDays, simulateBookDaysAtStartingValues, type SimulatedTickerFigures, type SimulationSources } from "./portfolioDaySimulator.js";
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
  /** V3: its dividend yield a year (portfolioProjectionInputs.ts), paid on the shares held each simulated day; 0 without one. */
  dividendYield: number;
  /** Today's IV and its half-life: a path's first days start from it (VolatilityStart); null without today's IV. */
  volatilityStart: VolatilityStart | null;
  /** Per history day, the anchor's event factor: its macro factor on a macro event day, its earnings one on a reaction day, else 1. */
  eventAnchorFactor: Float64Array;
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
  /** SPY's log moves each history day (overnight: the previous close to 10:00; day: 10:00 to the close): the book betas' x. Absent, no betas. */
  spyMoves?: { overnight: Float64Array; day: Float64Array };
  /** SPY as a ticker held beside the book (its buy and hold on the same paths, Marcelo 2026-11-04); absent, none. */
  spyHeld?: ProjectionTicker;
}

/** A buy and hold's figures on one path: CAGR, Max drawdown on its daily values, its lowest value ÷ the start − 1, and its value at each year's end. */
export interface HeldFigures {
  cagr: number;
  maxDrawdown: number;
  lowestAgainstStart: number;
  yearEndValues: number[];
}

/** A least-squares slope's sums over the days counted: x is SPY's day, y the book's. */
export interface RegressionSums {
  count: number;
  sumSpy: number;
  sumBook: number;
  sumSpyBook: number;
  sumSpySquared: number;
}

const emptyRegressionSums = (): RegressionSums => ({ count: 0, sumSpy: 0, sumBook: 0, sumSpyBook: 0, sumSpySquared: 0 });

/** Adds one day to `sums`. */
export function addRegressionDay(sums: RegressionSums, spy: number, book: number): void {
  sums.count += 1;
  sums.sumSpy += spy;
  sums.sumBook += book;
  sums.sumSpyBook += spy * book;
  sums.sumSpySquared += spy * spy;
}

export interface PathOutcome {
  cagr: number;
  maxDrawdown: number;
  /** The account's lowest value ÷ the starting account − 1 (Max drawdown is from any peak instead). */
  lowestAgainstStart: number;
  /** On the same path: the book's tickers held at their allocations from today's prices, and SPY held (null without spyHeld). */
  heldBook: HeldFigures;
  heldSpy: HeldFigures | null;
  /** The Max drawdown's peak and trough, simulated day indexes. */
  maxDrawdownFrom: number;
  maxDrawdownTo: number;
  endValue: number;
  /** The account at the end of each simulated year. */
  yearEndValues: number[];
  sources: SimulationSources;
  byTicker: SimulatedTickerFigures[];
  /** The book's daily returns against SPY's over the same stretches: every day, and the days SPY fell (null without spyMoves). */
  spyRegression: { all: RegressionSums; down: RegressionSums } | null;
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
export async function simulatePath(input: ProjectionInput, path: DayPath, pathIndex: number, dates: readonly string[], expiriesByTicker: readonly string[][]) {
  const { simulation, prices } = pathSimulationOf(input, path, pathIndex, dates, expiriesByTicker);
  const result = await simulateBookDays({ ...simulation, startingValue: input.accountDollars });
  return { result, prices };
}

/** One path's simulation input (every account's but the starting value) and its prices. */
function pathSimulationOf(input: ProjectionInput, path: DayPath, pathIndex: number, dates: readonly string[], expiriesByTicker: readonly string[][]) {
  const prices = input.tickers.map((ticker) => tickerPathPrices(ticker.history, path, ticker.todaysPrice, input.drift, ticker.leftoverDays, ticker.volatilityStart));
  const drawKeys = input.tickers.map((ticker) => tickerDrawKey(ticker.symbol));
  const simulation: Omit<Parameters<typeof simulateBookDays>[0], "startingValue"> = {
    dates,
    tickers: input.tickers.map((ticker) => ({ symbol: ticker.symbol, sameDayVolatilityUplift: ticker.sameDayVolatilityUplift, dividendYield: ticker.dividendYield })),
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
            : {
                day: candidates[Math.floor(projectionDraw(input.seed, pathIndex, drawKeys[tickerIndex]!, day) * candidates.length)]!,
                volatilityAnchor: impliedVolatility * anchorFactorAt(ticker.anchorCurve, Number.isFinite(elevation) ? elevation : null) * ticker.eventAnchorFactor[path.days[day]!]!,
              },
      };
    },
    settings: input.settings,
    riskFreeRatePercent: input.riskFreeRatePercent,
  };
  return { simulation, prices };
}

/**
 * A buy and hold on one path (Marcelo 2026-11-04): each ticker's weight of the account in shares at today's price, never
 * traded, its dividend yield ÷ 252 a day credited in cash on the shares' value at the previous close, the rest of the account
 * and the dividends in cash at the T-bill now. Values at the start and each day's close, as the account's.
 */
export function heldValuesOf(holdings: readonly { weight: number; todaysPrice: number; close: Float64Array; dividendYield: number }[], accountDollars: number, riskFreeRatePercent: number): Float64Array {
  const days = holdings[0]?.close.length ?? 0;
  const values = new Float64Array(days + 1);
  values[0] = accountDollars;
  let cash = accountDollars * Math.max(0, 1 - holdings.reduce((sum, holding) => sum + holding.weight, 0));
  for (let day = 0; day < days; day++) {
    cash *= 1 + riskFreeRatePercent / 100 / tradingDaysPerYear;
    let shares = 0;
    for (const holding of holdings) {
      const previous = day === 0 ? holding.todaysPrice : holding.close[day - 1]!;
      cash += (accountDollars * holding.weight * (previous / holding.todaysPrice) * holding.dividendYield) / tradingDaysPerYear;
      shares += accountDollars * holding.weight * (holding.close[day]! / holding.todaysPrice);
    }
    values[day + 1] = shares + cash;
  }
  return values;
}

function heldFiguresOf(values: Float64Array, accountDollars: number, horizonYears: number): HeldFigures {
  let lowest = accountDollars;
  for (const value of values) lowest = Math.min(lowest, value);
  const yearEndValues: number[] = [];
  for (let year = 1; year * tradingDaysPerYear < values.length; year++) yearEndValues.push(values[year * tradingDaysPerYear]!);
  return { cagr: (values[values.length - 1]! / accountDollars) ** (1 / horizonYears) - 1, maxDrawdown: maxDrawdownOf(values).maxDrawdown, lowestAgainstStart: lowest / accountDollars - 1, yearEndValues };
}

/** Runs the paths `paths` (their indexes from `firstPathIndex`): one outcome each. */
export async function runProjectionPaths(input: ProjectionInput, paths: readonly DayPath[], firstPathIndex: number, onPathDone?: () => void): Promise<PathOutcome[]> {
  const horizonDays = Math.round(input.horizonYears * tradingDaysPerYear);
  const dates = simulatedSessionsAfter(input.asOfIso, horizonDays);
  const expiriesByTicker = input.tickers.map((ticker) => nextExpiriesOf(dates, ticker.expiryWeekdays));
  const outcomes: PathOutcome[] = [];
  for (let offset = 0; offset < paths.length; offset++) {
    const { result, prices } = await simulatePath(input, paths[offset]!, firstPathIndex + offset, dates, expiriesByTicker);
    const values = result.accountValues;
    const endValue = values[values.length - 1]!;
    const { maxDrawdown, from, to } = maxDrawdownOf(values);
    let lowest = input.accountDollars;
    for (const value of values) lowest = Math.min(lowest, value);
    const weights = input.settings.volFarmerV4.tickerAllocationPct;
    const heldBook = heldFiguresOf(
      heldValuesOf(input.tickers.map((ticker, index) => ({ weight: (weights[ticker.symbol] ?? 0) / 100, todaysPrice: ticker.todaysPrice, close: prices[index]!.close, dividendYield: ticker.dividendYield })), input.accountDollars, input.riskFreeRatePercent),
      input.accountDollars,
      input.horizonYears,
    );
    const spy = input.spyHeld;
    const heldSpy = spy
      ? heldFiguresOf(heldValuesOf([{ weight: 1, todaysPrice: spy.todaysPrice, close: tickerPathPrices(spy.history, paths[offset]!, spy.todaysPrice, input.drift, new Int32Array(0), spy.volatilityStart).close, dividendYield: spy.dividendYield }], input.accountDollars, input.riskFreeRatePercent), input.accountDollars, input.horizonYears)
      : null;
    const yearEndValues: number[] = [];
    for (let year = 1; year * tradingDaysPerYear <= horizonDays; year++) yearEndValues.push(values[Math.min(values.length - 1, year * tradingDaysPerYear)]!);
    let spyRegression: PathOutcome["spyRegression"] = null;
    if (input.spyMoves) {
      // The values are the account at each day's 10:00, then at the last close: each step is matched with SPY's move over
      // the same stretch (today's close to the first 10:00, 10:00 to 10:00, the last 10:00 to the close).
      const { overnight, day: dayMove } = input.spyMoves;
      spyRegression = { all: emptyRegressionSums(), down: emptyRegressionSums() };
      const pathDays = paths[offset]!.days;
      const last = values.length - 1;
      for (let step = 0; step < values.length; step++) {
        const logMove = (step > 0 ? dayMove[pathDays[step - 1]!]! : 0) + (step < last ? overnight[pathDays[step]!]! : 0);
        const spy = Math.exp(logMove) - 1;
        const book = values[step]! / (step === 0 ? input.accountDollars : values[step - 1]!) - 1;
        addRegressionDay(spyRegression.all, spy, book);
        if (spy < 0) addRegressionDay(spyRegression.down, spy, book);
      }
    }
    outcomes.push({ cagr: (endValue / input.accountDollars) ** (1 / input.horizonYears) - 1, maxDrawdown, lowestAgainstStart: lowest / input.accountDollars - 1, heldBook, heldSpy, maxDrawdownFrom: from, maxDrawdownTo: to, endValue, yearEndValues, sources: result.sources, byTicker: result.byTicker, spyRegression });
    onPathDone?.();
  }
  return outcomes;
}

/**
 * Each path's account value every simulated day as a share of the starting value, one path after another, for each of
 * `accountsDollars` in place of the input's accountDollars (the suggestions' library's pot levels, portfolioLibrary.ts):
 * every path is run once for all of them (simulateBookDaysAtStartingValues). One array per account, in their order;
 * `onPathDone` after each path.
 */
export async function runPathValuesAtAccounts(input: ProjectionInput, accountsDollars: readonly number[], paths: readonly DayPath[], firstPathIndex: number, onPathDone?: () => void): Promise<Float32Array[]> {
  const horizonDays = Math.round(input.horizonYears * tradingDaysPerYear);
  const dates = simulatedSessionsAfter(input.asOfIso, horizonDays);
  const expiriesByTicker = input.tickers.map((ticker) => nextExpiriesOf(dates, ticker.expiryWeekdays));
  const valuesByAccount = accountsDollars.map(() => new Float32Array(paths.length * horizonDays));
  for (let offset = 0; offset < paths.length; offset++) {
    const { simulation } = pathSimulationOf(input, paths[offset]!, firstPathIndex + offset, dates, expiriesByTicker);
    const results = await simulateBookDaysAtStartingValues(simulation, accountsDollars);
    results.forEach((result, account) => {
      const values = valuesByAccount[account]!;
      const accountDollars = accountsDollars[account]!;
      for (let day = 0; day < horizonDays; day++) values[offset * horizonDays + day] = result.accountValues[day]! / accountDollars;
    });
    onPathDone?.();
  }
  return valuesByAccount;
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
  byTicker: SimulatedTickerFigures[];
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
    const { result } = await simulatePath({ ...input, tickers: input.tickers.map((ticker) => ({ ...ticker, leftoverDays: new Int32Array(0), volatilityStart: null })) }, { days: window.days, leftoverDraws: new Float64Array(window.days.length) }, 0, dates, expiriesByTicker);
    const values = result.accountValues;
    outcomes.push({ name: window.name, bookReturn: values[values.length - 1]! / input.accountDollars - 1, maxDrawdown: maxDrawdownOf(values).maxDrawdown, sources: result.sources, byTicker: result.byTicker });
  }
  return outcomes;
}
