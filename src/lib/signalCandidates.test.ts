import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { blackScholesVega } from "./optionFriction.js";
import { attachUncompensatedShare, buildSignalCandidates, emptyCandidateExclusionTally, gradeSignalCandidates, liveUncompensatedSharePathCount, pickBestCandidate, wideSpreadThreshold, type SignalCandidatesInput, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
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
    deltaTargetMin: 0,
    deltaTargetMax: 1,
    minAnnualizedYieldPct: 0,
    spreadShareCharged: 1,
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

  it("friction charges the spread share of the half-spread: 0 concedes only the commission, 0.5 sits halfway to a fill at the bid", () => {
    const atBid = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spreadShareCharged: 1 }))[0]!;
    const halfway = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spreadShareCharged: 0.5 }))[0]!;
    const atMid = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spreadShareCharged: 0 }))[0]!;
    const commissionOnly = 0.68 / 100 / atMid.vega; // commissionPerContractDollars / sharesPerContract / vega
    const halfSpreadVolatility = (atMid.ask - atMid.bid) / 2 / atMid.vega;
    expect(atMid.netEdge).toBeCloseTo(atMid.edge - commissionOnly, 12);
    expect(atBid.netEdge).toBeCloseTo(atBid.edge - halfSpreadVolatility - commissionOnly, 12);
    expect(halfway.netEdge).toBeCloseTo(halfway.edge - 0.5 * halfSpreadVolatility - commissionOnly, 12);
    expect(halfway.edgeDollars).toBeCloseTo(halfway.netEdge * halfway.vega * 100, 10);
    expect(atMid.vega).toBeCloseTo(blackScholesVega(forward, 90, 30 / 365, rate, atMid.surfaceImpliedVolatility), 12);
  });

  it("dollar risk is max theoretical loss (strike or spot x 100, minus mid premium), and the risk-adjusted ratio follows from it", () => {
    const call = buildSignalCandidates(baseInput({ quotes: [quoteAt(110, "C")], spotPrice: 100 }))[0]!;
    const put = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], spotPrice: 100 }))[0]!;
    const premiumCall = (call.bid + call.ask) / 2;
    const premiumPut = (put.bid + put.ask) / 2;
    expect(call.dollarRisk).toBeCloseTo(100 * 100 - premiumCall, 10);
    expect(put.dollarRisk).toBeCloseTo(90 * 100 - premiumPut, 10);
    expect(put.riskAdjustedRatio).toBeCloseTo(put.edgeDollars / put.dollarRisk, 10);
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
  it("drops a candidate whose |delta| exceeds deltaTargetMax", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], deltaTargetMax: Math.abs(unrestricted.delta) - 0.001 }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], deltaTargetMax: Math.abs(unrestricted.delta) }))).toHaveLength(1);
  });

  it("drops a candidate whose |delta| is below deltaTargetMin, and counts it", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    const delta = Math.abs(unrestricted.delta);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], deltaTargetMin: delta + 0.001 }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], deltaTargetMin: delta }))).toHaveLength(1);
    const tally = emptyCandidateExclusionTally();
    buildSignalCandidates(baseInput({ exclusionTally: tally, quotes: [quoteAt(90, "P")], deltaTargetMin: delta + 0.001 }));
    expect(tally.belowMinDeltaCount).toBe(1);
    expect(tally.aboveMaxDeltaCount).toBe(0);
  });

  it("drops a candidate whose annualised yield is below minAnnualizedYieldPct", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")] }))[0]!;
    const yieldPct = unrestricted.annualizedYield * 100;
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], minAnnualizedYieldPct: yieldPct + 1 }))).toHaveLength(0);
    expect(buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P")], minAnnualizedYieldPct: yieldPct }))).toHaveLength(1);
  });
});

