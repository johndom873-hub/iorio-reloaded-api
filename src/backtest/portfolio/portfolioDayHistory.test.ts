import { describe, expect, it } from "vitest";
import { drawDayPaths, ivHalfLifeSessionsOf, leftoverDaysByTicker, marketDayHistoryOf, movesOnDates, sharedLeftoverDays, tickerDayHistoryOf, tickerPathPrices, withFilledDaysIvMatched, type HistorySession } from "./portfolioDayHistory.js";

const weekdays = (count: number, from = "2006-01-02") => {
  const dates: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); dates.length < count; at += 86_400_000) if (![0, 6].includes(new Date(at).getUTCDay())) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
};

/** Sessions whose close moves by `dayMove(index)` and whose 10:00 price is the previous close × e^`overnight(index)`. */
const sessionsOf = (dates: readonly string[], overnight: (index: number) => number, dayMove: (index: number) => number, iv: (index: number) => number | null = () => 0.2): HistorySession[] => {
  let close = 100;
  return dates.map((tradingDate, index) => {
    const tenOclock = close * Math.exp(overnight(index));
    close = tenOclock * Math.exp(dayMove(index));
    return { tradingDate, tenOclock, close, impliedVolatility: iv(index) };
  });
};

describe("a symbol's daily moves", () => {
  it("splits each day into ln(10:00 ÷ previous close) and ln(close ÷ 10:00), with the latest IV before the day", () => {
    const dates = weekdays(5);
    const sessions = sessionsOf(dates, (index) => 0.01 * index, () => -0.005, (index) => (index === 2 ? null : 0.2 + index / 100));
    const moves = movesOnDates(sessions, dates);
    expect(moves.overnight[0]).toBeNaN();
    expect(moves.overnight[3]).toBeCloseTo(0.03, 12);
    expect(moves.day[3]).toBeCloseTo(-0.005, 12);
    // Day 3's IV known at 10:00 is day 2's, missing: day 1's.
    expect(moves.iv[3]).toBeCloseTo(0.21, 12);
    expect(moves.iv[4]).toBeCloseTo(0.23, 12);
  });
});

describe("a ticker's history on SPY's dates", () => {
  const dates = weekdays(400);
  const spyDay = (index: number) => 0.01 * Math.sin(index * 1.3);
  const spy = marketDayHistoryOf(sessionsOf(dates, () => 0, spyDay, () => 0.2), []);

  it("measures β on its own days and models the days before its listing as β × SPY's moves", () => {
    // Listed from day 200: its day move is 1.5 × SPY's plus 0.001, its overnight move 0.
    const ownSessions = sessionsOf(dates.slice(199), () => 0, (index) => 1.5 * spyDay(index + 199) + 0.001, () => 0.4);
    const history = tickerDayHistoryOf("LATE", ownSessions, spy, 0.04 / 252, 0.02 / 252, 0);
    expect(history.beta).toBeCloseTo(1.5, 6);
    // Its sessions from dates[199]: its own moves from dates[200], the 200th of SPY's 399 days with moves, to the last.
    expect(history.ownDays).toBe(spy.dates.length - 199);
    const before = 50;
    expect(history.own[before]).toBe(0);
    expect(history.day[before]).toBeCloseTo(1.5 * spy.day[before]!, 12);
    expect(history.iv[before]).toBeCloseTo(0.2 * (0.4 / 0.2), 12);
    const after = 300;
    expect(history.leftoverDay[after]).toBeCloseTo(0.001, 9);
  });

  it("shifts every day so the average simple day becomes the T-bill now + β × (SPY's average total day − the T-bill's average), less its own dividend yield", () => {
    // SPY pays 0.5% of its close on two ex-dates inside its dates and one before them (left out): 1% over 399 days.
    const spyWithDividends = marketDayHistoryOf(sessionsOf(dates, () => 0, spyDay, () => 0.2), [
      { exDividendDate: "1999-12-17", share: 0.005 },
      { exDividendDate: dates[100]!, share: 0.005 },
      { exDividendDate: dates[300]!, share: 0.005 },
    ]);
    expect(spyWithDividends.meanDividendDay).toBeCloseTo(0.01 / spyWithDividends.dates.length, 15);
    const ownSessions = sessionsOf(dates, () => 0.0005, (index) => 2 * spyDay(index) + 0.002, () => 0.5);
    const riskFreeNowDay = 0.04 / 252;
    const riskFreeMeanDay = 0.015 / 252;
    const history = tickerDayHistoryOf("STOCK", ownSessions, spyWithDividends, riskFreeNowDay, riskFreeMeanDay, 0.03);
    let simpleSum = 0;
    for (let at = 0; at < history.day.length; at++) simpleSum += Math.exp(history.overnight[at]! + history.day[at]! + history.neutralShift) - 1;
    expect(simpleSum / history.day.length).toBeCloseTo(riskFreeNowDay + history.beta * (spyWithDividends.meanSimpleDay + spyWithDividends.meanDividendDay - riskFreeMeanDay) - 0.03 / 252, 12);
  });

  it("draws leftovers only from days every late ticker has", () => {
    const lateA = tickerDayHistoryOf("A", sessionsOf(dates.slice(99), () => 0, spyDay), spy, 0, 0, 0);
    const lateB = tickerDayHistoryOf("B", sessionsOf(dates.slice(249), () => 0, spyDay), spy, 0, 0, 0);
    const shared = sharedLeftoverDays([lateA, lateB]);
    expect(shared[0]).toBe(249);
    expect(shared.length).toBe(spy.dates.length - 249);
  });
});

