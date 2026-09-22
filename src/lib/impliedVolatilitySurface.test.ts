import { describe, expect, it } from "vitest";
import {
  blackScholesPriceOnForward,
  buildSviFitPoints,
  checkCalendarArbitrage,
  computeForwardPrice,
  fitRawSvi,
  fitSviSlice,
  impliedVolatilityFromPrice,
  minimumButterflyDensity,
  sviButterflyDensity,
  sviTotalVariance,
  yearsBetweenIsoDates,
  type RawSviParameters,
  type SurfaceQuote,
  type SviFitPoint,
} from "./impliedVolatilitySurface.js";

// Reference values below were computed independently in Python (math.erf, exact
// Black-Scholes; SVI derivatives by central finite differences, not by the
// closed forms used in the code under test).

const goodParameters: RawSviParameters = { a: 0.04, b: 0.1, rho: -0.4, m: 0.02, sigma: 0.15 };
const arbitrageParameters: RawSviParameters = { a: 0, b: 1.5, rho: 0.9, m: 0, sigma: 0.05 };

describe("computeForwardPrice", () => {
  it("carries spot at the risk-free rate with no dividends", () => {
    expect(computeForwardPrice(100, 0.04, 0.5)).toBeCloseTo(100 * Math.exp(0.02), 10);
  });
  it("subtracts the present value of a dividend that goes ex before expiry", () => {
    expect(computeForwardPrice(100, 0.04, 0.5, [{ amount: 1, yearsToExDividend: 0.25 }])).toBeCloseTo(101.01008383559142, 9);
  });
  it("ignores dividends at or after expiry and any already past", () => {
    const plain = computeForwardPrice(100, 0.04, 0.5);
    expect(computeForwardPrice(100, 0.04, 0.5, [{ amount: 1, yearsToExDividend: 0.5 }])).toBeCloseTo(plain, 12);
    expect(computeForwardPrice(100, 0.04, 0.5, [{ amount: 1, yearsToExDividend: 0.9 }])).toBeCloseTo(plain, 12);
    expect(computeForwardPrice(100, 0.04, 0.5, [{ amount: 1, yearsToExDividend: -0.1 }])).toBeCloseTo(plain, 12);
  });
});

describe("yearsBetweenIsoDates", () => {
  it("is calendar days over 365", () => {
    expect(yearsBetweenIsoDates("2026-09-21", "2026-10-01")).toBeCloseTo(10 / 365, 12);
    expect(yearsBetweenIsoDates("2026-10-30", "2026-11-06")).toBeCloseTo(7 / 365, 12);
  });
});

describe("Black-Scholes on the forward and implied volatility", () => {
  it("matches independent reference prices", () => {
    expect(blackScholesPriceOnForward(100, 105, 0.25, 0.04, 0.3, true)).toBeCloseTo(3.9093607796809637, 5);
    expect(blackScholesPriceOnForward(100, 95, 0.25, 0.04, 0.3, false)).toBeCloseTo(3.6293888076061704, 5);
  });
  it("round-trips volatility for calls and puts", () => {
    for (const isCall of [true, false]) {
      const price = blackScholesPriceOnForward(100, isCall ? 105 : 95, 0.25, 0.04, 0.3, isCall);
      expect(impliedVolatilityFromPrice(price, 100, isCall ? 105 : 95, 0.25, 0.04, isCall)).toBeCloseTo(0.3, 5);
    }
  });
  it("returns null for a price below intrinsic value, or above what 500% volatility gives, or a non-positive price or time", () => {
    expect(impliedVolatilityFromPrice(5, 100, 90, 0.25, 0.04, true)).toBeNull(); // discounted intrinsic is ~9.9
    expect(impliedVolatilityFromPrice(99, 100, 105, 0.25, 0.04, true)).toBeNull();
    expect(impliedVolatilityFromPrice(0, 100, 105, 0.25, 0.04, true)).toBeNull();
    expect(impliedVolatilityFromPrice(3, 100, 105, 0, 0.04, true)).toBeNull();
  });
});

