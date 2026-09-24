import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { blackScholesVega } from "./optionFriction.js";
import { attachUncompensatedShare, buildSignalCandidates, gradeSignalCandidates, liveUncompensatedSharePathCount, pickBestCandidate, wideSpreadThreshold, type SignalCandidatesInput, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { computeUncompensatedShare } from "./uncompensatedShare.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const slice30 = (overrides: Partial<SignalSurfaceSlice> = {}): SignalSurfaceSlice => ({
  expiry: "2026-10-21",
  status: "ok",
  parameters: params,
  kMin: -0.4,
  kMax: 0.4,
  yearsToExpiry: 30 / 365,
  forwardPrice: forward,
  pointCount: 20,
  rmseVolatility: 0.01,
  minButterflyDensity: 0.8,
  droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 },
  calendarChecks: 0,
  calendarViolations: 0,
  ...overrides,
});

function ivAt(k: number, years: number): number {
  return Math.sqrt(sviTotalVariance(params, k) / years);
}
function quoteAt(strike: number, right: "C" | "P", spreadFraction = 0.04, expiry = "2026-10-21", years = 30 / 365): SignalQuote {
  const k = Math.log(strike / forward);
  const iv = ivAt(k, years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * (1 - spreadFraction / 2), ask: mid * (1 + spreadFraction / 2) };
}

function baseInput(overrides: Partial<SignalCandidatesInput> = {}): SignalCandidatesInput {
  return {
    spotPrice: forward,
    riskFreeRate: rate,
    forecast: { volatility: 0.2, windowDays: 63 },
    slices: [slice30()],
    quotes: [quoteAt(90, "P"), quoteAt(110, "C")],
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEventDatesIso: [],
    snapshotDateIso: "2026-09-21",
    freeShares: 0,
    freeCash: 1_000_000,
    maxNetDelta: 1,
    minAnnualizedYieldPct: 0,
    ...overrides,
  };
}

describe("buildSignalCandidates: structural filters", () => {
  it("keeps only the OTM side: a call below the forward and a put above it are dropped", () => {
    const candidates = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "C"), quoteAt(110, "P"), quoteAt(90, "P"), quoteAt(110, "C")] }));
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.strategyKey).sort()).toEqual(["cash_secured_put", "covered_call"]);
  });

  it("drops a quote with no two-sided bid/ask", () => {
    const noBid = { ...quoteAt(90, "P"), bid: 0 };
    const noAsk = { ...quoteAt(90, "P"), ask: null };
    expect(buildSignalCandidates(baseInput({ quotes: [noBid, noAsk] }))).toHaveLength(0);
  });

  it("skips an expiry with no fitted slice, or a slice that is not ok", () => {
    expect(buildSignalCandidates(baseInput({ quotes: [{ ...quoteAt(90, "P"), expiry: "2026-11-01" }] }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ slices: [slice30({ status: "poor_fit" })] }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ slices: [slice30({ parameters: null })] }))).toHaveLength(0);
  });

  it("is unscored (excluded) with no volatility forecast", () => {
    expect(buildSignalCandidates(baseInput({ forecast: null }))).toHaveLength(0);
  });

  it("applies no delta, DTE, spread or open-interest cut -- a very wide spread and a deep OTM strike still produce a candidate", () => {
    const wide = quoteAt(70, "P", 1.4); // spread >> 50% of mid
    const candidates = buildSignalCandidates(baseInput({ quotes: [wide] }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.flags).toContain("wide_spread");
  });
});

