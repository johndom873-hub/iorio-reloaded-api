import { describe, expect, it } from "vitest";
import { blackScholesPriceOnForward, computeForwardPrice, sviTotalVariance, yearsBetweenIsoDates, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { fitSurfaceForSnapshot, type SurfaceSnapshotInput, type SurfaceSnapshotQuote } from "./optionSurfaceFitting.js";

const tradingDate = "2026-09-21";
const spot = 100;
const ratePercent = 4;
const truth: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };

// Quotes for one expiry generated from a known smile via exact Black-Scholes (spread 3%).
function quotesFor(expiry: string, scale = 1, dividends: { amount: number; yearsToExDividend: number }[] = []): SurfaceSnapshotQuote[] {
  const years = yearsBetweenIsoDates(tradingDate, expiry);
  const forward = computeForwardPrice(spot, ratePercent / 100, years, dividends);
  return Array.from({ length: 41 }, (_, index) => {
    const strike = 80 + index;
    const isCall = strike >= forward;
    const volatility = Math.sqrt((sviTotalVariance(truth, Math.log(strike / forward)) * scale) / years);
    const mid = blackScholesPriceOnForward(forward, strike, years, ratePercent / 100, volatility, isCall);
    return { expiry, strike, right: isCall ? "C" : "P", bid: mid * 0.985, ask: mid * 1.015 };
  });
}

function snapshot(overrides: Partial<SurfaceSnapshotInput> = {}): SurfaceSnapshotInput {
  return {
    tradingDate,
    spotPrice: spot,
    riskFreeRatePercent: ratePercent,
    nextExDividendDate: null,
    nextExDividendAmount: null,
    quotes: [...quotesFor("2026-10-21", 1), ...quotesFor("2026-11-20", 2)],
    ...overrides,
  };
}