describe("a stand-in's moves before a ticker's own", () => {
  const dates = weekdays(400);
  const spyDay = (index: number) => 0.01 * Math.sin(index * 1.3);
  const spy = marketDayHistoryOf(sessionsOf(dates, () => 0, spyDay, () => 0.2), []);
  // The stand-in moves 0.02 × cos(1.7 × index) a day from the start, at a 40% IV; the young ticker moves 1.5 × as much from day 300, at 60%.
  const standInDay = (index: number) => 0.02 * Math.cos(index * 1.7);
  const standIn = tickerDayHistoryOf("OLD", sessionsOf(dates, () => 0, standInDay, () => 0.4), spy, 0, 0, 0);
  const young = tickerDayHistoryOf("YOUNG", sessionsOf(dates.slice(299), () => 0, (index) => 1.5 * standInDay(index + 299), () => 0.6), spy, 0, 0, 0, standIn);

  it("fills the days before its listing with the stand-in's moves × their volatility ratio, and its IV × their IV ratio", () => {
    expect(young.standIn?.symbol).toBe("OLD");
    expect(young.standIn?.volatilityRatio).toBeCloseTo(1.5, 9);
    expect(young.standIn?.ivRatio).toBeCloseTo(0.6 / 0.4, 9);
    const before = 100;
    expect(young.own[before]).toBe(2);
    expect(young.day[before]).toBeCloseTo(1.5 * standIn.day[before]!, 12);
    expect(young.iv[before]).toBeCloseTo(0.6, 9);
    expect(young.own[350]).toBe(1);
  });

  it("reads β over its own days and the stand-in's, and draws no leftover on a stand-in day", () => {
    let covariance = 0;
    let variance = 0;
    const moves = Array.from(young.day, (day, at) => day + young.overnight[at]!);
    const market = Array.from(spy.day, (day, at) => day + spy.overnight[at]!);
    const meanMove = moves.reduce((sum, move) => sum + move, 0) / moves.length;
    const meanMarket = market.reduce((sum, move) => sum + move, 0) / market.length;
    for (let at = 0; at < moves.length; at++) {
      covariance += (moves[at]! - meanMove) * (market[at]! - meanMarket);
      variance += (market[at]! - meanMarket) ** 2;
    }
    expect(young.beta).toBeCloseTo(covariance / variance, 9);
    // No day of β × SPY: it is not a late ticker, so the book's leftovers ignore it.
    expect(sharedLeftoverDays([young]).length).toBe(0);
    const path = { days: Int32Array.from([100]), leftoverDraws: Float64Array.from([0.5]) };
    expect(tickerPathPrices(young, path, 50, "as_it_happened", Int32Array.from([350])).close[0]).toBeCloseTo(50 * Math.exp(young.overnight[100]! + young.day[100]!), 9);
  });

  it("keeps ratios of 1 with under 20 shared days", () => {
    const late = tickerDayHistoryOf("LATER", sessionsOf(dates.slice(389), () => 0, (index) => 3 * standInDay(index + 389), () => 0.9), spy, 0, 0, 0, standIn);
    expect(late.standIn).toEqual({ symbol: "OLD", volatilityRatio: 1, ivRatio: 1 });
  });
});