describe("buildSignalCandidates: computed fields", () => {
  it("delta matches the independent Black-Scholes reference at the surface IV", () => {
    const candidates = buildSignalCandidates(baseInput({ quotes: [quoteAt(105, "C")] }));
    const iv = ivAt(Math.log(105 / forward), 30 / 365);
    expect(candidates[0]!.delta).toBeCloseTo(blackScholesDelta(forward, 105, 30 / 365, rate, iv, true), 10);
  });

  it("edge is surface IV minus the forecast, and net Edge is edge minus friction", () => {
    const candidates = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }));
    const c = candidates[0]!;
    expect(c.edge).toBeCloseTo(c.surfaceImpliedVolatility - 0.2, 10);
    expect(c.netEdge).toBeLessThan(c.edge); // friction is always subtracted
    expect(c.netEdge).toBeCloseTo(c.edge - c.frictionVolatility, 6);
  });

  it("edge dollars scales with net Edge and is not simply proportional to the option's own price", () => {
    const candidates = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }));
    const c = candidates[0]!;
    expect(Math.sign(c.edgeDollars)).toBe(Math.sign(c.netEdge));
    expect(c.edgeDollars).not.toBe(0);
  });

  it("spread percent is (ask - bid) / mid, as a percentage", () => {
    const candidates = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P", 0.1)] }));
    expect(candidates[0]!.spreadPercent).toBeCloseTo(10, 3);
  });

  it("annualized yield matches the existing app formula: premium / capitalAtRisk * 365/dte, spot for calls, strike for puts", () => {
    const call = buildSignalCandidates(baseInput({ quotes: [quoteAt(110, "C")], spotPrice: 100 }))[0]!;
    const put = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spotPrice: 100 }))[0]!;
    const premiumCall = (call.bid + call.ask) / 2;
    const premiumPut = (put.bid + put.ask) / 2;
    expect(call.annualizedYield).toBeCloseTo((premiumCall / 100) * (365 / call.dte), 6);
    expect(put.annualizedYield).toBeCloseTo((premiumPut / 90) * (365 / put.dte), 6);
  });

  it("net Edge at the mid concedes only the commission, and Edge $ at the mid follows from it", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    const commissionOnly = 0.68 / 100 / c.vega; // commissionPerContractDollars / sharesPerContract / vega
    expect(c.netEdgeAtMid).toBeCloseTo(c.edge - commissionOnly, 12);
    expect(c.netEdgeAtMid).toBeGreaterThan(c.netEdge); // no half-spread conceded
    expect(c.edgeDollarsAtMid).toBeCloseTo(c.netEdgeAtMid * c.vega * 100, 10);
    expect(c.vega).toBeCloseTo(blackScholesVega(forward, 90, 30 / 365, rate, c.surfaceImpliedVolatility), 12);
  });

  it("dollar risk is max theoretical loss (strike or spot x 100, minus mid premium), and the risk-adjusted ratios follow from it", () => {
    const call = buildSignalCandidates(baseInput({ quotes: [quoteAt(110, "C")], spotPrice: 100 }))[0]!;
    const put = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spotPrice: 100 }))[0]!;
    const premiumCall = (call.bid + call.ask) / 2;
    const premiumPut = (put.bid + put.ask) / 2;
    expect(call.dollarRisk).toBeCloseTo(100 * 100 - premiumCall, 10);
    expect(put.dollarRisk).toBeCloseTo(90 * 100 - premiumPut, 10);
    expect(put.riskAdjustedRatio).toBeCloseTo(put.edgeDollars / put.dollarRisk, 10);
    expect(put.riskAdjustedRatioAtMid).toBeCloseTo(put.edgeDollarsAtMid / put.dollarRisk, 10);
  });

  it("does not run the Monte Carlo: uncompensated share is null until attached", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(105, "C")] }))[0]!;
    expect(c.uncompensatedSharePercent).toBeNull();
  });
});