describe("fitSurfaceForSnapshot", () => {
  it("skips, with the reason, when spot, the risk-free rate or the quotes are missing", () => {
    expect(fitSurfaceForSnapshot(snapshot({ spotPrice: null }))).toEqual({ kind: "skipped", reason: "no_spot_price" });
    expect(fitSurfaceForSnapshot(snapshot({ spotPrice: 0 }))).toEqual({ kind: "skipped", reason: "no_spot_price" });
    expect(fitSurfaceForSnapshot(snapshot({ riskFreeRatePercent: null }))).toEqual({ kind: "skipped", reason: "no_risk_free_rate" });
    expect(fitSurfaceForSnapshot(snapshot({ quotes: [] }))).toEqual({ kind: "skipped", reason: "no_quotes" });
  });

  it("fits each expiry separately, in date order, with the right time to expiry", () => {
    const outcome = fitSurfaceForSnapshot(snapshot({ quotes: [...quotesFor("2026-11-20", 2), ...quotesFor("2026-10-21", 1)] }));
    expect(outcome.kind).toBe("fitted");
    if (outcome.kind !== "fitted") return;
    expect(outcome.expiries.map((expiry) => expiry.expiry)).toEqual(["2026-10-21", "2026-11-20"]);
    expect(outcome.expiries[0]!.yearsToExpiry).toBeCloseTo(30 / 365, 12);
    expect(outcome.expiries.every((expiry) => expiry.slice.status === "ok")).toBe(true);
    expect(outcome.expiries[0]!.forwardPrice).toBeCloseTo(100 * Math.exp(0.04 * (30 / 365)), 8);
  });

  it("recovers each slice's smile (the second expiry has twice the variance)", () => {
    const outcome = fitSurfaceForSnapshot(snapshot());
    if (outcome.kind !== "fitted") throw new Error("expected a fit");
    const [near, far] = outcome.expiries;
    expect(near!.slice.rmseVolatility!).toBeLessThan(0.005);
    const atTheMoneyRatio = sviTotalVariance(far!.slice.parameters!, 0) / sviTotalVariance(near!.slice.parameters!, 0);
    expect(atTheMoneyRatio).toBeGreaterThan(1.8);
    expect(atTheMoneyRatio).toBeLessThan(2.2);
  });

  it("checks calendar arbitrage against the previous fitted expiry: none for the first, none when variance grows, all violated when it shrinks", () => {
    const grows = fitSurfaceForSnapshot(snapshot());
    if (grows.kind !== "fitted") throw new Error("expected a fit");
    expect(grows.expiries[0]).toMatchObject({ calendarChecks: 0, calendarViolations: 0 });
    expect(grows.expiries[1]!.calendarChecks).toBeGreaterThan(0);
    expect(grows.expiries[1]!.calendarViolations).toBe(0);

    const shrinks = fitSurfaceForSnapshot(snapshot({ quotes: [...quotesFor("2026-10-21", 2), ...quotesFor("2026-11-20", 0.5)] }));
    if (shrinks.kind !== "fitted") throw new Error("expected a fit");
    expect(shrinks.expiries[1]!.calendarViolations).toBe(shrinks.expiries[1]!.calendarChecks);
    expect(shrinks.expiries[1]!.calendarViolations).toBeGreaterThan(0);
  });

  it("does not compare against an expiry that produced no fit", () => {
    const sparse = [{ expiry: "2026-10-14", strike: 100, right: "C" as const, bid: 2, ask: 2.1 }];
    const outcome = fitSurfaceForSnapshot(snapshot({ quotes: [...sparse, ...quotesFor("2026-10-21", 1), ...quotesFor("2026-11-20", 2)] }));
    if (outcome.kind !== "fitted") throw new Error("expected a fit");
    expect(outcome.expiries.map((expiry) => [expiry.expiry, expiry.slice.status])).toEqual([["2026-10-14", "insufficient_points"], ["2026-10-21", "ok"], ["2026-11-20", "ok"]]);
    expect(outcome.expiries[1]!.calendarChecks).toBe(0); // first expiry that produced a fit
    expect(outcome.expiries[2]!.calendarChecks).toBeGreaterThan(0);
  });

  it("drops an expiry that is today (no time value) instead of storing a meaningless row", () => {
    const outcome = fitSurfaceForSnapshot(snapshot({ quotes: [...quotesFor("2026-09-21", 1), ...quotesFor("2026-10-21", 1)] }));
    if (outcome.kind !== "fitted") throw new Error("expected a fit");
    expect(outcome.expiries.map((expiry) => expiry.expiry)).toEqual(["2026-10-21"]);
  });

  it("uses the next ex-dividend date and amount in the forward, and ignores one after expiry", () => {
    const dividend = { amount: 2, yearsToExDividend: yearsBetweenIsoDates(tradingDate, "2026-10-01") };
    const withDividend = fitSurfaceForSnapshot(snapshot({ nextExDividendDate: "2026-10-01", nextExDividendAmount: 2, quotes: quotesFor("2026-10-21", 1, [dividend]) }));
    const plain = fitSurfaceForSnapshot(snapshot({ quotes: quotesFor("2026-10-21", 1) }));
    const afterExpiry = fitSurfaceForSnapshot(snapshot({ nextExDividendDate: "2026-12-01", nextExDividendAmount: 2, quotes: quotesFor("2026-10-21", 1) }));
    if (withDividend.kind !== "fitted" || plain.kind !== "fitted" || afterExpiry.kind !== "fitted") throw new Error("expected fits");
    expect(withDividend.expiries[0]!.forwardPrice).toBeCloseTo(computeForwardPrice(spot, 0.04, 30 / 365, [dividend]), 8);
    expect(withDividend.expiries[0]!.forwardPrice).toBeLessThan(plain.expiries[0]!.forwardPrice - 1.9);
    expect(afterExpiry.expiries[0]!.forwardPrice).toBeCloseTo(plain.expiries[0]!.forwardPrice, 10);
    expect(withDividend.expiries[0]!.slice.rmseVolatility!).toBeLessThan(0.005); // dividend-consistent quotes fit cleanly
  });

  it("keeps the per-slice drop counts so a thin expiry can be explained", () => {
    const extra = [
      { expiry: "2026-10-21", strike: 95, right: "P" as const, bid: 0.5, ask: 1.5 }, // 100% spread
      { expiry: "2026-10-21", strike: 95, right: "C" as const, bid: 6, ask: 6.2 }, // in the money
    ];
    const outcome = fitSurfaceForSnapshot(snapshot({ quotes: [...extra, ...quotesFor("2026-10-21", 1)] }));
    if (outcome.kind !== "fitted") throw new Error("expected a fit");
    expect(outcome.expiries[0]!.dropped.spreadTooWide).toBeGreaterThanOrEqual(1);
    expect(outcome.expiries[0]!.dropped.inTheMoney).toBeGreaterThanOrEqual(1);
  });
});