describe("buildSignalCandidates: the delta band edge cases", () => {
  const wideQuotes = [quoteAt(70, "P"), quoteAt(75, "P"), quoteAt(80, "P"), quoteAt(85, "P"), quoteAt(90, "P"), quoteAt(95, "P"), quoteAt(105, "C"), quoteAt(110, "C"), quoteAt(120, "C")];
  const unrestricted = buildSignalCandidates(baseInput({ quotes: wideQuotes }));
  const sortedMagnitudes = unrestricted.map((candidate) => Math.abs(candidate.delta)).sort((a, b) => a - b);

  it("the fixture has nine distinct deltas, put and call, so the band cases below are not degenerate", () => {
    expect(unrestricted).toHaveLength(9);
    expect(new Set(sortedMagnitudes).size).toBe(9);
    expect(unrestricted.some((candidate) => candidate.strategyKey === "covered_call")).toBe(true);
    expect(unrestricted.some((candidate) => candidate.strategyKey === "cash_secured_put")).toBe(true);
  });

  for (const [label, quote] of [["put", quoteAt(90, "P")], ["call", quoteAt(110, "C")]] as const) {
    it(`a ${label} exactly at either bound is kept, and a hair outside is dropped on the matching side`, () => {
      const delta = Math.abs(buildSignalCandidates(baseInput({ quotes: [quote] }))[0]!.delta);
      expect(buildSignalCandidates(baseInput({ quotes: [quote], deltaTargetMin: delta, deltaTargetMax: 1 }))).toHaveLength(1);
      expect(buildSignalCandidates(baseInput({ quotes: [quote], deltaTargetMin: 0, deltaTargetMax: delta }))).toHaveLength(1);
      expect(buildSignalCandidates(baseInput({ quotes: [quote], deltaTargetMin: delta + 1e-9, deltaTargetMax: 1 }))).toHaveLength(0);
      expect(buildSignalCandidates(baseInput({ quotes: [quote], deltaTargetMin: 0, deltaTargetMax: delta - 1e-9 }))).toHaveLength(0);
    });
  }

  it("a band whose min equals its max keeps exactly the contract with that delta and drops the rest, counted on both sides", () => {
    const target = unrestricted[4]!;
    const delta = Math.abs(target.delta);
    const tally = emptyCandidateExclusionTally();
    const kept = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: delta, deltaTargetMax: delta, exclusionTally: tally }));
    expect(kept.map((candidate) => `${candidate.strike}${candidate.strategyKey}`)).toEqual([`${target.strike}${target.strategyKey}`]);
    const below = sortedMagnitudes.filter((magnitude) => magnitude < delta).length;
    const above = sortedMagnitudes.filter((magnitude) => magnitude > delta).length;
    expect(tally.belowMinDeltaCount).toBe(below);
    expect(tally.aboveMaxDeltaCount).toBe(above);
    expect(below + above + 1).toBe(9);
  });

  it("a minimum of 0 is no lower bound: even the lowest-delta contract is kept, and nothing counts as below the minimum", () => {
    const tally = emptyCandidateExclusionTally();
    const kept = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: 0, deltaTargetMax: 1, exclusionTally: tally }));
    expect(kept).toHaveLength(9);
    expect(tally.belowMinDeltaCount).toBe(0);
    expect(tally.aboveMaxDeltaCount).toBe(0);
  });

  it("a maximum of 1 is no upper bound: even the highest-delta contract is kept", () => {
    const kept = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: 0, deltaTargetMax: 1 }));
    expect(Math.max(...kept.map((candidate) => Math.abs(candidate.delta)))).toBe(sortedMagnitudes[8]);
  });

  it("counts drops in both directions and the three groups add up to every quote offered", () => {
    const minimum = (sortedMagnitudes[1]! + sortedMagnitudes[2]!) / 2; // drops the 2 lowest
    const maximum = (sortedMagnitudes[6]! + sortedMagnitudes[7]!) / 2; // drops the 2 highest
    const tally = emptyCandidateExclusionTally();
    const excluded: string[] = [];
    const kept = buildSignalCandidates(
      baseInput({ quotes: wideQuotes, deltaTargetMin: minimum, deltaTargetMax: maximum, exclusionTally: tally, onContractExcluded: (_quote, exclusion) => void excluded.push(exclusion.kind) }),
    );
    expect(tally.belowMinDeltaCount).toBe(2);
    expect(tally.aboveMaxDeltaCount).toBe(2);
    expect(kept).toHaveLength(5);
    expect(tally.belowMinDeltaCount + tally.aboveMaxDeltaCount + kept.length).toBe(wideQuotes.length);
    expect(excluded.filter((kind) => kind === "below_min_delta")).toHaveLength(2);
    expect(excluded.filter((kind) => kind === "above_max_delta")).toHaveLength(2);
    for (const candidate of kept) {
      expect(Math.abs(candidate.delta)).toBeGreaterThanOrEqual(minimum);
      expect(Math.abs(candidate.delta)).toBeLessThanOrEqual(maximum);
    }
  });

  it("the exclusion carries the delta that was measured and the bound it broke", () => {
    const minimum = sortedMagnitudes[4]! + 1e-6;
    const maximum = sortedMagnitudes[5]! - 1e-6;
    const exclusions = new Map<string, unknown>();
    buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: minimum, deltaTargetMax: maximum, onContractExcluded: (quote, exclusion) => void exclusions.set(`${quote.strike}${quote.right}`, exclusion) }));
    const lowest = unrestricted.find((candidate) => Math.abs(candidate.delta) === sortedMagnitudes[0])!;
    const highest = unrestricted.find((candidate) => Math.abs(candidate.delta) === sortedMagnitudes[8])!;
    const keyOf = (candidate: { strike: number; strategyKey: string }) => `${candidate.strike}${candidate.strategyKey === "covered_call" ? "C" : "P"}`;
    expect(exclusions.get(keyOf(lowest))).toEqual({ kind: "below_min_delta", delta: lowest.delta, deltaTargetMin: minimum });
    expect(exclusions.get(keyOf(highest))).toEqual({ kind: "above_max_delta", delta: highest.delta, deltaTargetMax: maximum });
  });

  it("the band is checked before the yield: a contract dropped for its delta is not also counted as below the minimum yield", () => {
    const tally = emptyCandidateExclusionTally();
    const kept = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: 0.99, deltaTargetMax: 1, minAnnualizedYieldPct: 1_000_000, exclusionTally: tally }));
    expect(kept).toHaveLength(0);
    expect(tally.belowMinDeltaCount).toBe(9);
    expect(tally.belowMinYieldCount).toBe(0);
    expect(tally.bestAnnualizedYieldPct).toBeNull(); // nothing reached the yield check
  });

  it("with the band wide open the minimum yield still applies on its own", () => {
    const tally = emptyCandidateExclusionTally();
    const kept = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: 0, deltaTargetMax: 1, minAnnualizedYieldPct: 1_000_000, exclusionTally: tally }));
    expect(kept).toHaveLength(0);
    expect(tally.belowMinDeltaCount).toBe(0);
    expect(tally.belowMinYieldCount).toBe(9);
  });

  it("returns the same candidates whatever the band when every contract is inside it", () => {
    const widest = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: 0, deltaTargetMax: 1 }));
    const exactlyFitted = buildSignalCandidates(baseInput({ quotes: wideQuotes, deltaTargetMin: sortedMagnitudes[0]!, deltaTargetMax: sortedMagnitudes[8]! }));
    expect(exactlyFitted).toEqual(widest);
  });
});