describe("attachUncompensatedShare", () => {
  const input = baseInput({ quotes: [quoteAt(105, "C"), quoteAt(95, "P")] });
  const candidates = buildSignalCandidates(input);

  it("fills in a percent between 0 and 100 and leaves every other field untouched", () => {
    const attached = attachUncompensatedShare(candidates, { spotPrice: input.spotPrice, slices: input.slices });
    expect(attached).toHaveLength(candidates.length);
    for (const [index, c] of attached.entries()) {
      expect(c.uncompensatedSharePercent).not.toBeNull();
      expect(c.uncompensatedSharePercent!).toBeGreaterThan(0);
      expect(c.uncompensatedSharePercent!).toBeLessThanOrEqual(100);
      expect({ ...c, uncompensatedSharePercent: null }).toEqual(candidates[index]);
    }
    expect(candidates.every((c) => c.uncompensatedSharePercent === null)).toBe(true); // input not mutated
  });

  it("matches computeUncompensatedShare called directly with the candidate's own surface IV", () => {
    const c = candidates[0]!;
    const direct = computeUncompensatedShare({ spotPrice: input.spotPrice, strike: c.strike, yearsToExpiry: 30 / 365, volatility: c.surfaceImpliedVolatility })!;
    const attached = attachUncompensatedShare([c], { spotPrice: input.spotPrice, slices: input.slices })[0]!;
    expect(attached.uncompensatedSharePercent).toBe(direct.timingShare * 100);
  });

  it("uses the live path count when asked, giving a close but not identical number to the default", () => {
    const c = candidates[0]!;
    const full = attachUncompensatedShare([c], { spotPrice: input.spotPrice, slices: input.slices })[0]!.uncompensatedSharePercent!;
    const live = attachUncompensatedShare([c], { spotPrice: input.spotPrice, slices: input.slices }, { pathCount: liveUncompensatedSharePathCount })[0]!.uncompensatedSharePercent!;
    expect(live).not.toBe(full);
    expect(Math.abs(live - full)).toBeLessThan(5); // within a few points: same seed, fewer paths
  });

  it("leaves the share null when the candidate's expiry has no slice", () => {
    const attached = attachUncompensatedShare(candidates, { spotPrice: input.spotPrice, slices: [] });
    expect(attached.every((c) => c.uncompensatedSharePercent === null)).toBe(true);
  });
});

