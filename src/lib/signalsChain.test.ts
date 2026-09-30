import { describe, expect, it } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { buildSignalCandidates, type SignalCandidatesInput, type SignalContractExclusion, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { assembleSignalsChain, describeContractExclusion, scoreSignalContract, scoreTickerWithExclusions } from "./signalsChain.js";
import { candidateContractKey, computeUncompensatedByContract, contractKey, scoreTicker } from "./signalsLiveScoring.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const near = "2026-10-21";
const far = "2026-11-20";
const years30 = 30 / 365;
const years60 = 60 / 365;
const slice = (expiry: string, years: number, overrides: Partial<SignalSurfaceSlice> = {}): SignalSurfaceSlice => ({
  expiry,
  status: "ok",
  parameters: params,
  kMin: -0.4,
  kMax: 0.4,
  yearsToExpiry: years,
  forwardPrice: forward,
  pointCount: 20,
  rmseVolatility: 0.01,
  minButterflyDensity: 0.8,
  droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 },
  calendarChecks: 0,
  calendarViolations: 0,
  ...overrides,
});

function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number, spreadFraction = 0.04): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * (1 - spreadFraction / 2), ask: mid * (1 + spreadFraction / 2), source: "snapshot" };
}

// Near expiry: OTM puts 90/95, the ATM pair at 100 (the 100 put is in the money against a forward of 100 -- the builder's
// OTM test is strike >= forward for a call), OTM calls 105/110, and a one-sided 115 call. Far expiry: 85 put, 115 call.
const nearQuotes: SignalQuote[] = [
  quoteAt(90, "P", near, years30),
  quoteAt(95, "P", near, years30),
  quoteAt(100, "P", near, years30),
  quoteAt(100, "C", near, years30),
  quoteAt(105, "C", near, years30),
  quoteAt(110, "C", near, years30),
  { expiry: near, strike: 115, right: "C", bid: null, ask: 0.05, source: "snapshot" },
];

function inputs(overrides: Partial<TickerSignalsInputs> = {}): TickerSignalsInputs {
  return {
    tickerId: "t1",
    symbol: "TEST",
    companyName: "Test Co",
    sector: null,
    header: { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100 },
    slices: [slice(near, years30), slice(far, years60)],
    quotes: [...nearQuotes, quoteAt(85, "P", far, years60), quoteAt(115, "C", far, years60)],
    dayQuotes: [],
    forecast: { volatility: 0.15, windowDays: 63 },
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    momentum: null,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: null,
    freeShares: 0,
    openShortLegs: [],
    dailyBarCount: 1253,
    dividendCadenceUnknown: false,
    todayEasternIso: "2026-09-21",
    ...overrides,
  };
}
const account = { freeCash: 1_000_000 };
const settings = { maxDeltaDriftPct: 100, minAnnualizedYieldPct: 0, maxNetDelta: 0.35, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 };
const pathCount = 200;