describe("raw SVI and the butterfly density", () => {
  it("total variance matches the independent reference", () => {
    expect(sviTotalVariance(goodParameters, -0.3)).toBeCloseTo(0.08814119409414459, 12);
    expect(sviTotalVariance(goodParameters, 0)).toBeCloseTo(0.05593274595042155, 12);
    expect(sviTotalVariance(goodParameters, 0.2)).toBeCloseTo(0.05623074902771996, 12);
  });
  it("butterfly density g(k) matches the finite-difference reference and is positive for a healthy slice", () => {
    expect(sviButterflyDensity(goodParameters, -0.3)).toBeCloseTo(0.5811108424664695, 5);
    expect(sviButterflyDensity(goodParameters, -0.1)).toBeCloseTo(0.9633689722058298, 5);
    expect(sviButterflyDensity(goodParameters, 0)).toBeCloseTo(1.3118030462250947, 5);
    expect(sviButterflyDensity(goodParameters, 0.2)).toBeCloseTo(0.9546642335548969, 5);
    expect(minimumButterflyDensity(goodParameters, -0.4, 0.4)).toBeGreaterThan(0);
  });
  it("detects a butterfly-arbitrage slice (g < 0 on the right wing)", () => {
    expect(sviButterflyDensity(arbitrageParameters, 0.05)).toBeCloseTo(-3.0042, 3);
    expect(minimumButterflyDensity(arbitrageParameters, -0.5, 0.2)).toBeLessThan(0);
  });
});

// Synthetic quotes generated from a known SVI slice, via exact Black-Scholes prices.
const yearsToExpiry = 30 / 365;
const rate = 0.04;
const forward = 100;
function syntheticQuotes(parameters: RawSviParameters, spreadFraction = 0.04, strikes: number[] = Array.from({ length: 41 }, (_, index) => 80 + index)): SurfaceQuote[] {
  return strikes.map((strike) => {
    const k = Math.log(strike / forward);
    const isCall = strike >= forward;
    const volatility = Math.sqrt(sviTotalVariance(parameters, k) / yearsToExpiry);
    const mid = blackScholesPriceOnForward(forward, strike, yearsToExpiry, rate, volatility, isCall);
    return { strike, right: isCall ? "C" : "P", bid: mid * (1 - spreadFraction / 2), ask: mid * (1 + spreadFraction / 2) };
  });
}

describe("buildSviFitPoints", () => {
  it("keeps OTM quotes only: a put above the forward and a call below it are dropped", () => {
    const { points, dropped } = buildSviFitPoints(
      [
        { strike: 95, right: "P", bid: 1, ask: 1.1 },
        { strike: 95, right: "C", bid: 6, ask: 6.2 },
        { strike: 105, right: "C", bid: 1, ask: 1.1 },
        { strike: 105, right: "P", bid: 6, ask: 6.2 },
      ],
      forward,
      yearsToExpiry,
      rate,
    );
    expect(points).toHaveLength(2);
    expect(dropped.inTheMoney).toBe(2);
    expect(points.map((point) => Math.sign(point.logMoneyness))).toEqual([-1, 1]);
  });
  it("treats a strike exactly at the forward as a call (the call's quote is the one used)", () => {
    const { points } = buildSviFitPoints([{ strike: 100, right: "C", bid: 1.2, ask: 1.3 }, { strike: 100, right: "P", bid: 3.0, ask: 3.1 }], forward, yearsToExpiry, rate);
    expect(points).toHaveLength(1);
    const callVolatility = impliedVolatilityFromPrice(1.25, forward, 100, yearsToExpiry, rate, true)!;
    expect(points[0]!.totalVariance).toBeCloseTo(callVolatility * callVolatility * yearsToExpiry, 12);
  });
  it("drops quotes with no bid, a null side, or a crossed/locked market", () => {
    const { points, dropped } = buildSviFitPoints(
      [
        { strike: 90, right: "P", bid: 0, ask: 0.1 },
        { strike: 91, right: "P", bid: null, ask: 0.2 },
        { strike: 92, right: "P", bid: 0.3, ask: null },
        { strike: 93, right: "P", bid: 0.4, ask: 0.4 },
        { strike: 94, right: "P", bid: 0.5, ask: 0.4 },
      ],
      forward,
      yearsToExpiry,
      rate,
    );
    expect(points).toHaveLength(0);
    expect(dropped.noTwoSidedQuote).toBe(5);
  });
  it("drops a spread wider than 50% of the mid and keeps exactly 50%", () => {
    const wide = buildSviFitPoints([{ strike: 95, right: "P", bid: 0.5, ask: 0.9 }], forward, yearsToExpiry, rate); // 0.4/0.7 = 57%
    expect(wide.points).toHaveLength(0);
    expect(wide.dropped.spreadTooWide).toBe(1);
    const edge = buildSviFitPoints([{ strike: 95, right: "P", bid: 0.6, ask: 1.0 }], forward, yearsToExpiry, rate); // 0.4/0.8 = 50%
    expect(edge.points).toHaveLength(1);
  });
  it("counts quotes whose mid has no solvable implied volatility", () => {
    const { points, dropped } = buildSviFitPoints([{ strike: 95, right: "P", bid: 80, ask: 100 }], forward, yearsToExpiry, rate); // mid 90 is above any put price
    expect(points).toHaveLength(0);
    expect(dropped.noImpliedVolatility).toBe(1);
  });
  it("weights by 1/spread² with the 2% floor", () => {
    const { points } = buildSviFitPoints(
      [
        { strike: 95, right: "P", bid: 0.8, ask: 1.0 }, // spread 0.2/0.9
        { strike: 96, right: "P", bid: 1.0, ask: 1.001 }, // spread ~0.1%, below the floor
      ],
      forward,
      yearsToExpiry,
      rate,
    );
    expect(points[0]!.weight).toBeCloseTo(1 / (0.2 / 0.9) ** 2, 8);
    expect(points[1]!.weight).toBeCloseTo(1 / 0.02 ** 2, 8);
  });
  it("computes total variance IV²·T and log-moneyness ln(K/F)", () => {
    const { points } = buildSviFitPoints([{ strike: 105, right: "C", bid: 3.85, ask: 3.97 }], forward, yearsToExpiry, rate);
    const mid = 3.91;
    const iv = impliedVolatilityFromPrice(mid, forward, 105, yearsToExpiry, rate, true)!;
    expect(points[0]!.logMoneyness).toBeCloseTo(Math.log(1.05), 12);
    expect(points[0]!.totalVariance).toBeCloseTo(iv * iv * yearsToExpiry, 12);
  });
});