describe("buildSignalCandidates: flags and executability", () => {
  it("excludes the candidate entirely when a resolved calendar's earnings date falls strictly after the snapshot and on/before the expiry", () => {
    const spans = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], earningsDatesIso: ["2026-10-05"] }));
    const notSpans = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], earningsDatesIso: ["2026-11-05"] }));
    expect(spans).toHaveLength(0);
    expect(notSpans).toHaveLength(1);
  });

  it("flags earnings_calendar_unresolved (does not exclude) when the ticker's calendar never resolved", () => {
    // Same earnings date that would exclude a resolved ticker -- unresolved means "unchecked", not "clear".
    const unresolved = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], earningsDatesIso: ["2026-10-05"], earningsCalendarResolved: false }))[0]!;
    expect(unresolved.flags).toContain("earnings_calendar_unresolved");
    const resolved = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], earningsDatesIso: [] }))[0]!;
    expect(resolved.flags).not.toContain("earnings_calendar_unresolved");
  });

  it("flags macro_event_before_expiry (does not exclude) when a major macro release falls before the expiry", () => {
    const spans = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], macroEventDatesIso: ["2026-10-14"] }))[0]!;
    expect(spans.flags).toContain("macro_event_before_expiry");
    const onExpiry = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], macroEventDatesIso: ["2026-10-21"] }))[0]!;
    expect(onExpiry.flags).toContain("macro_event_before_expiry"); // release on expiry day still lands inside the trade
    const after = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], macroEventDatesIso: ["2026-10-22", "2026-09-21"] }))[0]!;
    expect(after.flags).not.toContain("macro_event_before_expiry"); // after expiry, or on the snapshot date itself, is not spanned
  });

  it("flags outside_fitted_range when the strike's log-moneyness is beyond the slice's kMin/kMax", () => {
    const outside = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], slices: [slice30({ kMin: -0.05 })] }))[0]!;
    expect(outside.flags).toContain("outside_fitted_range");
  });

  it("flags wide_spread exactly at the threshold boundary", () => {
    // construct a quote whose spread/mid is exactly wideSpreadThreshold
    const iv = ivAt(Math.log(90 / forward), 30 / 365);
    const mid = blackScholesPriceOnForward(forward, 90, 30 / 365, rate, iv, false);
    const exact: SignalQuote = { expiry: "2026-10-21", strike: 90, right: "P", bid: mid * (1 - wideSpreadThreshold / 2), ask: mid * (1 + wideSpreadThreshold / 2) };
    const c = buildSignalCandidates(baseInput({ quotes: [exact] }))[0]!;
    expect(c.flags).not.toContain("wide_spread"); // == threshold is allowed, matches the surface fitter's own <= cutoff
    const slightlyWider: SignalQuote = { ...exact, bid: (exact.bid ?? 0) * 0.999 };
    expect(buildSignalCandidates(baseInput({ quotes: [slightlyWider] }))[0]!.flags).toContain("wide_spread");
  });

  it("a covered call without free shares is not flagged and stays executable (both legs ship in one order)", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(110, "C")], freeShares: 0 }))[0]!;
    expect(c.flags).toEqual([]);
    expect(c.executable).toBe(true);
  });

  it("flags insufficient_cash for a put beyond free cash, and marks it not executable", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], freeCash: 1000 }))[0]!;
    expect(c.flags).toContain("insufficient_cash");
    expect(c.executable).toBe(false);
    const funded = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], freeCash: 9_000 }))[0]!;
    expect(funded.flags).not.toContain("insufficient_cash");
    expect(funded.executable).toBe(true);
  });

  it("a put can be flagged AND executable is false, while its net Edge/grade are still computed (shown, not hidden)", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], freeCash: 1000 }))[0]!;
    expect(Number.isFinite(c.netEdge)).toBe(true);
    expect(c.executable).toBe(false);
  });
});

describe("buildSignalCandidates: Signals tab filters", () => {
  it("drops a candidate whose |delta| exceeds maxNetDelta", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], maxNetDelta: Math.abs(unrestricted.delta) - 0.001 }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], maxNetDelta: Math.abs(unrestricted.delta) }))).toHaveLength(1);
  });

  it("drops a candidate whose annualised yield is below minAnnualizedYieldPct", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    const yieldPct = unrestricted.annualizedYield * 100;
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], minAnnualizedYieldPct: yieldPct + 1 }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], minAnnualizedYieldPct: yieldPct }))).toHaveLength(1);
  });
});

