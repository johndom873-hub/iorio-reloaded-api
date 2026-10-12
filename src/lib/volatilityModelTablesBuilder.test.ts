import { describe, expect, it } from "vitest";
import { bootstrapBucketIntervals, collectWindows, equalCountBucketMeans, impliedVolatilityIsPlausible, inferMarketSessions, monotoneFit, type TickerHistoryInput } from "./volatilityModelTablesBuilder.js";

function weekdaysFrom(startIso: string, count: number): string[] {
  const dates: string[] = [];
  for (let at = Date.parse(`${startIso}T12:00:00Z`); dates.length < count; at += 86_400_000) {
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** A ticker whose close moves ±1% alternately; open = previous close, high/low around them. */
function ticker(symbol: string, dates: string[], overrides: Partial<TickerHistoryInput> = {}, volume = 1e6): TickerHistoryInput {
  let close = 100;
  const bars = dates.map((tradingDate, index) => {
    const open = close;
    close = close * (index % 2 === 0 ? 1.01 : 0.99);
    return { tradingDate, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume, impliedVolatility: 0.16 };
  });
  return { symbol, group: "stock", bars, earningsDatesIso: [], ...overrides };
}

describe("equalCountBucketMeans", () => {
  it("splits sorted values into equal-count buckets and keeps each bucket's mean", () => {
    expect(equalCountBucketMeans([4, 1, 3, 2], 2)).toEqual([1.5, 3.5]);
    expect(equalCountBucketMeans([1, 2, 3, 4, 5, 6], 3)).toEqual([1.5, 3.5, 5.5]);
  });
  it("refuses too few values", () => {
    expect(() => equalCountBucketMeans([1], 2)).toThrow();
  });
});

describe("inferMarketSessions", () => {
  it("keeps the dates on which at least half the tickers trading then have a usable bar", () => {
    const dates = weekdaysFrom("2026-01-05", 5);
    const a = ticker("A", dates);
    const b = ticker("B", dates.filter((dateIso) => dateIso !== dates[2]));
    const c = ticker("C", dates.filter((dateIso) => dateIso !== dates[2] && dateIso !== dates[3]));
    expect(inferMarketSessions([a, b, c])).toEqual([dates[0], dates[1], dates[3], dates[4]]);
  });
  it("ignores zero-volume bars (a halt stored as flat bars)", () => {
    const dates = weekdaysFrom("2026-01-05", 3);
    expect(inferMarketSessions([ticker("A", dates, {}, 0)])).toEqual([]);
  });
});

describe("collectWindows", () => {
  const dates = weekdaysFrom("2026-01-05", 40);
  it("starts once 21 sessions of history exist and accumulates log returns per horizon", () => {
    const windows = collectWindows([ticker("A", dates)], 2);
    expect(windows[0]!.dateIso).toBe(dates[21]);
    const first = windows.filter((window) => window.dateIso === dates[21]);
    expect(first.map((window) => window.horizon)).toEqual([1, 2]);
    expect(first[1]!.logReturn).toBeCloseTo(Math.log(0.99) + Math.log(1.01), 12);
    expect(first[0]!.forecastVariance).toBeGreaterThan(0);
  });
  it("leaves out every window that reaches an earnings reaction session", () => {
    const withEarnings = collectWindows([ticker("A", dates, { earningsDatesIso: [dates[23]!] })], 3);
    // the reaction sessions are dates[23] and dates[24]: from t = dates[21] only h = 1 survives
    expect(withEarnings.filter((window) => window.dateIso === dates[21]).map((window) => window.horizon)).toEqual([1]);
    expect(withEarnings.some((window) => window.dateIso === dates[22])).toBe(false);
  });
  it("breaks a ticker's history at a missing market session", () => {
    const gapped = ticker("A", dates.filter((dateIso) => dateIso !== dates[30]));
    const windows = collectWindows([gapped, ticker("B", dates)], 1).filter((window) => window.symbol === "A");
    expect(windows.some((window) => window.dateIso === dates[29])).toBe(false); // its next bar is two sessions later
    expect(windows.some((window) => window.dateIso === dates[31])).toBe(false); // a new run needs 21 sessions again
  });
});

describe("impliedVolatilityIsPlausible", () => {
  const dates = weekdaysFrom("2026-01-05", 80);
  it("accepts an implied volatility near the realized one and rejects one far from it", () => {
    // ±1% a day ≈ 16% a year
    expect(impliedVolatilityIsPlausible(ticker("A", dates))).toBe(true);
    const junk = ticker("B", dates);
    junk.bars.forEach((bar) => (bar.impliedVolatility = 1.2));
    expect(impliedVolatilityIsPlausible(junk)).toBe(false);
  });
});

describe("monotoneFit (calibration rows, approved 2026-10-10)", () => {
  it("leaves an ordered row unchanged", () => {
    expect(monotoneFit([-0.07, -0.03, 0.01, 0.2], [1, 1, 1, 1])).toEqual([-0.07, -0.03, 0.01, 0.2]);
  });
  it("pools a dip with the buckets before it into their weighted mean (the 10-session row: +1.8, +2.5, −5.4, +5.3)", () => {
    const fitted = monotoneFit([0.018, 0.025, -0.054, 0.053], [4522, 5412, 4532, 2698]);
    const pooled = (0.018 * 4522 + 0.025 * 5412 - 0.054 * 4532) / (4522 + 5412 + 4532);
    expect(fitted.slice(0, 3).every((value) => Math.abs(value - pooled) < 1e-12)).toBe(true);
    expect(fitted[3]).toBe(0.053);
    for (let index = 1; index < fitted.length; index++) expect(fitted[index]!).toBeGreaterThanOrEqual(fitted[index - 1]!);
  });
  it("a heavier bucket pulls the pooled value towards itself", () => {
    expect(monotoneFit([0.1, 0], [9, 1])).toEqual([0.09, 0.09]);
  });
});

describe("bootstrapBucketIntervals", () => {
  const month = (premium: number, weighted: number) => [{ premium, weighted }];
  it("is reproducible and brackets the full-sample value", () => {
    const sums = new Map([["2024-01", month(1, 0.1)], ["2024-02", month(1, 0.3)], ["2024-03", month(2, 0.2)], ["2024-04", month(1, -0.1)]]);
    const first = bootstrapBucketIntervals(sums, 1, 500, 7);
    expect(bootstrapBucketIntervals(sums, 1, 500, 7)).toEqual(first);
    const full = (0.1 + 0.3 + 0.2 - 0.1) / 5;
    expect(first[0]!.low).toBeLessThanOrEqual(full);
    expect(first[0]!.high).toBeGreaterThanOrEqual(full);
    expect(first[0]!.high).toBeGreaterThan(first[0]!.low);
  });
  it("has no width when every month says the same", () => {
    const sums = new Map([["2024-01", month(1, 0.2)], ["2024-02", month(3, 0.6)]]);
    const [interval] = bootstrapBucketIntervals(sums, 1, 200, 1);
    expect(interval!.low).toBeCloseTo(0.2, 12);
    expect(interval!.high).toBeCloseTo(0.2, 12);
  });
});
