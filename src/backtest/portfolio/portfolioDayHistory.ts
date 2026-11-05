import { seededRandom } from "../../lib/seededRandom.js";
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
// - The paths are blocks of 250 consecutive history days (a year; 20 until Marcelo 2026-11-04: shorter blocks broke up
//   long bear markets, so the worst Max drawdowns came out milder than real 5-year windows'), drawn at random with
//   replacement, the same dates for every ticker, from a seeded generator so a book gets the same paths every time.

export const dayHistoryStartIso = "2006-01-01";
export const pathBlockDays = 250;
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
  /** V4: SPY's dividends over these dates (each as a share of the close before its ex-date) ÷ their count: its average day's dividend. */
  meanDividendDay: number;
}

function medianOf(values: Iterable<number>): number | null {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function marketDayHistoryOf(spySessions: readonly HistorySession[], spyDividendShares: readonly { exDividendDate: string; share: number }[]): MarketDayHistory {
  const candidates = spySessions.filter((session) => session.tradingDate >= dayHistoryStartIso).map((session) => session.tradingDate);
  const all = movesOnDates(spySessions, candidates);
  const keep = candidates.map((_, at) => Number.isFinite(all.overnight[at]!) && Number.isFinite(all.day[at]!));
  const pick = (values: Float64Array) => Float64Array.from(values.filter((_, at) => keep[at]));
  const overnight = pick(all.overnight);
  const day = pick(all.day);
  let simpleSum = 0;
  for (let at = 0; at < overnight.length; at++) simpleSum += Math.exp(overnight[at]! + day[at]!) - 1;
  const dates = candidates.filter((_, at) => keep[at]);
  const dividendSum = dates.length === 0 ? 0 : spyDividendShares.filter((dividend) => dividend.exDividendDate > dates[0]! && dividend.exDividendDate <= dates[dates.length - 1]!).reduce((sum, dividend) => sum + dividend.share, 0);
  return {
    dates,
    overnight,
    day,
    iv: pick(all.iv),
    elevation: pick(all.elevation),
    medianIv: medianOf(all.iv) ?? 0.2,
    meanSimpleDay: overnight.length === 0 ? 0 : simpleSum / overnight.length,
    meanDividendDay: dates.length === 0 ? 0 : dividendSum / dates.length,
  };
}

export interface TickerDayHistory {
  symbol: string;
  /** Its moves; on a day without its own, its stand-in's × the volatility ratio, else β × SPY's (the paths add a leftover). */
  overnight: Float64Array;
  day: Float64Array;
  /** 1 on a day of its own, 2 on a day its stand-in fills, 0 on a day β × SPY fills (a leftover drawn there). */
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
  /** The stand-in that fills its days before its own (portfolioStandIns.ts): its moves × `volatilityRatio`, its IV × `ivRatio`. */
  standIn: { symbol: string; volatilityRatio: number; ivRatio: number } | null;
}

/** The shared days a stand-in's ratios need, else 1. */
const standInMinimumSharedDays = 20;

const standardDeviationOf = (values: readonly number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};

/**
 * D1, D2 and the neutral drift for one ticker on the market's dates. `riskFreeNowDay` and `riskFreeMeanDay` are the
 * T-bill's simple day now and on average (rate ÷ 252); `dividendYield` its own (V3), paid as cash, so its price drifts
 * that much less than its total return (V4). With `standIn` (the stand-in's own history on the same dates, Marcelo
 * 2026-11-04), a day before its own takes the stand-in's moves × v, v = its daily volatility ÷ the stand-in's over the days
 * both have their own, and the stand-in's IV × (its median IV ÷ the stand-in's) on those days; β is then read over its own
 * days and the stand-in's together. Example: SKHY moving 1.3 × as much as MU on their shared days turns a 2008 MU day of
 * −8% into −10.4%.
 */
export function tickerDayHistoryOf(symbol: string, sessions: readonly HistorySession[], market: MarketDayHistory, riskFreeNowDay: number, riskFreeMeanDay: number, dividendYield: number, standIn: TickerDayHistory | null = null): TickerDayHistory {
  const count = market.dates.length;
  const moves = movesOnDates(sessions, market.dates);
  const own = new Uint8Array(count);
  let ownDays = 0;
  for (let at = 0; at < count; at++) {
    if (!Number.isFinite(moves.overnight[at]!) || !Number.isFinite(moves.day[at]!)) continue;
    own[at] = 1;
    ownDays++;
  }
  const overnight = new Float64Array(count).fill(Number.NaN);
  const day = new Float64Array(count).fill(Number.NaN);
  for (let at = 0; at < count; at++) {
    if (own[at] !== 1) continue;
    overnight[at] = moves.overnight[at]!;
    day[at] = moves.day[at]!;
  }
  // The stand-in's ratios over the days both have their own.
  let standInFill: TickerDayHistory["standIn"] = null;
  if (standIn !== null) {
    const ownMoves: number[] = [];
    const standInMoves: number[] = [];
    const ownIvs: number[] = [];
    const standInIvs: number[] = [];
    for (let at = 0; at < count; at++) {
      if (own[at] !== 1 || standIn.own[at] !== 1) continue;
      ownMoves.push(overnight[at]! + day[at]!);
      standInMoves.push(standIn.overnight[at]! + standIn.day[at]!);
      if (Number.isFinite(moves.iv[at]!) && Number.isFinite(standIn.iv[at]!)) {
        ownIvs.push(moves.iv[at]!);
        standInIvs.push(standIn.iv[at]!);
      }
    }
    const volatilityRatio = ownMoves.length >= standInMinimumSharedDays && standardDeviationOf(standInMoves) > 0 ? standardDeviationOf(ownMoves) / standardDeviationOf(standInMoves) : 1;
    const ivRatio = ownIvs.length >= standInMinimumSharedDays ? (medianOf(ownIvs) ?? 1) / (medianOf(standInIvs) ?? 1) : 1;
    standInFill = { symbol: standIn.symbol, volatilityRatio, ivRatio };
    for (let at = 0; at < count; at++) {
      if (own[at] === 1) continue;
      overnight[at] = standIn.overnight[at]! * volatilityRatio;
      day[at] = standIn.day[at]! * volatilityRatio;
      // A stand-in day of its own is a full day (no leftover); one the stand-in itself fills from SPY takes a leftover.
      if (standIn.own[at] !== 0) own[at] = 2;
    }
  }
  // β over its own days and its stand-in's.
  let sumOwn = 0;
  let sumMarket = 0;
  let betaDays = 0;
  for (let at = 0; at < count; at++) {
    if (own[at] === 0) continue;
    betaDays++;
    sumOwn += overnight[at]! + day[at]!;
    sumMarket += market.overnight[at]! + market.day[at]!;
  }
  const ownMean = betaDays > 0 ? sumOwn / betaDays : 0;
  const marketMean = betaDays > 0 ? sumMarket / betaDays : 0;
  let covariance = 0;
  let variance = 0;
  for (let at = 0; at < count; at++) {
    if (own[at] === 0) continue;
    const marketMove = market.overnight[at]! + market.day[at]! - marketMean;
    covariance += (overnight[at]! + day[at]! - ownMean) * marketMove;
    variance += marketMove * marketMove;
  }
  const beta = variance > 0 ? covariance / variance : 1;
  const ownIvs = [...moves.iv].filter((value, at) => own[at] === 1 && Number.isFinite(value));
  const ivRatio = ownIvs.length > 0 ? (medianOf(ownIvs) ?? market.medianIv) / market.medianIv : 1;
  const leftoverOvernight = new Float64Array(count).fill(Number.NaN);
  const leftoverDay = new Float64Array(count).fill(Number.NaN);
  const iv = new Float64Array(count);
  const elevation = new Float64Array(count);
  for (let at = 0; at < count; at++) {
    if (own[at] === 1) {
      leftoverOvernight[at] = overnight[at]! - beta * market.overnight[at]!;
      leftoverDay[at] = day[at]! - beta * market.day[at]!;
    } else if (standIn === null) {
      overnight[at] = beta * market.overnight[at]!;
      day[at] = beta * market.day[at]!;
    }
    const ownIv = moves.iv[at]!;
    const standInIv = standIn !== null && own[at] !== 1 && Number.isFinite(standIn.iv[at]!) ? standIn.iv[at]! * standInFill!.ivRatio : Number.NaN;
    iv[at] = Number.isFinite(ownIv) ? ownIv : Number.isFinite(standInIv) ? standInIv : (Number.isFinite(market.iv[at]!) ? market.iv[at]! : market.medianIv) * ivRatio;
    elevation[at] = Number.isFinite(ownIv) ? moves.elevation[at]! : standIn !== null && own[at] !== 1 && Number.isFinite(standIn.elevation[at]!) ? standIn.elevation[at]! : market.elevation[at]!;
  }
  // The history's average simple day, a day without its own moves (or a stand-in's) taking a leftover of its own days in turn.
  const ownPositions: number[] = [];
  for (let at = 0; at < count; at++) if (own[at] === 1) ownPositions.push(at);
  let simpleSum = 0;
  for (let at = 0; at < count; at++) {
    const leftover = own[at] !== 0 || ownPositions.length === 0 ? 0 : leftoverOvernight[ownPositions[at % ownPositions.length]!]! + leftoverDay[ownPositions[at % ownPositions.length]!]!;
    simpleSum += Math.exp(overnight[at]! + day[at]! + leftover) - 1;
  }
  const historyMeanSimpleDay = count === 0 ? 0 : simpleSum / count;
  const target = riskFreeNowDay + beta * (market.meanSimpleDay + market.meanDividendDay - riskFreeMeanDay) - dividendYield / tradingDaysPerYear;
  return { symbol, overnight, day, own, leftoverOvernight, leftoverDay, iv, elevation, beta, ownDays, neutralShift: Math.log((1 + target) / (1 + historyMeanSimpleDay)), standIn: standInFill };
}

/** The half-life of today's IV when its history is too short to read one: about the median of the tickers read (2026-11-04). */
export const defaultIvHalfLifeSessions = 25;
/** The IV sessions a half-life needs (about 3 years with the 250-session median before them). */
const ivHalfLifeMinimumSessions = 750;

/**
 * How fast a ticker's 30-day IV returns to normal: the half-life in sessions of ln(IV ÷ its median over the 250 sessions
 * before), from the slope of each value on the one 20 sessions earlier (a 1-session fit reads IBKR's day-to-day noise as
 * fast decay), clamped to 5–120; null with under 750 sessions of IV. Example: INTC 19, SLV 50, SPY 35 (2026-11-04).
 */
export function ivHalfLifeSessionsOf(sessions: readonly HistorySession[]): number | null {
  const ivs = sessions.flatMap((session) => (session.impliedVolatility !== null && session.impliedVolatility > 0 ? [session.impliedVolatility] : []));
  if (ivs.length < ivHalfLifeMinimumSessions) return null;
  const deviations: number[] = [];
  for (let at = 250; at < ivs.length; at++) deviations.push(Math.log(ivs[at]! / medianOf(ivs.slice(at - 250, at))!));
  let sumProducts = 0;
  let sumSquares = 0;
  for (let at = 20; at < deviations.length; at++) {
    sumProducts += deviations[at]! * deviations[at - 20]!;
    sumSquares += deviations[at - 20]! ** 2;
  }
  const slope = sumSquares > 0 ? sumProducts / sumSquares : 0;
  if (!(slope > 0 && slope < 1)) return slope >= 1 ? 120 : 5;
  return Math.min(120, Math.max(5, (Math.log(0.5) / Math.log(slope)) * 20));
}

/** The history days every ticker of `histories` has its own moves on: where a leftover is drawn from. */
export function sharedLeftoverDays(histories: readonly TickerDayHistory[]): Int32Array {
  const late = histories.filter((history) => history.own.includes(0));
  if (late.length === 0) return new Int32Array(0);
  const days: number[] = [];
  for (let at = 0; at < late[0]!.own.length; at++) if (late.every((history) => history.own[at] === 1)) days.push(at);
  return Int32Array.from(days);
}

/** The own days a late ticker needs to share the book's leftover days (about 2 years); a shorter one draws from its own. */
export const leftoverSharingMinimumOwnDays = 500;
/** The shared days the sharing needs; with fewer, every late ticker draws from its own days. */
const leftoverSharingMinimumDays = 250;

/**
 * Each ticker's leftover days (Marcelo 2026-11-05: "make sure the simulator works well"): the late tickers with at least
 * 500 days of their own share the days they all have (sharedLeftoverDays), so their leftovers fall together as they did; a
 * late ticker with fewer draws from its own days, so one young ticker no longer shrinks every other's pool to its few
 * months (SKHY's 80 days had become the leftovers of IONQ, IREN and RKLB back to 2006). A ticker that is never late gets none.
 */
export function leftoverDaysByTicker(histories: readonly TickerDayHistory[]): Int32Array[] {
  const ownDaysOf = (history: TickerDayHistory) => {
    const days: number[] = [];
    for (let at = 0; at < history.own.length; at++) if (history.own[at] === 1) days.push(at);
    return Int32Array.from(days);
  };
  const sharing = histories.filter((history) => history.own.includes(0) && history.ownDays >= leftoverSharingMinimumOwnDays);
  const shared = sharedLeftoverDays(sharing);
  const shares = shared.length >= leftoverSharingMinimumDays;
  return histories.map((history) => (!history.own.includes(0) ? new Int32Array(0) : shares && sharing.includes(history) ? shared : ownDaysOf(history)));
}

/** The realised ÷ implied volatility a filled day is priced at when the ticker has under 250 own days to read its own (the book's median, 2026-11-05). */
export const defaultRealisedToImpliedRatio = 1.1;

/**
 * A ticker's history with the IV of its filled days matched to their moves (Marcelo 2026-11-05): on its stand-in's days
 * and on its β × SPY days (with the leftovers drawn from `leftoverDays`), the IV × k, k = (the days' realised volatility ÷
 * their average IV) ÷ (the same on its own days; 1.1 with under 250 own days), within 0.5–3, so a filled day's options
 * are as dear against its moves as the ticker's own days' were. Realised = the annualised standard deviation of the
 * 10:00-to-10:00 log moves, a β × SPY day's leftover added as an independent draw. Example: SKHY's β × SPY days moving
 * 115% a year at a 73% IV, its own days 97% at 77% (1.26): k = (115 ÷ 73) ÷ 1.26 = 1.25.
 */
export function withFilledDaysIvMatched(history: TickerDayHistory, leftoverDays: Int32Array): TickerDayHistory {
  const statisticsOf = (flag: number) => {
    const moves: number[] = [];
    let ivSum = 0;
    let ivCount = 0;
    for (let at = 0; at < history.own.length; at++) {
      if (history.own[at] !== flag) continue;
      const move = history.overnight[at]! + history.day[at]!;
      if (!Number.isFinite(move)) continue;
      moves.push(move);
      if (Number.isFinite(history.iv[at]!) && history.iv[at]! > 0) {
        ivSum += history.iv[at]!;
        ivCount++;
      }
    }
    return { moves, iv: ivCount > 0 ? ivSum / ivCount : Number.NaN };
  };
  const varianceOf = (values: readonly number[]) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  };
  const own = statisticsOf(1);
  const target = own.moves.length >= 250 && own.iv > 0 ? Math.sqrt(varianceOf(own.moves) * tradingDaysPerYear) / own.iv : defaultRealisedToImpliedRatio;
  const leftovers = Array.from(leftoverDays, (at) => history.leftoverOvernight[at]! + history.leftoverDay[at]!).filter(Number.isFinite);
  const leftoverVariance = leftovers.length > 1 ? varianceOf(leftovers) : 0;
  const factorOf = (flag: number) => {
    const group = statisticsOf(flag);
    if (group.moves.length < 20 || !(group.iv > 0)) return 1;
    const realised = Math.sqrt((varianceOf(group.moves) + (flag === 0 ? leftoverVariance : 0)) * tradingDaysPerYear);
    return Math.min(3, Math.max(0.5, realised / group.iv / target));
  };
  const factors = [factorOf(0), 1, factorOf(2)];
  if (factors[0] === 1 && factors[2] === 1) return history;
  return { ...history, iv: Float64Array.from(history.iv, (value, at) => value * factors[history.own[at]!]!) };
}