describe("buildSignalCandidates exclusion reporting", () => {
  const builderInput: SignalCandidatesInput = {
    spotPrice: forward,
    riskFreeRate: rate,
    forecast: { volatility: 0.15, windowDays: 63 as const },
    slices: [slice(near, years30), slice(far, years60, { status: "poor_fit", parameters: null })],
    quotes: [...nearQuotes, quoteAt(85, "P", far, years60), quoteAt(95, "P", "2026-12-18", 88 / 365)],
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEventDatesIso: [],
    snapshotDateIso: "2026-09-21",
    freeShares: 0,
    freeCash: 1_000_000,
    maxNetDelta: 0.3,
    minAnnualizedYieldPct: 0,
  };

  it("never changes the candidates, and reports every other quote exactly once", () => {
    const exclusions: [string, SignalContractExclusion][] = [];
    const observed = buildSignalCandidates({ ...builderInput, onContractExcluded: (quote, exclusion) => void exclusions.push([contractKey(quote), exclusion]) });
    const plain = buildSignalCandidates(builderInput);
    expect(observed).toEqual(plain);
    const candidateKeys = new Set(plain.map(candidateContractKey));
    const excludedKeys = exclusions.map(([key]) => key);
    expect(new Set(excludedKeys).size).toBe(excludedKeys.length);
    expect([...candidateKeys, ...excludedKeys].sort()).toEqual(builderInput.quotes.map(contractKey).sort());
  });

  it("names the reason in the builder's own order", () => {
    const exclusions = new Map<string, SignalContractExclusion>();
    buildSignalCandidates({ ...builderInput, onContractExcluded: (quote, exclusion) => exclusions.set(contractKey(quote), exclusion) });
    expect(exclusions.get(`${near}|100|P`)).toEqual({ kind: "in_the_money" });
    expect(exclusions.get(`${near}|115|C`)).toEqual({ kind: "no_two_sided_quote" });
    expect(exclusions.get(`${far}|85|P`)).toEqual({ kind: "surface_fit_rejected", sliceStatus: "poor_fit" });
    expect(exclusions.get(`2026-12-18|95|P`)).toEqual({ kind: "no_surface_slice" });
    const atm = exclusions.get(`${near}|100|C`);
    expect(atm?.kind).toBe("above_max_delta");
    expect(atm && "delta" in atm ? atm.delta : null).toBeGreaterThan(0.3);
  });

  it("reports the earnings date an expiry spans, and a yield under the minimum with the yield", () => {
    const exclusions = new Map<string, SignalContractExclusion>();
    buildSignalCandidates({ ...builderInput, earningsDatesIso: ["2026-10-15", "2026-07-15"], minAnnualizedYieldPct: 1_000, onContractExcluded: (quote, exclusion) => exclusions.set(contractKey(quote), exclusion) });
    expect(exclusions.get(`${near}|90|P`)).toEqual({ kind: "spans_earnings", earningsDateIso: "2026-10-15" });
    const noEarnings = new Map<string, SignalContractExclusion>();
    buildSignalCandidates({ ...builderInput, minAnnualizedYieldPct: 1_000, onContractExcluded: (quote, exclusion) => noEarnings.set(contractKey(quote), exclusion) });
    const belowYield = noEarnings.get(`${near}|90|P`);
    expect(belowYield?.kind).toBe("below_min_yield");
    expect(belowYield && belowYield.kind === "below_min_yield" ? belowYield.minAnnualizedYieldPct : null).toBe(1_000);
  });
});

describe("scoreTicker with an observer", () => {
  it("scores identically with and without it", () => {
    const withObserver = scoreTickerWithExclusions(inputs(), account, settings).scored;
    expect(withObserver).toEqual(scoreTicker(inputs(), account, settings));
    expect(withObserver.candidates.length).toBeGreaterThan(0);
  });
});

describe("describeContractExclusion", () => {
  it("reads as plain words with absolute delta and percent yields", () => {
    expect(describeContractExclusion({ kind: "above_max_delta", delta: -0.4712, maxNetDelta: 0.35 })).toBe("Δ 0.47 is over your max Δ 0.35");
    expect(describeContractExclusion({ kind: "below_min_yield", delta: 0.1, annualizedYieldPct: 12.34, minAnnualizedYieldPct: 20 })).toBe("Yield 12.3%/yr is under your min 20%/yr");
    expect(describeContractExclusion({ kind: "spans_earnings", earningsDateIso: "2026-10-15" })).toBe("Expiry spans earnings on Oct 15");
    expect(describeContractExclusion({ kind: "in_the_money" })).toBe("In the money — Signals only sells out-of-the-money contracts");
    expect(describeContractExclusion({ kind: "surface_fit_rejected", sliceStatus: "butterfly_arbitrage" })).toBe("This expiry's volatility surface fit was rejected (butterfly arbitrage)");
  });
});