describe("today's volatility at a path's start", () => {
  const dates = weekdays(60);
  const spy = marketDayHistoryOf(sessionsOf(dates, () => 0, () => 0.01, () => 0.2), []);
  const history = tickerDayHistoryOf("STOCK", sessionsOf(dates, () => 0.004, () => 0.01, () => 0.3), spy, 0, 0, 0);
  // Days 50–52: 40 sessions after the start, so they have an elevation.
  const path = { days: Int32Array.from([50, 51, 52]), leftoverDraws: new Float64Array(3) };

  // IV now 60% against the drawn days' 30%, half-life 1 session: s = 1 + (2 − 1) × 0.5^t = 2, 1.5, 1.25.
  it("scales the first days' moves, IV and elevation by s(t) = 1 + (IV now ÷ the day's IV − 1) × 0.5^(t ÷ half-life)", () => {
    const plain = tickerPathPrices(history, path, 50, "as_it_happened", new Int32Array(0));
    const started = tickerPathPrices(history, path, 50, "as_it_happened", new Int32Array(0), { ivNow: 0.6, halfLifeSessions: 1 });
    expect(started.tenOclock[0]).toBeCloseTo(50 * Math.exp(0.004 * 2), 9);
    expect(started.close[0]).toBeCloseTo(started.tenOclock[0]! * Math.exp(0.01 * 2), 9);
    expect(started.close[2]! / started.close[1]!).toBeCloseTo(Math.exp(0.014 * 1.25), 9);
    expect([...started.iv].map((iv, step) => iv / plain.iv[step]!)).toEqual([2, 1.5, 1.25].map((scale) => expect.closeTo(scale, 9)));
    expect(started.elevation[1]! / plain.elevation[1]!).toBeCloseTo(1.5, 9);
  });

  it("does not scale the neutral drift's shift", () => {
    const started = tickerPathPrices(history, path, 50, "neutral", new Int32Array(0), { ivNow: 0.6, halfLifeSessions: 1 });
    expect(started.close[0]! / started.tenOclock[0]!).toBeCloseTo(Math.exp(0.01 * 2 + history.neutralShift), 9);
  });
});

describe("the IV's half-life", () => {
  it("is ln 0.5 ÷ ln(the 20-session slope) × 20: 20 sessions when the deviation halves every 20", () => {
    // ln(IV ÷ 0.3) halves every 20 sessions from 1, restarting every 200 sessions, over 1,200 sessions.
    const dates = weekdays(1200);
    const sessions = sessionsOf(dates, () => 0, () => 0, (index) => 0.3 * Math.exp(index < 250 ? 0 : 0.5 ** ((index % 200) / 20)));
    const halfLife = ivHalfLifeSessionsOf(sessions)!;
    expect(halfLife).toBeGreaterThan(15);
    expect(halfLife).toBeLessThan(30);
  });

  it("is null under 750 sessions of IV, and clamped to 5–120", () => {
    expect(ivHalfLifeSessionsOf(sessionsOf(weekdays(700), () => 0, () => 0))).toBeNull();
    // 20 sessions at 20%, 20 at 30%: each deviation the opposite of the one 20 sessions before, a slope under 0 → 5.
    const flipping = sessionsOf(weekdays(800), () => 0, () => 0, (index) => (index % 40 < 20 ? 0.2 : 0.3));
    expect(ivHalfLifeSessionsOf(flipping)).toBe(5);
    // A level shift that never returns: a slope of about 1 → 120.
    const shifted = sessionsOf(weekdays(800), () => 0, () => 0, (index) => 0.2 * 1.001 ** index);
    expect(ivHalfLifeSessionsOf(shifted)).toBe(120);
  });
});

