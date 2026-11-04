import { describe, expect, it } from "vitest";
import { drawDayPaths, marketDayHistoryOf, movesOnDates, sharedLeftoverDays, tickerDayHistoryOf, tickerPathPrices, type HistorySession } from "./portfolioDayHistory.js";

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
  const spy = marketDayHistoryOf(sessionsOf(dates, () => 0, spyDay, () => 0.2));

  it("measures β on its own days and models the days before its listing as β × SPY's moves", () => {
    // Listed from day 200: its day move is 1.5 × SPY's plus 0.001, its overnight move 0.
    const ownSessions = sessionsOf(dates.slice(199), () => 0, (index) => 1.5 * spyDay(index + 199) + 0.001, () => 0.4);
    const history = tickerDayHistoryOf("LATE", ownSessions, spy, 0.04 / 252, 0.02 / 252);
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

  it("shifts every day so the average simple day becomes the T-bill now + β × (SPY's average − the T-bill's average)", () => {
    const ownSessions = sessionsOf(dates, () => 0.0005, (index) => 2 * spyDay(index) + 0.002, () => 0.5);
    const riskFreeNowDay = 0.04 / 252;
    const riskFreeMeanDay = 0.015 / 252;
    const history = tickerDayHistoryOf("STOCK", ownSessions, spy, riskFreeNowDay, riskFreeMeanDay);
    let simpleSum = 0;
    for (let at = 0; at < history.day.length; at++) simpleSum += Math.exp(history.overnight[at]! + history.day[at]! + history.neutralShift) - 1;
    expect(simpleSum / history.day.length).toBeCloseTo(riskFreeNowDay + history.beta * (spy.meanSimpleDay - riskFreeMeanDay), 12);
  });

  it("draws leftovers only from days every late ticker has", () => {
    const lateA = tickerDayHistoryOf("A", sessionsOf(dates.slice(99), () => 0, spyDay), spy, 0, 0);
    const lateB = tickerDayHistoryOf("B", sessionsOf(dates.slice(249), () => 0, spyDay), spy, 0, 0);
    const shared = sharedLeftoverDays([lateA, lateB]);
    expect(shared[0]).toBe(249);
    expect(shared.length).toBe(spy.dates.length - 249);
  });
});

describe("the paths", () => {
  it("are blocks of 20 consecutive history days with a leftover draw a day, the same for a seed", () => {
    const paths = drawDayPaths(500, 45, 3, 7);
    expect(drawDayPaths(500, 45, 3, 7)).toEqual(paths);
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
    const spy = marketDayHistoryOf(sessionsOf(dates, () => 0.01, () => 0.02));
    const history = tickerDayHistoryOf("LATE", sessionsOf(dates.slice(29), () => 0.003, () => 0.004), spy, 0, 0);
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