describe("buildSignalCandidates: boundary conditions", () => {
  it("a strike exactly at the forward counts as a call (>=), not a put", () => {
    const atForward: SignalQuote = { ...quoteAt(100, "C"), strike: 100 };
    const candidates = buildSignalCandidates(baseInput({ quotes: [atForward, { ...quoteAt(100, "P"), strike: 100 }] }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strategyKey).toBe("covered_call");
  });

  it("rejects a locked market (ask == bid), not just a crossed one", () => {
    const locked: SignalQuote = { ...quoteAt(90, "P"), bid: 1, ask: 1 };
    expect(buildSignalCandidates(baseInput({ quotes: [locked] }))).toHaveLength(0);
  });

  it("excludes an expiry with zero time to expiry (expiring today)", () => {
    const todayExpiry = slice30({ yearsToExpiry: 0 });
    expect(buildSignalCandidates(baseInput({ slices: [todayExpiry], quotes: [quoteAt(90, "P")] }))).toHaveLength(0);
  });

  it("a strike exactly at the fitted kMin/kMax boundary is inside the range, not outside", () => {
    const k = Math.log(90 / forward);
    const tight = slice30({ kMin: k, kMax: 0.4 });
    const c = buildSignalCandidates(baseInput({ slices: [tight], quotes: [quoteAt(90, "P")] }))[0]!;
    expect(c.flags).not.toContain("outside_fitted_range");
  });

  it("edge dollars equals net Edge x an independently computed vega x 100", () => {
    const c = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    const vega = blackScholesVega(forward, 90, 30 / 365, rate, c.surfaceImpliedVolatility);
    expect(c.edgeDollars).toBeCloseTo(c.netEdge * vega * 100, 6);
  });
});

describe("gradeSignalCandidates", () => {
  // Fixed net Edge cut points (approved 2026-09-24): <=0 avoid, 0-5vp weak, 5-10vp good, 10vp+ strong.
  // netEdgeVolatilityPoints is netEdge * 100, so fakeCandidates takes vp directly for readability.
  function fakeCandidates(netEdgesVolatilityPoints: number[]) {
    return netEdgesVolatilityPoints.map((vp, index) => {
      const netEdge = vp / 100;
      return { netEdge, strategyKey: "cash_secured_put" as const, expiry: "2026-10-21", strike: 90 - index, dte: 30, delta: -0.2, bid: 1, ask: 1.1, spreadPercent: 5, surfaceImpliedVolatility: 0.2, midImpliedVolatility: 0.2, forecastVolatility: 0.15, edge: netEdge, frictionVolatility: 0, edgeDollars: netEdge * 10, vega: 0.1, netEdgeAtMid: netEdge, edgeDollarsAtMid: netEdge * 10, dollarRisk: 8999, riskAdjustedRatio: (netEdge * 10) / 8999, riskAdjustedRatioAtMid: (netEdge * 10) / 8999, annualizedYield: 0.2, uncompensatedSharePercent: 30, quoteSource: "snapshot" as const, quotedAt: null, flags: [], executable: true, grade: "avoid" as const };
    });
  }

  it("cuts at 10vp+ strong, 5-10vp good, 0-5vp weak, <=0 avoid", () => {
    const graded = gradeSignalCandidates(fakeCandidates([-1, 0, 2, 4.99, 5, 8, 9.99, 10, 15]));
    const byNetEdgeVp = new Map(graded.map((c) => [Math.round(c.netEdge * 10000) / 100, c.grade]));
    expect(byNetEdgeVp.get(15)).toBe("strong");
    expect(byNetEdgeVp.get(10)).toBe("strong");
    expect(byNetEdgeVp.get(9.99)).toBe("good");
    expect(byNetEdgeVp.get(8)).toBe("good");
    expect(byNetEdgeVp.get(5)).toBe("good");
    expect(byNetEdgeVp.get(4.99)).toBe("weak");
    expect(byNetEdgeVp.get(2)).toBe("weak");
    expect(byNetEdgeVp.get(0)).toBe("avoid");
    expect(byNetEdgeVp.get(-1)).toBe("avoid");
  });

  it("handles a single candidate and an empty list without throwing", () => {
    expect(gradeSignalCandidates(fakeCandidates([15]))[0]!.grade).toBe("strong");
    expect(gradeSignalCandidates([])).toEqual([]);
  });

  it("does not mutate the input array's objects", () => {
    const input = fakeCandidates([5]);
    gradeSignalCandidates(input);
    expect(input[0]!.grade).toBe("avoid");
  });
});

describe("pickBestCandidate", () => {
  it("picks the highest Edge $, ties broken by net Edge, and is null for an empty list", () => {
    const c = (edgeDollars: number, netEdge: number) => ({ edgeDollars, netEdge } as ReturnType<typeof gradeSignalCandidates>[number]);
    expect(pickBestCandidate([c(10, 0.01), c(50, 0.02), c(30, 0.05)])!.edgeDollars).toBe(50);
    expect(pickBestCandidate([c(10, 0.01), c(10, 0.05)])!.netEdge).toBe(0.05);
    expect(pickBestCandidate([])).toBeNull();
  });
});