describe("leftovers and the IV of filled days", () => {
  const dates = weekdays(1200);
  const spyDay = (index: number) => 0.01 * Math.sin(index * 1.3);
  const spy = marketDayHistoryOf(sessionsOf(dates, () => 0, spyDay, () => 0.2), []);
  const noise = (index: number) => 0.02 * Math.sin(index * 2.7 + 1);

  it("shares the days the late tickers with 500 own days all have; a younger one draws from its own", () => {
    const fromDay300 = tickerDayHistoryOf("A", sessionsOf(dates.slice(299), () => 0, (index) => spyDay(index + 299) + noise(index)), spy, 0, 0, 0);
    const fromDay600 = tickerDayHistoryOf("B", sessionsOf(dates.slice(599), () => 0, (index) => spyDay(index + 599) + noise(index)), spy, 0, 0, 0);
    const fromDay1000 = tickerDayHistoryOf("C", sessionsOf(dates.slice(999), () => 0, (index) => spyDay(index + 999) + noise(index)), spy, 0, 0, 0);
    const listed = tickerDayHistoryOf("D", sessionsOf(dates, () => 0, spyDay), spy, 0, 0, 0);
    const [a, b, c, d] = leftoverDaysByTicker([fromDay300, fromDay600, fromDay1000, listed]);
    // A and B (over 500 own days each) share B's days; C (about 200) draws from its own; D is never late.
    expect(a).toEqual(b);
    // (The market's dates start a day after its first session: B's first own move is dates[600], index 599.)
    expect(a![0]).toBe(599);
    expect(c![0]).toBe(999);
    expect(c!.length).toBe(fromDay1000.ownDays);
    expect(d!.length).toBe(0);
  });

  it("scales a filled day's IV so its moves stand against it as the ticker's own days' do", () => {
    // Own days from day 300 at a 40% IV; before them β × SPY at SPY's IV × the IV ratio, plus leftovers.
    const late = tickerDayHistoryOf("LATE", sessionsOf(dates.slice(299), () => 0, (index) => spyDay(index + 299) + noise(index), () => 0.4), spy, 0, 0, 0);
    const leftoverDays = leftoverDaysByTicker([late])[0]!;
    const matched = withFilledDaysIvMatched(late, leftoverDays);
    const ratioOf = (history: typeof late, flag: number, withLeftover: boolean) => {
      const moves: number[] = [];
      let ivSum = 0;
      const leftoverVariance = (() => {
        const values = Array.from(leftoverDays, (at) => history.leftoverOvernight[at]! + history.leftoverDay[at]!);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      })();
      for (let at = 0; at < history.own.length; at++) {
        if (history.own[at] !== flag || !Number.isFinite(history.overnight[at]! + history.day[at]!)) continue;
        moves.push(history.overnight[at]! + history.day[at]!);
        ivSum += history.iv[at]!;
      }
      const mean = moves.reduce((sum, move) => sum + move, 0) / moves.length;
      const variance = moves.reduce((sum, move) => sum + (move - mean) ** 2, 0) / moves.length + (withLeftover ? leftoverVariance : 0);
      return Math.sqrt(variance * 252) / (ivSum / moves.length);
    };
    expect(ratioOf(matched, 0, true)).toBeCloseTo(ratioOf(matched, 1, false), 9);
    // Its own days' IV is untouched.
    expect(matched.iv[500]).toBe(late.iv[500]);
  });
});

describe("the paths", () => {
  it("are blocks of consecutive history days with a leftover draw a day, the same for a seed", () => {
    // Blocks of 20 here (the paths' are 250).
    const paths = drawDayPaths(500, 45, 3, 7, 20);
    expect(drawDayPaths(500, 45, 3, 7, 20)).toEqual(paths);
    for (const path of paths) {
      for (const blockStart of [0, 20, 40]) for (let offset = 1; offset < 20 && blockStart + offset < 45; offset++) expect(path.days[blockStart + offset]).toBe(path.days[blockStart]! + offset);
      expect([...path.leftoverDraws].every((draw) => draw >= 0 && draw < 1)).toBe(true);
    }
  });

  it("give each path the same days whatever the path count, a shorter horizon's path being the start of a longer one's", () => {
    const long = drawDayPaths(500, 45, 3, 7);
    const short = drawDayPaths(500, 25, 5, 7);
    for (let pathIndex = 0; pathIndex < 3; pathIndex++) {
      expect([...short[pathIndex]!.days]).toEqual([...long[pathIndex]!.days.subarray(0, 25)]);
      expect([...short[pathIndex]!.leftoverDraws]).toEqual([...long[pathIndex]!.leftoverDraws.subarray(0, 25)]);
    }
  });

  it("move today's price by each history day's moves, a day before the listing taking the leftover its draw picks from the list", () => {
    const dates = weekdays(60);
    const spy = marketDayHistoryOf(sessionsOf(dates, () => 0.01, () => 0.02), []);
    const history = tickerDayHistoryOf("LATE", sessionsOf(dates.slice(29), () => 0.003, () => 0.004), spy, 0, 0, 0);
    // A draw of 0.5 picks the middle of three listed days: day 45.
    const path = { days: Int32Array.from([5, 40]), leftoverDraws: Float64Array.from([0.5, 0.5]) };
    const prices = tickerPathPrices(history, path, 50, "as_it_happened", Int32Array.from([44, 45, 46]));
    // Day 5 (before the listing): β × SPY's moves + day 45's leftover; day 40: its own moves.
    expect(tickerPathPrices(history, path, 50, "as_it_happened", new Int32Array(0)).tenOclock[0]).toBeCloseTo(50 * Math.exp(history.overnight[5]!), 9);
    const overnightFive = history.overnight[5]! + history.leftoverOvernight[45]!;
    expect(prices.tenOclock[0]).toBeCloseTo(50 * Math.exp(overnightFive), 9);
    expect(prices.close[0]).toBeCloseTo(prices.tenOclock[0]! * Math.exp(history.day[5]! + history.leftoverDay[45]!), 9);
    expect(prices.tenOclock[1]).toBeCloseTo(prices.close[0]! * Math.exp(0.003), 9);
    expect(prices.close[1]).toBeCloseTo(prices.tenOclock[1]! * Math.exp(0.004), 9);
  });
});
