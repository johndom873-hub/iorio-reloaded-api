import { seededRandom } from "./portfolioPaths.js";
import { thirtyDayIvElevation } from "./portfolioObservedChain.js";

// The portfolio simulator's daily history and paths (D1, D2, approved by Marcelo 2026-11-03; the 10:00 price from IBKR's
// 30-minute bars, extended to 2006 on 2026-11-03):
// - The history runs on SPY's sessions from 2006 with a 10:00 price, a close and the previous close. A day has two moves:
//   overnight, ln(10:00 ÷ the previous close), and the day's, ln(close ÷ 10:00), and the 30-day IV known at 10:00 (the
//   latest session's before the day) with its elevation (portfolioObservedChain.ts).
// - D2: a ticker's day without its own moves (before its listing, or a day its file lacks) is β × SPY's moves plus a
//   leftover of its own: its moves less β × SPY's on one of its days, drawn from one date shared by every such ticker of
//   the book on that path day, so late listings keep moving together. β is its daily log moves' slope on SPY's over the
//   days both have. Its IV there is SPY's × (its median ÷ SPY's), its elevation SPY's.
// - Neutral drift: every day's own move gains the same amount, so the ticker's average simple day becomes the T-bill now
//   + β × (SPY's average simple day − the T-bill's average day). Example: a ticker with β 1.5 whose days averaged 0.12%,
//   T-bill now 4% (0.0159% a day), SPY's average day 0.05% against the T-bill's 0.006%: 0.0159% + 1.5 × 0.044% = 0.082%,
//   so each day gains ln(1.00082 ÷ 1.0012).
// - The paths are blocks of 20 consecutive history days drawn at random with replacement, the same dates for every
//   ticker, from a seeded generator so a book gets the same paths every time.

export const dayHistoryStartIso = "2006-01-01";
export const pathBlockDays = 20;
export const tradingDaysPerYear = 252;

/** A session of one symbol: its 10:00 price and close on IBKR's split-adjusted scale, and its 30-day IV (that session's). */
export interface HistorySession {
  tradingDate: string;
  tenOclock: number | null;
  close: number | null;
  impliedVolatility: number | null;
}

/** The days IV known at 10:00 may come from: the latest of the sessions before, at most this many back. */
const ivLookbackSessions = 5;

/** A symbol's moves on `dates`: NaN where it has none (no 10:00 price, close or previous close); IV and elevation known at 10:00, NaN where none. */
export function movesOnDates(sessions: readonly HistorySession[], dates: readonly string[]): { overnight: Float64Array; day: Float64Array; iv: Float64Array; elevation: Float64Array } {
  const index = new Map(sessions.map((session, position) => [session.tradingDate, position]));
  const overnight = new Float64Array(dates.length).fill(Number.NaN);
  const day = new Float64Array(dates.length).fill(Number.NaN);
  const iv = new Float64Array(dates.length).fill(Number.NaN);
  const elevation = new Float64Array(dates.length).fill(Number.NaN);
  const ivBefore = (position: number) => {
    for (let back = position - 1; back >= Math.max(0, position - ivLookbackSessions); back--) {
      const value = sessions[back]!.impliedVolatility;
      if (value !== null && value > 0) return { value, at: back };
    }
    return null;
  };
  dates.forEach((date, at) => {
    const position = index.get(date);
    if (position === undefined || position === 0) return;
    const session = sessions[position]!;
    const previousClose = sessions[position - 1]!.close;
    if (session.tenOclock !== null && session.close !== null && previousClose !== null && session.tenOclock > 0 && session.close > 0 && previousClose > 0) {
      overnight[at] = Math.log(session.tenOclock / previousClose);
      day[at] = Math.log(session.close / session.tenOclock);
    }
    const known = ivBefore(position);
    if (known) {
      iv[at] = known.value;
      const before = sessions.slice(Math.max(0, known.at - 60), known.at).map((entry) => entry.impliedVolatility);
      elevation[at] = thirtyDayIvElevation(known.value, before) ?? Number.NaN;
    }
  });
  return { overnight, day, iv, elevation };
}

export interface MarketDayHistory {
  /** SPY's sessions from 2006 with both moves. */
  dates: string[];
  overnight: Float64Array;
  day: Float64Array;
  iv: Float64Array;
  elevation: Float64Array;
  medianIv: number;
  /** SPY's average simple day, e^(overnight + day) − 1. */
  meanSimpleDay: number;
}