/**
 * One path: `horizonDays` history days in blocks of `blockDays` consecutive ones (250), and for each day a draw in [0, 1) that picks a
 * ticker's leftover day from its list (tickerPathPrices): a path's two streams are seeded by the path alone, so the same
 * path comes out whatever the book, and a shorter horizon's path is the start of a longer one's.
 */
export interface DayPath {
  days: Int32Array;
  leftoverDraws: Float64Array;
}

/** The seed of path `pathIndex`'s stream `stream` (0: its blocks, 1: its leftover draws). */
const pathStreamSeed = (seed: number, pathIndex: number, stream: number) => (Math.imul(seed ^ 0x9e3779b9, 31) + Math.imul(pathIndex + 1, 0x85ebca6b) + Math.imul(stream + 1, 0xc2b2ae35)) >>> 0;

export function drawDayPaths(historyDays: number, horizonDays: number, pathCount: number, seed: number, blockDays = pathBlockDays): DayPath[] {
  return Array.from({ length: pathCount }, (_, pathIndex) => {
    const blocks = seededRandom(pathStreamSeed(seed, pathIndex, 0));
    const leftovers = seededRandom(pathStreamSeed(seed, pathIndex, 1));
    const days = new Int32Array(horizonDays);
    let filled = 0;
    while (filled < horizonDays) {
      const start = Math.floor(blocks() * (historyDays - blockDays + 1));
      for (let offset = 0; offset < blockDays && filled < horizonDays; offset++) days[filled++] = start + offset;
    }
    const leftoverDraws = new Float64Array(horizonDays);
    for (let day = 0; day < horizonDays; day++) leftoverDraws[day] = leftovers();
    return { days, leftoverDraws };
  });
}