describe("assembleSignalsChain", () => {
  const strikesByExpiry = new Map([
    ["20261021", [80, 85, 90, 95, 100, 105, 110, 115, 120]],
    ["20261120", [85, 100, 115]],
    ["20270115", [100]], // beyond the 90-day capture range
    ["20260918", [100]], // already expired
  ]);
  const chainFor = (tickerInputs: TickerSignalsInputs, requestedExpiry: string | null = null, capturedDeltaByContract = new Map<string, number>()) =>
    assembleSignalsChain({
      symbol: "TEST",
      inSignalsUniverse: true,
      strikesByExpiry,
      todayEasternIso: "2026-09-21",
      requestedExpiry,
      scoring: { inputs: tickerInputs, ...scoreTickerWithExclusions(tickerInputs, account, settings) },
      capturedDeltaByContract,
    });

  it("lists the stored expiries inside the capture range with DTE, candidate and surface flags", () => {
    const chain = chainFor(inputs({ slices: [slice(near, years30)] }));
    expect(chain.expiries).toEqual([
      { expiry: near, dte: 30, hasCandidate: true, hasFittedSurface: true },
      { expiry: far, dte: 60, hasCandidate: false, hasFittedSurface: false },
    ]);
  });

  it("defaults to the first expiry with a candidate, honours a requested one, and ignores an unknown one", () => {
    const withoutNearCandidates = inputs({ quotes: [quoteAt(100, "P", near, years30), quoteAt(85, "P", far, years60)] });
    expect(chainFor(withoutNearCandidates).selectedExpiry).toBe(far);
    expect(chainFor(inputs(), far).selectedExpiry).toBe(far);
    expect(chainFor(inputs(), "2026-12-31").selectedExpiry).toBe(near);
  });

  it("marks every strike's call and put as candidate, filtered (with reason) or not_captured", () => {
    const chain = chainFor(inputs(), near, new Map([[`${near}|100|P`, -0.52]]));
    expect(chain.strikes.map((row) => row.strike)).toEqual([80, 85, 90, 95, 100, 105, 110, 115, 120]);
    const row = (strike: number) => chain.strikes.find((entry) => entry.strike === strike)!;

    expect(row(90).put.state).toBe("candidate");
    expect(row(90).put.grade).not.toBeNull();
    expect(row(90).put.netEdge).not.toBeNull();
    expect(row(110).call.state).toBe("candidate");

    // ITM put at the ATM strike: quoted, excluded, IBKR delta from the capture since scoring never computed one.
    expect(row(100).put).toMatchObject({ state: "filtered", reason: "In the money — Signals only sells out-of-the-money contracts", delta: -0.52, quoteSource: "snapshot" });
    expect(row(100).call.state).toBe("filtered");
    expect(row(100).call.reason).toMatch(/^Δ 0\.\d\d is over your max Δ 0\.35$/);
    expect(row(115).call).toMatchObject({ state: "filtered", reason: "No two-sided quote", bid: null, ask: 0.05 });

    // ITM strikes the capture never asked for, and far OTM strikes outside its window.
    expect(row(110).put).toMatchObject({ state: "not_captured", bid: null, ask: null, delta: null, reason: null });
    expect(row(90).call.state).toBe("not_captured");
    expect(row(80).put.state).toBe("not_captured");
  });

  it("shows a contract the Day Signals loop quoted but the 10:00 capture never stored (the price moved) as a scored candidate", () => {
    const fresh = quoteAt(85, "P", near, years30);
    const dayQuote = { expiry: near, strike: 85, right: "P" as const, bid: fresh.bid, ask: fresh.ask, quotedAt: "2026-09-21T15:00:00Z" };
    const putAt85 = (tickerInputs: TickerSignalsInputs) => chainFor(tickerInputs, near).strikes.find((entry) => entry.strike === 85)!.put;
    expect(putAt85(inputs()).state).toBe("not_captured");
    expect(putAt85(inputs({ dayQuotes: [dayQuote] }))).toMatchObject({ state: "candidate", quoteSource: "day", bid: dayQuote.bid, ask: dayQuote.ask });
  });

  it("marks quoted contracts of an unscored ticker as filtered with the ticker's reason", () => {
    const chain = chainFor(inputs({ forecast: null }), near);
    expect(chain.unscoredReason).toBe("no_forecast");
    expect(chain.expiries.every((entry) => !entry.hasCandidate)).toBe(true);
    const put90 = chain.strikes.find((entry) => entry.strike === 90)!.put;
    expect(put90).toMatchObject({ state: "filtered", reason: "No volatility forecast for this ticker" });
  });

  it("still returns the whole grid, all not_captured, for a ticker with no snapshot", () => {
    const chain = chainFor(inputs({ header: null, slices: [], quotes: [] }), null);
    expect(chain.selectedExpiry).toBe(near);
    expect(chain.strikes).toHaveLength(9);
    expect(chain.strikes.every((row) => row.call.state === "not_captured" && row.put.state === "not_captured")).toBe(true);
  });
});