describe("fitRawSvi / fitSviSlice on a known slice", () => {
  const truth: RawSviParameters = { a: 0.003, b: 0.05, rho: -0.4, m: 0.01, sigma: 0.12 };

  it("reproduces the smile of noise-free synthetic quotes to well under a volatility point", () => {
    const { points } = buildSviFitPoints(syntheticQuotes(truth, 0.02), forward, yearsToExpiry, rate);
    const fitted = fitRawSvi(points)!;
    for (const k of [-0.15, -0.08, 0, 0.06, 0.15]) {
      const fittedVolatility = Math.sqrt(sviTotalVariance(fitted, k) / yearsToExpiry);
      const trueVolatility = Math.sqrt(sviTotalVariance(truth, k) / yearsToExpiry);
      expect(Math.abs(fittedVolatility - trueVolatility)).toBeLessThan(0.005);
    }
  });

  it("returns an 'ok' slice with the fitted parameters inside the approved bounds", () => {
    const { points } = buildSviFitPoints(syntheticQuotes(truth, 0.02), forward, yearsToExpiry, rate);
    const slice = fitSviSlice(points, yearsToExpiry);
    expect(slice.status).toBe("ok");
    expect(slice.rmseVolatility!).toBeLessThan(0.002); // tight only if the refinement pass works
    expect(slice.minimumButterflyDensity!).toBeGreaterThan(0);
    const parameters = slice.parameters!;
    expect(parameters.b).toBeGreaterThanOrEqual(0);
    expect(Math.abs(parameters.rho)).toBeLessThanOrEqual(0.98 + 1e-12);
    expect(parameters.sigma).toBeGreaterThanOrEqual(0.02 - 1e-12);
    expect(parameters.a + parameters.b * parameters.sigma * Math.sqrt(1 - parameters.rho ** 2)).toBeGreaterThanOrEqual(-1e-12);
  });

  it("clamps |rho| at 0.98 when the data want a perfectly one-sided smile", () => {
    const steep: RawSviParameters = { a: 0.002, b: 0.06, rho: 0.999, m: 0, sigma: 0.05 };
    const { points } = buildSviFitPoints(syntheticQuotes(steep, 0.02), forward, yearsToExpiry, rate);
    const fitted = fitRawSvi(points)!;
    expect(Math.abs(fitted.rho)).toBeLessThanOrEqual(0.98 + 1e-12);
  });

  it("flags a slice whose smile itself has butterfly arbitrage instead of using it", () => {
    const points: SviFitPoint[] = Array.from({ length: 30 }, (_, index) => {
      const k = -0.4 + index * 0.02;
      return { logMoneyness: k, totalVariance: sviTotalVariance(arbitrageParameters, k), weight: 100 };
    });
    const slice = fitSviSlice(points, yearsToExpiry);
    expect(slice.status).toBe("butterfly_arbitrage");
    expect(slice.minimumButterflyDensity!).toBeLessThan(0);
  });

  it("always returns a feasible slice, whatever the data look like (b ≥ 0, |rho| ≤ 0.98, sigma ≥ 0.02, positive minimum variance)", () => {
    const shapes: ((k: number) => number)[] = [
      (k) => 0.05 - 0.1 * k * k, // concave: the unconstrained fit wants b < 0
      (k) => 0.02 + 0.6 * Math.abs(k), // sharp V
      (k) => 0.04 + 0.5 * Math.max(k, 0), // one-sided
      (k) => 0.03 + 0.3 * k * k + 0.4 * k, // steep skew
      (k) => 0.01 + 4 * Math.abs(k) ** 1.5, // very steep wings
    ];
    for (const shape of shapes) {
      const points: SviFitPoint[] = Array.from({ length: 25 }, (_, index) => {
        const k = -0.25 + index * 0.02;
        return { logMoneyness: k, totalVariance: Math.max(shape(k), 0.001), weight: 1 };
      });
      const parameters = fitRawSvi(points)!;
      expect(parameters.b).toBeGreaterThanOrEqual(0);
      expect(Math.abs(parameters.rho)).toBeLessThanOrEqual(0.98 + 1e-12);
      expect(parameters.sigma).toBeGreaterThanOrEqual(0.02 - 1e-12);
      expect(parameters.a + parameters.b * parameters.sigma * Math.sqrt(1 - parameters.rho ** 2)).toBeGreaterThanOrEqual(-1e-12);
      expect(Number.isFinite(parameters.rho)).toBe(true);
    }
  });

  it("the refinement pass tightens the fit: a small-sigma smile off the coarse grid is matched to within 0.05 volatility points", () => {
    const smallSigma: RawSviParameters = { a: -0.0008770497934892763, b: 0.34396712722256784, rho: 0.36511983554810284, m: 0.04660998466424644, sigma: 0.06790527406148612 };
    const points: SviFitPoint[] = Array.from({ length: 25 }, (_, index) => {
      const k = -0.25 + index * 0.02;
      return { logMoneyness: k, totalVariance: sviTotalVariance(smallSigma, k), weight: 1 };
    });
    const fitted = fitRawSvi(points)!;
    const rmse = Math.sqrt(points.reduce((sum, point) => sum + (Math.sqrt(sviTotalVariance(fitted, point.logMoneyness) / yearsToExpiry) - Math.sqrt(point.totalVariance / yearsToExpiry)) ** 2, 0) / points.length);
    expect(rmse).toBeLessThan(0.0005); // the coarse grid alone gives ~0.0019
  });

  it("keeps the positivity constraint a + b·sigma·sqrt(1-rho²) ≥ 0 on a smile that touches zero variance (the unconstrained fit would violate it)", () => {
    // Variances floored at 0.0005 around k = 0.05..0.11, as a deep-in-the-wings smile with a near-zero minimum.
    const rows: [number, number, number][] = [[-0.25, 0.08577, 19], [-0.23, 0.0765, 4.4], [-0.21, 0.07399, 49.6], [-0.19, 0.06634, 23.6], [-0.17, 0.06038, 31.3], [-0.15, 0.05501, 40], [-0.13, 0.04809, 24.7], [-0.11, 0.04308, 19.1], [-0.09, 0.03637, 5.6], [-0.07, 0.03089, 42.7], [-0.05, 0.02449, 9.9], [-0.03, 0.01934, 7.1], [-0.01, 0.01319, 23.8], [0.01, 0.00758, 6.7], [0.03, 0.0026, 39.6], [0.05, 0.00049, 31.3], [0.07, 0.00051, 14.3], [0.09, 0.0005, 18.6], [0.11, 0.0005, 26.6], [0.13, 0.0075, 16.5], [0.15, 0.01528, 44.7], [0.17, 0.02432, 20], [0.19, 0.03386, 25.2], [0.21, 0.04139, 13.7], [0.23, 0.05225, 30.4]];
    const points: SviFitPoint[] = rows.map(([logMoneyness, totalVariance, weight]) => ({ logMoneyness, totalVariance, weight }));
    const parameters = fitRawSvi(points)!;
    expect(parameters.a + parameters.b * parameters.sigma * Math.sqrt(1 - parameters.rho ** 2)).toBeGreaterThanOrEqual(-1e-12);
    for (let step = 0; step <= 200; step++) expect(sviTotalVariance(parameters, -0.5 + step * 0.005)).toBeGreaterThanOrEqual(-1e-12);
  });

  it("has no surface (insufficient_points) with fewer than 8 usable points", () => {
    const { points } = buildSviFitPoints(syntheticQuotes(truth, 0.02, [90, 95, 98, 102, 105, 110, 112]), forward, yearsToExpiry, rate);
    expect(points).toHaveLength(7);
    expect(fitSviSlice(points, yearsToExpiry)).toMatchObject({ status: "insufficient_points", parameters: null });
    const eight = buildSviFitPoints(syntheticQuotes(truth, 0.02, [88, 90, 95, 98, 102, 105, 110, 112]), forward, yearsToExpiry, rate).points;
    expect(fitSviSlice(eight, yearsToExpiry).status).not.toBe("insufficient_points");
  });

  it("flags a poor fit when the smile is noisy beyond 3 volatility points", () => {
    const noisy: SviFitPoint[] = Array.from({ length: 24 }, (_, index) => {
      const k = -0.2 + index * 0.0175;
      const volatility = 0.5 + (index % 2 === 0 ? 0.1 : -0.1); // ±10 vol points zig-zag
      return { logMoneyness: k, totalVariance: volatility * volatility * yearsToExpiry, weight: 100 };
    });
    expect(fitSviSlice(noisy, yearsToExpiry).status).toBe("poor_fit");
  });

  it("reports fit_failed (not a wrong number) when the points cannot be fitted", () => {
    const identical: SviFitPoint[] = Array.from({ length: 10 }, () => ({ logMoneyness: 0.1, totalVariance: 0.01, weight: 1 }));
    expect(["fit_failed", "poor_fit", "ok"]).toContain(fitSviSlice(identical, yearsToExpiry).status);
    expect(fitRawSvi(identical.slice(0, 2))).toBeNull();
  });

  it("recovers under realistic noise: 5% spreads and random ±0.5 vol-point mid noise stay within 2 vol points", () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
    const quotes = syntheticQuotes(truth, 0.05).map((quote) => {
      const factor = 1 + random() * 0.04;
      return { ...quote, bid: quote.bid! * factor, ask: quote.ask! * factor };
    });
    const slice = fitSviSlice(buildSviFitPoints(quotes, forward, yearsToExpiry, rate).points, yearsToExpiry);
    expect(slice.status).toBe("ok");
    expect(slice.rmseVolatility!).toBeLessThan(0.02);
  });
});

describe("checkCalendarArbitrage", () => {
  const slice = (yearsToExpiryValue: number, a: number) => ({ yearsToExpiry: yearsToExpiryValue, parameters: { ...goodParameters, a }, kMin: -0.3, kMax: 0.3 });
  it("passes when total variance grows with maturity", () => {
    expect(checkCalendarArbitrage([slice(0.1, 0.03), slice(0.2, 0.05), slice(0.3, 0.08)])).toEqual({ checks: 42, violations: 0 });
  });
  it("counts every check as a violation when a later slice sits below an earlier one, whatever the input order", () => {
    expect(checkCalendarArbitrage([slice(0.2, 0.02), slice(0.1, 0.06)])).toEqual({ checks: 21, violations: 21 });
  });
  it("skips pairs with no shared log-moneyness range", () => {
    const far = { yearsToExpiry: 0.3, parameters: goodParameters, kMin: 0.5, kMax: 0.8 };
    expect(checkCalendarArbitrage([slice(0.1, 0.03), far])).toEqual({ checks: 0, violations: 0 });
  });
});