function medianOf(values: Iterable<number>): number | null {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function marketDayHistoryOf(spySessions: readonly HistorySession[]): MarketDayHistory {
  const candidates = spySessions.filter((session) => session.tradingDate >= dayHistoryStartIso).map((session) => session.tradingDate);
  const all = movesOnDates(spySessions, candidates);
  const keep = candidates.map((_, at) => Number.isFinite(all.overnight[at]!) && Number.isFinite(all.day[at]!));
  const pick = (values: Float64Array) => Float64Array.from(values.filter((_, at) => keep[at]));
  const overnight = pick(all.overnight);
  const day = pick(all.day);
  let simpleSum = 0;
  for (let at = 0; at < overnight.length; at++) simpleSum += Math.exp(overnight[at]! + day[at]!) - 1;
  return {
    dates: candidates.filter((_, at) => keep[at]),
    overnight,
    day,
    iv: pick(all.iv),
    elevation: pick(all.elevation),
    medianIv: medianOf(all.iv) ?? 0.2,
    meanSimpleDay: overnight.length === 0 ? 0 : simpleSum / overnight.length,
  };
}

export interface TickerDayHistory {
  symbol: string;
  /** Its own moves; on a day without them β × SPY's (the paths add a leftover). */
  overnight: Float64Array;
  day: Float64Array;
  /** 1 on a day of its own. */
  own: Uint8Array;
  /** Its moves less β × SPY's on its own days (NaN on the others): the leftovers drawn. */
  leftoverOvernight: Float64Array;
  leftoverDay: Float64Array;
  iv: Float64Array;
  elevation: Float64Array;
  beta: number;
  ownDays: number;
  /** Added to every day's move for the neutral drift. */
  neutralShift: number;
}

/**
 * D1, D2 and the neutral drift for one ticker on the market's dates. `riskFreeNowDay` and `riskFreeMeanDay` are the
 * T-bill's simple day now and on average (rate ÷ 252).
 */
export function tickerDayHistoryOf(symbol: string, sessions: readonly HistorySession[], market: MarketDayHistory, riskFreeNowDay: number, riskFreeMeanDay: number): TickerDayHistory {
  const count = market.dates.length;
  const moves = movesOnDates(sessions, market.dates);
  const own = new Uint8Array(count);
  let sumOwn = 0;
  let sumMarket = 0;
  let ownDays = 0;
  for (let at = 0; at < count; at++) {
    if (!Number.isFinite(moves.overnight[at]!) || !Number.isFinite(moves.day[at]!)) continue;
    own[at] = 1;
    ownDays++;
    sumOwn += moves.overnight[at]! + moves.day[at]!;
    sumMarket += market.overnight[at]! + market.day[at]!;
  }
  const ownMean = ownDays > 0 ? sumOwn / ownDays : 0;
  const marketMean = ownDays > 0 ? sumMarket / ownDays : 0;
  let covariance = 0;
  let variance = 0;
  for (let at = 0; at < count; at++) {
    if (own[at] !== 1) continue;
    const marketMove = market.overnight[at]! + market.day[at]! - marketMean;
    covariance += (moves.overnight[at]! + moves.day[at]! - ownMean) * marketMove;
    variance += marketMove * marketMove;
  }
  const beta = variance > 0 ? covariance / variance : 1;
  const ownIvs = [...moves.iv].filter((value, at) => own[at] === 1 && Number.isFinite(value));
  const ivRatio = ownIvs.length > 0 ? (medianOf(ownIvs) ?? market.medianIv) / market.medianIv : 1;
  const overnight = new Float64Array(count);
  const day = new Float64Array(count);
  const leftoverOvernight = new Float64Array(count).fill(Number.NaN);
  const leftoverDay = new Float64Array(count).fill(Number.NaN);
  const iv = new Float64Array(count);
  const elevation = new Float64Array(count);
  for (let at = 0; at < count; at++) {
    if (own[at] === 1) {
      overnight[at] = moves.overnight[at]!;
      day[at] = moves.day[at]!;
      leftoverOvernight[at] = moves.overnight[at]! - beta * market.overnight[at]!;
      leftoverDay[at] = moves.day[at]! - beta * market.day[at]!;
    } else {
      overnight[at] = beta * market.overnight[at]!;
      day[at] = beta * market.day[at]!;
    }
    const ownIv = moves.iv[at]!;
    iv[at] = Number.isFinite(ownIv) ? ownIv : (Number.isFinite(market.iv[at]!) ? market.iv[at]! : market.medianIv) * ivRatio;
    elevation[at] = Number.isFinite(ownIv) ? moves.elevation[at]! : market.elevation[at]!;
  }
  // The history's average simple day, a day without its own moves taking a leftover of its own days in turn.
  const ownPositions: number[] = [];
  for (let at = 0; at < count; at++) if (own[at] === 1) ownPositions.push(at);
  let simpleSum = 0;
  for (let at = 0; at < count; at++) {
    const leftover = own[at] === 1 || ownPositions.length === 0 ? 0 : leftoverOvernight[ownPositions[at % ownPositions.length]!]! + leftoverDay[ownPositions[at % ownPositions.length]!]!;
    simpleSum += Math.exp(overnight[at]! + day[at]! + leftover) - 1;
  }
  const historyMeanSimpleDay = count === 0 ? 0 : simpleSum / count;
  const target = riskFreeNowDay + beta * (market.meanSimpleDay - riskFreeMeanDay);
  return { symbol, overnight, day, own, leftoverOvernight, leftoverDay, iv, elevation, beta, ownDays, neutralShift: Math.log((1 + target) / (1 + historyMeanSimpleDay)) };
}

/** The history days every ticker of `histories` has its own moves on: where a leftover is drawn from. */
export function sharedLeftoverDays(histories: readonly TickerDayHistory[]): Int32Array {
  const late = histories.filter((history) => history.ownDays < history.own.length);
  if (late.length === 0) return new Int32Array(0);
  const days: number[] = [];
  for (let at = 0; at < late[0]!.own.length; at++) if (late.every((history) => history.own[at] === 1)) days.push(at);
  return Int32Array.from(days);
}

/** One path: `horizonDays` history days in blocks of 20 consecutive ones, and a leftover day for each (from `leftoverDays`; −1 with none). */
export interface DayPath {
  days: Int32Array;
  leftoverDays: Int32Array;
}

export function drawDayPaths(historyDays: number, horizonDays: number, pathCount: number, seed: number, leftoverDays: Int32Array, blockDays = pathBlockDays): DayPath[] {
  const random = seededRandom(seed);
  return Array.from({ length: pathCount }, () => {
    const days = new Int32Array(horizonDays);
    const leftovers = new Int32Array(horizonDays).fill(-1);
    let filled = 0;
    while (filled < horizonDays) {
      const start = Math.floor(random() * (historyDays - blockDays + 1));
      for (let offset = 0; offset < blockDays && filled < horizonDays; offset++) days[filled++] = start + offset;
    }
    if (leftoverDays.length > 0) for (let day = 0; day < horizonDays; day++) leftovers[day] = leftoverDays[Math.floor(random() * leftoverDays.length)]!;
    return { days, leftoverDays: leftovers };
  });
}

/** A ticker's prices along a path from today's price: the 10:00 price and close of each day, with that day's IV and elevation. */
export function tickerPathPrices(history: TickerDayHistory, path: DayPath, todaysPrice: number, drift: "as_it_happened" | "neutral"): { tenOclock: Float64Array; close: Float64Array; iv: Float64Array; elevation: Float64Array } {
  const horizon = path.days.length;
  const tenOclock = new Float64Array(horizon);
  const close = new Float64Array(horizon);
  const iv = new Float64Array(horizon);
  const elevation = new Float64Array(horizon);
  const shift = drift === "neutral" ? history.neutralShift : 0;
  let previousClose = todaysPrice;
  for (let step = 0; step < horizon; step++) {
    const at = path.days[step]!;
    let overnight = history.overnight[at]!;
    let day = history.day[at]! + shift;
    if (history.own[at] !== 1) {
      const leftoverAt = path.leftoverDays[step]!;
      if (leftoverAt >= 0) {
        overnight += history.leftoverOvernight[leftoverAt]!;
        day += history.leftoverDay[leftoverAt]!;
      }
    }
    tenOclock[step] = previousClose * Math.exp(overnight);
    close[step] = tenOclock[step]! * Math.exp(day);
    previousClose = close[step]!;
    iv[step] = history.iv[at]!;
    elevation[step] = history.elevation[at]!;
  }
  return { tenOclock, close, iv, elevation };
}