describe("buildSignalCandidates: exclusion tally", () => {
  it("records rejected-fit and earnings-spanning expiries, but not an expiry with no slice at all", () => {
    const tally = emptyCandidateExclusionTally();
    const later = slice30({ expiry: "2026-11-20", yearsToExpiry: 60 / 365 });
    buildSignalCandidates(baseInput({
      exclusionTally: tally,
      slices: [slice30({ status: "poor_fit" }), later],
      quotes: [quoteAt(90, "P"), quoteAt(85, "P", 0.04, "2026-11-20", 60 / 365), quoteAt(90, "P", 0.04, "2026-12-18", 90 / 365)],
      earningsDatesIso: ["2026-11-05"],
    }));
    expect([...tally.surfaceFitRejectedExpiries]).toEqual(["2026-10-21"]);
    expect([...tally.spansEarningsExpiries]).toEqual(["2026-11-20"]);
    expect(tally.bestAnnualizedYieldPct).toBeNull(); // nothing reached the yield check
  });

  it("counts max-delta and min-yield drops and keeps the best yield seen, including ones that passed", () => {
    const unrestricted = buildSignalCandidates(baseInput({ quotes: [quoteAt(90, "P"), quoteAt(95, "P")] }));
    const yields = unrestricted.map((c) => c.annualizedYield * 100);
    const deltas = unrestricted.map((c) => Math.abs(c.delta));

    const deltaTally = emptyCandidateExclusionTally();
    buildSignalCandidates(baseInput({ exclusionTally: deltaTally, quotes: [quoteAt(90, "P"), quoteAt(95, "P")], deltaTargetMax: Math.min(...deltas) }));
    expect(deltaTally.aboveMaxDeltaCount).toBe(1);
    expect(deltaTally.belowMinYieldCount).toBe(0);

    const yieldTally = emptyCandidateExclusionTally();
    const kept = buildSignalCandidates(baseInput({ exclusionTally: yieldTally, quotes: [quoteAt(90, "P"), quoteAt(95, "P")], minAnnualizedYieldPct: Math.max(...yields) }));
    expect(kept).toHaveLength(1);
    expect(yieldTally.belowMinYieldCount).toBe(1);
    expect(yieldTally.bestAnnualizedYieldPct).toBeCloseTo(Math.max(...yields), 10);
  });

  it("gives the same candidates with or without a tally", () => {
    const input = baseInput({ quotes: [quoteAt(90, "P"), quoteAt(110, "C")] });
    expect(buildSignalCandidates({ ...input, exclusionTally: emptyCandidateExclusionTally() })).toEqual(buildSignalCandidates(input));
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
