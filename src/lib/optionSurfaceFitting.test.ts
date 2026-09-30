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
    pastExDividendDate: null,
    pastExDividendAmount: null,
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

  it("projects a second dividend forward when the gap to the past ex-dividend implies a regular cadence, but not when the gap looks irregular", () => {
    const div1 = { amount: 2, yearsToExDividend: yearsBetweenIsoDates(tradingDate, "2026-10-01") };
    const div2 = { amount: 2, yearsToExDividend: yearsBetweenIsoDates(tradingDate, "2026-10-31") };
    const regular = fitSurfaceForSnapshot(
      snapshot({
        pastExDividendDate: "2026-09-01", // 30 days before the next ex-div: a monthly cadence
        pastExDividendAmount: 2,
        nextExDividendDate: "2026-10-01",
        nextExDividendAmount: 2,
        quotes: quotesFor("2026-11-20", 1, [div1, div2]),
      }),
    );
    if (regular.kind !== "fitted") throw new Error("expected a fit");
    expect(regular.expiries[0]!.forwardPrice).toBeCloseTo(computeForwardPrice(spot, 0.04, yearsBetweenIsoDates(tradingDate, "2026-11-20"), [div1, div2]), 8);

    const irregular = fitSurfaceForSnapshot(
      snapshot({
        pastExDividendDate: "2025-06-01", // ~488 days before the next ex-div: not a regular cadence
        pastExDividendAmount: 2,
        nextExDividendDate: "2026-10-01",
        nextExDividendAmount: 2,
        quotes: quotesFor("2026-11-20", 1, [div1]),
      }),
    );
    if (irregular.kind !== "fitted") throw new Error("expected a fit");
    expect(irregular.expiries[0]!.forwardPrice).toBeCloseTo(computeForwardPrice(spot, 0.04, yearsBetweenIsoDates(tradingDate, "2026-11-20"), [div1]), 8);
  });

  describe("the underlying price the quotes were taken at", () => {
    const shortExpiry = "2026-09-24";
    const staleSnapshotSpot = 98; // the snapshot's spot, read before the quotes arrived; the quotes were struck with the underlying at 100
    const withUnderlying = (underlyingPrice: number | null | undefined, quotes = quotesFor(shortExpiry)) => quotes.map((quote) => ({ ...quote, underlyingPrice }));
    const fitShortExpiry = (quotes: SurfaceSnapshotQuote[]) => {
      const outcome = fitSurfaceForSnapshot(snapshot({ spotPrice: staleSnapshotSpot, quotes }));
      if (outcome.kind !== "fitted") throw new Error("expected a fit");
      return outcome.expiries[0]!;
    };

    it("builds the forward from the quoted underlying instead of the snapshot spot, so a stale snapshot spot no longer rejects a short expiry", () => {
      const againstSnapshotSpot = fitShortExpiry(withUnderlying(undefined));
      expect(againstSnapshotSpot.slice.status).toBe("poor_fit");

      const againstQuotedUnderlying = fitShortExpiry(withUnderlying(spot));
      expect(againstQuotedUnderlying.slice.status).toBe("ok");
      expect(againstQuotedUnderlying.forwardPrice).toBeCloseTo(computeForwardPrice(spot, ratePercent / 100, yearsBetweenIsoDates(tradingDate, shortExpiry)), 10);
    });

    it("uses the median of the quotes' underlying prices, ignoring missing and non-positive ones", () => {
      const quotes = quotesFor(shortExpiry).map((quote, index) => ({ ...quote, underlyingPrice: index % 5 === 0 ? null : index % 7 === 0 ? 0 : spot + (index % 2 === 0 ? -0.5 : 0.5) }));
      const expiry = fitShortExpiry(quotes);
      expect(expiry.forwardPrice).toBeGreaterThan(computeForwardPrice(spot - 0.5, ratePercent / 100, expiry.yearsToExpiry));
      expect(expiry.forwardPrice).toBeLessThan(computeForwardPrice(spot + 0.5, ratePercent / 100, expiry.yearsToExpiry));
    });

    it("falls back to the snapshot spot for an expiry whose quotes carry no underlying price, per expiry", () => {
      const outcome = fitSurfaceForSnapshot(snapshot({ quotes: [...withUnderlying(101, quotesFor("2026-10-21")), ...withUnderlying(null, quotesFor("2026-11-20", 2))] }));
      if (outcome.kind !== "fitted") throw new Error("expected a fit");
      const [near, far] = outcome.expiries;
      expect(near!.forwardPrice).toBeCloseTo(computeForwardPrice(101, ratePercent / 100, near!.yearsToExpiry), 10);
      expect(far!.forwardPrice).toBeCloseTo(computeForwardPrice(spot, ratePercent / 100, far!.yearsToExpiry), 10);
    });
  });

  describe("the put-call parity forward", () => {
    const shortExpiry = "2026-09-24";
    const yearsToShortExpiry = yearsBetweenIsoDates(tradingDate, shortExpiry);
    const impliedForward = computeForwardPrice(spot, ratePercent / 100, yearsToShortExpiry) * 1.012; // the option market's forward sits 1.2% above the spot-based one
    // Both sides at strikes near the money, all priced off impliedForward from the known smile.
    const pairedQuotes = (): SurfaceSnapshotQuote[] =>
      Array.from({ length: 41 }, (_, index) => 80 + index).flatMap((strike) =>
        (["C", "P"] as const).map((right) => {
          const volatility = Math.sqrt(sviTotalVariance(truth, Math.log(strike / impliedForward)) / yearsToShortExpiry);
          const mid = blackScholesPriceOnForward(impliedForward, strike, yearsToShortExpiry, ratePercent / 100, volatility, right === "C");
          return { expiry: shortExpiry, strike, right, bid: mid * 0.985, ask: mid * 1.015 };
        }),
      );
    const fit = (quotes: SurfaceSnapshotQuote[]) => {
      const outcome = fitSurfaceForSnapshot(snapshot({ quotes }));
      if (outcome.kind !== "fitted") throw new Error("expected a fit");
      return outcome.expiries[0]!;
    };

    it("takes the forward the calls and puts imply, which the spot-based forward cannot reproduce", () => {
      const single = pairedQuotes().filter((quote) => (quote.right === "C") === (quote.strike >= impliedForward));
      expect(fit(single).slice.status).toBe("poor_fit"); // no pairs: spot-based forward, 1.2% off the quotes

      const paired = fit(pairedQuotes());
      expect(paired.slice.status).toBe("ok");
      expect(paired.forwardPrice).toBeCloseTo(impliedForward, 4);
    });

    it("anchors the forward to the quoted underlying (else the snapshot spot), not to the parity forward", () => {
      expect(fit(pairedQuotes()).underlyingPrice).toBe(spot);
      expect(fit(pairedQuotes().map((quote) => ({ ...quote, underlyingPrice: 101 }))).underlyingPrice).toBe(101);
    });
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