describe("scoreSignalContract", () => {
  const score = (contract: { expiry: string; strike: number; right: "C" | "P" }, overrides: Partial<Parameters<typeof scoreSignalContract>[0]> = {}) =>
    scoreSignalContract({ inputs: inputs(), account, settings, contract, liveQuote: null, liveSpot: null, capturedDelta: null, uncompensatedSharePathCount: pathCount, ...overrides });

  it("scores a candidate identically to the modal's own candidate (parity)", () => {
    const scored = scoreTicker(inputs(), account, settings, { spotPrice: forward, priceSource: "snapshot" });
    for (const candidate of scored.candidates) {
      const right = candidate.strategyKey === "covered_call" ? "C" : "P";
      const result = score({ expiry: candidate.expiry, strike: candidate.strike, right });
      const uncompensated = computeUncompensatedByContract([candidate], forward, inputs().slices, pathCount).get(candidateContractKey(candidate)) ?? null;
      const { scored: isScored, right: resultRight, isCandidate, notCandidateReason, spotPrice, priceSource, rolls, ...asCandidate } = result as Extract<typeof result, { scored: true }>;
      expect(rolls).toEqual([]);
      expect({ isScored, resultRight, isCandidate, notCandidateReason, spotPrice, priceSource }).toEqual({ isScored: true, resultRight: right, isCandidate: true, notCandidateReason: null, spotPrice: forward, priceSource: "snapshot" });
      expect(asCandidate).toEqual({ ...candidate, uncompensatedSharePercent: uncompensated });
    }
  });

  it("scores the contract as a roll target for each open short leg of the same right, filters lifted into warnings", () => {
    const heldPut = { legId: "leg-put", positionId: "pos-1", strategyKey: "cash_secured_put" as const, expiry: near, strike: 95, right: "P" as const, quantity: 2, entryPrice: 1.5, entryAtIso: "2026-09-10T14:00:00Z" };
    const heldCall = { ...heldPut, legId: "leg-call", strategyKey: "covered_call" as const, strike: 105, right: "C" as const };
    const withHeld = { inputs: inputs({ openShortLegs: [heldPut, heldCall] }) };
    const result = score({ expiry: near, strike: 90, right: "P" }, withHeld);
    if (!result.scored) throw new Error("expected a scored contract");
    expect(result.rolls.map((roll) => roll.legId)).toEqual(["leg-put"]);
    const roll = result.rolls[0]!;
    const { rolls: ignored, scored: ignoredScored, right: ignoredRight, isCandidate, notCandidateReason, spotPrice, priceSource, ...replacement } = result;
    expect(roll.replacement).toEqual(replacement);
    // Same-expiry lower strike: cheaper than the held put, so a debit -- but lower delta, so no delta warning.
    expect(roll.warnings).toEqual(["debit"]);
    expect(roll.netCreditPerShare).toBeLessThan(0);
    // A contract of the other right rolls only the call leg.
    const callResult = score({ expiry: near, strike: 110, right: "C" }, withHeld);
    expect(callResult.scored && callResult.rolls.map((entry) => entry.legId)).toEqual(["leg-call"]);
  });

  it("parity holds at a live spot too", () => {
    const liveSpot = { spotPrice: 101.5, priceSource: "live" as const };
    const scored = scoreTicker(inputs(), account, settings, { ...liveSpot, liveQuotes: [] });
    const candidate = scored.candidates.find((entry) => entry.strike === 90)!;
    const result = score({ expiry: near, strike: 90, right: "P" }, { liveSpot });
    expect(result.scored && result.netEdge).toBe(candidate.netEdge);
    expect(result.scored && result.delta).toBe(candidate.delta);
  });

  it("scores a filtered contract with the filters lifted and says why it is not a candidate", () => {
    const result = score({ expiry: near, strike: 100, right: "C" });
    expect(result.scored).toBe(true);
    expect(result.isCandidate).toBe(false);
    expect(result.notCandidateReason).toMatch(/is over your max Δ 0\.35$/);
    const lifted = scoreTicker(inputs(), account, { ...settings, maxNetDelta: 1 }).candidates.find((candidate) => candidate.strike === 100 && candidate.expiry === near)!;
    expect(result.scored && result.netEdge).toBe(lifted.netEdge);
    expect(result.scored && result.grade).toBe(lifted.grade);
  });

  it("returns an ITM contract the capture never quoted unscored, with the live quote and IBKR delta", () => {
    const liveQuote = { bid: 10.1, ask: 10.4, delta: -0.82, quotedAt: "2026-09-21T15:00:00.000Z" };
    const result = score({ expiry: near, strike: 110, right: "P" }, { liveQuote });
    expect(result).toMatchObject({ scored: false, isCandidate: false, bid: 10.1, ask: 10.4, delta: -0.82, quoteSource: "live", quotedAt: liveQuote.quotedAt, strategyKey: "cash_secured_put", dte: 30 });
    expect(result.notCandidateReason).toBe("In the money — Signals only sells out-of-the-money contracts — shown without a Signals score");
  });

  it("scores an OTM contract outside the capture window from its live quote", () => {
    const live = quoteAt(80, "P", near, years30);
    const result = score({ expiry: near, strike: 80, right: "P" }, { liveQuote: { bid: live.bid, ask: live.ask, delta: -0.02, quotedAt: "2026-09-21T15:00:00.000Z" } });
    expect(result.scored).toBe(true);
    expect(result.scored && result.quoteSource).toBe("live");
    expect(result.scored && result.bid).toBe(live.bid);
  });

  it("without a live quote or a capture row, returns nothing to price (lines off / market closed)", () => {
    const result = score({ expiry: near, strike: 110, right: "P" }, { capturedDelta: null });
    expect(result).toMatchObject({ scored: false, bid: null, ask: null, delta: null, quoteSource: null, quotedAt: null });
    expect(score({ expiry: near, strike: 80, right: "P" }).notCandidateReason).toBe("Not in today's capture and no live quote (market closed or live data off) — shown without a Signals score");
    expect(score({ expiry: near, strike: 115, right: "C" }).notCandidateReason).toBe("No two-sided quote — shown without a Signals score");
  });

  it("falls back to the stored quote and captured delta for an expiry without a surface slice", () => {
    const result = score({ expiry: far, strike: 85, right: "P" }, { inputs: inputs({ slices: [slice(near, years30)] }), capturedDelta: -0.12 });
    const stored = quoteAt(85, "P", far, years60);
    expect(result).toMatchObject({ scored: false, bid: stored.bid, ask: stored.ask, delta: -0.12, quoteSource: "snapshot" });
    expect(result.notCandidateReason).toBe("No volatility surface for this expiry today — shown without a Signals score");
  });
});