/**
 * Today's volatility (Marcelo 2026-11-04): the ticker's 30-day IV now, and how fast its IV returns to normal (its
 * half-life in sessions, ivHalfLifeSessionsOf). A path's first days start from it: step t's moves and IV × s(t) =
 * 1 + (IV now ÷ the drawn day's IV − 1) × 0.5^(t ÷ half-life). Example: INTC at 65% against a drawn day's 46%, half-life
 * 19 sessions: × 1.41 on the first day, × 1.21 after 19 sessions, × 1.05 after 57.
 */
export interface VolatilityStart {
  ivNow: number;
  halfLifeSessions: number;
}

/**
 * A ticker's prices along a path from today's price: the 10:00 price and close of each day, with that day's IV and
 * elevation. A day filled from SPY takes its leftover from `leftoverDays` at the path's draw (none when empty): the
 * book's shared days in a projection (sharedLeftoverDays), the ticker's own in the suggestions' library. With
 * `volatilityStart`, the first days' moves and IV are scaled toward today's (VolatilityStart; the neutral drift's shift
 * is not scaled).
 */
export function tickerPathPrices(history: TickerDayHistory, path: DayPath, todaysPrice: number, drift: "as_it_happened" | "neutral", leftoverDays: Int32Array, volatilityStart: VolatilityStart | null = null): { tenOclock: Float64Array; close: Float64Array; iv: Float64Array; elevation: Float64Array } {
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
    let day = history.day[at]!;
    if (history.own[at] === 0) {
      if (leftoverDays.length > 0) {
        const leftoverAt = leftoverDays[Math.floor(path.leftoverDraws[step]! * leftoverDays.length)]!;
        overnight += history.leftoverOvernight[leftoverAt]!;
        day += history.leftoverDay[leftoverAt]!;
      }
    }
    let scale = 1;
    if (volatilityStart !== null && Number.isFinite(history.iv[at]!) && history.iv[at]! > 0) scale = 1 + (volatilityStart.ivNow / history.iv[at]! - 1) * 0.5 ** (step / volatilityStart.halfLifeSessions);
    if (!(scale > 0)) scale = 1;
    tenOclock[step] = previousClose * Math.exp(overnight * scale);
    close[step] = tenOclock[step]! * Math.exp(day * scale + shift);
    previousClose = close[step]!;
    iv[step] = history.iv[at]! * scale;
    // The elevation is the IV ÷ its own median, so it scales with it.
    elevation[step] = history.elevation[at]! * scale;
  }
  return { tenOclock, close, iv, elevation };
}
