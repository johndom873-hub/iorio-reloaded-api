import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { buildSignalCandidates, frictionDollarsPerContract, scoreContractWithModel, type CandidateModelContext, type SignalCandidate, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { buildCommissionEstimator, flatCommissionEstimator } from "./commissionEstimate.js";
import { gradeForEdgeMargin } from "./contractValuation.js";
import { varianceSessionsToExpiry } from "./varianceClock.js";
import { volatilityModelTables } from "./volatilityModelTables.generated.js";
import { fixtureCandidateModel, fixtureHeldLegModel, fixtureModelForecast, fixtureRollModel, fixtureTradingSessions } from "./testSupport/valuationModelFixtures.js";
import { assignmentRiskDeltaThreshold, buildRollCandidates, compareRollsByModel, recostReplacementCommission, scoreRollModel, scoreRollPair, decayedFractionOfEntryCredit, heldLegContractKey, nearExpiryDaysThreshold, pickBestRoll, rollCandidateKey, scoreHeldLegs, type OpenShortLeg } from "./rollSignalCandidates.js";

// The valuation model's roll (model review P5). Fixtures mirror signalsLiveScoring.test.ts: one
// SVI surface, a 30-day and a 60-day slice with the SAME implied volatility at every
// log-moneyness (the 60-day total variance is doubled), Black-76 quotes at the surface.

const forward = 100;
const rate = 0.04;
const params30: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const params60: RawSviParameters = { ...params30, a: params30.a * 2, b: params30.b * 2 };
const years30 = 30 / 365;
const years60 = 60 / 365;
const expiry30 = "2026-10-24";
const expiry60 = "2026-11-23";
const snapshotDateIso = "2026-09-24";

const slice = (expiry: string, years: number, parameters: RawSviParameters): SignalSurfaceSlice => ({
  expiry,
  status: "ok",
  parameters,
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
});
const slices = [slice(expiry30, years30, params30), slice(expiry60, years60, params60)];

function surfaceIvAt(strike: number, expiry: string): number {
  const s = slices.find((entry) => entry.expiry === expiry)!;
  return Math.sqrt(sviTotalVariance(s.parameters!, Math.log(strike / forward)) / s.yearsToExpiry);
}

function quoteAt(strike: number, right: "C" | "P", expiry: string, spreadFraction = 0.04): SignalQuote {
  const years = expiry === expiry30 ? years30 : years60;
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, surfaceIvAt(strike, expiry), right === "C");
  return { expiry, strike, right, bid: mid * (1 - spreadFraction / 2), ask: mid * (1 + spreadFraction / 2), source: "snapshot" };
}

// Valued at the 10:00 ET snapshot with a YZ21 forecast 3 points under the 30-day ATM IV, fitted forward and spot 100.
const forecastVolatility = surfaceIvAt(100, expiry30) - 0.03;
const valuedAtMs = Date.parse(`${snapshotDateIso}T14:00:00Z`);
const modelContext: CandidateModelContext = {
  tables: volatilityModelTables,
  forecast: fixtureModelForecast(forecastVolatility),
  group: "stock",
  varianceSessionsAt: (atMs, expiryIso) => varianceSessionsToExpiry(atMs, expiryIso, fixtureTradingSessions),
  quoteInstantMs: () => valuedAtMs,
  forwardForQuote: (fittedSlice) => fittedSlice.forwardPrice,
  spotForQuote: () => forward,
};
const otmQuotes: SignalQuote[] = [];
for (const expiry of [expiry30, expiry60]) {
  for (const strike of [80, 85, 90, 95]) otmQuotes.push(quoteAt(strike, "P", expiry));
  for (const strike of [105, 110, 115]) otmQuotes.push(quoteAt(strike, "C", expiry));
}

function candidates(quotes = otmQuotes, model: CandidateModelContext | null = modelContext): SignalCandidate[] {
  return buildSignalCandidates({
    spotPrice: forward,
    riskFreeRate: rate,
    slices,
    quotes,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    todayEasternIso: snapshotDateIso,
    scoredAtMs: Date.parse(`${snapshotDateIso}T14:30:00Z`),
    freeShares: 0,
    freeCash: 1_000_000,
    deltaTargetMin: 0,
    deltaTargetMax: 1,
    minAnnualizedYieldPct: 0,
    spreadShareCharged: 1,
    model,
  });
}

const leg = (overrides: Partial<OpenShortLeg> = {}): OpenShortLeg => ({
  legId: "leg-1",
  positionId: "pos-1",
  strategyKey: "cash_secured_put",
  expiry: expiry30,
  strike: 95,
  right: "P",
  quantity: 2,
  entryPrice: 1.5,
  entryAtIso: "2026-09-10T14:00:00Z",
  ...overrides,
});

function scoreOne(theLeg: OpenShortLeg, quotes: SignalQuote[] = otmQuotes, model: CandidateModelContext | null = modelContext) {
  return scoreHeldLegs([theLeg], { spotPrice: forward, riskFreeRate: rate, slices, quotes, spreadShareCharged: 1, model })[0]!;
}

describe("scoreHeldLegs", () => {
  it("scores an OTM held put through the same surface as a candidate at that contract (surface IV, delta), charged the buy-back's friction", () => {
    const held = scoreOne(leg());
    expect(held.unscoredReason).toBeNull();
    const iv = surfaceIvAt(95, expiry30);
    const quote = otmQuotes.find((q) => q.expiry === expiry30 && q.strike === 95 && q.right === "P")!;
    expect(held.surfaceImpliedVolatility).toBeCloseTo(iv, 12);
    expect(held.delta).toBeCloseTo(blackScholesDelta(forward, 95, years30, rate, iv, false), 12);
    // Close cost = λ 1 × half-spread × 100 + the $0.68 buy commission.
    expect(held.model!.closeCostDollars).toBeCloseTo(((quote.ask! - quote.bid!) / 2) * 100 + 0.68, 9);
    expect(held.dte).toBe(30);
    expect(held.dollarRisk).toBeCloseTo((95 - held.mid!) * 100, 9);
    expect(held.quoteSource).toBe("snapshot");
    // Rich enough IV versus the forecast on both sides, but a 30 DTE, |delta| < 0.5, fresh leg: no flags.
    expect(held.flags).toEqual([]);
  });

  it("scores an in-the-money held put through the same surface (the new-trade build ignores that side)", () => {
    const itmQuote = quoteAt(105, "P", expiry30);
    const held = scoreOne(leg({ strike: 105 }), [...otmQuotes, itmQuote]);
    expect(held.unscoredReason).toBeNull();
    expect(held.surfaceImpliedVolatility).toBeCloseTo(surfaceIvAt(105, expiry30), 12);
    expect(Math.abs(held.delta!)).toBeGreaterThan(assignmentRiskDeltaThreshold);
    expect(held.flags).toContain("assignment_risk");
    // The same ITM contract is never a new-trade candidate.
    expect(candidates([...otmQuotes, itmQuote]).some((c) => c.strike === 105 && c.strategyKey === "cash_secured_put")).toBe(false);
  });

  it("flags near_expiry at or under 21 DTE and decayed at or under half the entry credit", () => {
    const shortSlice = slice("2026-10-10", 16 / 365, { ...params30, a: (params30.a * 16) / 30, b: (params30.b * 16) / 30 });
    const iv = Math.sqrt(sviTotalVariance(shortSlice.parameters!, Math.log(95 / forward)) / shortSlice.yearsToExpiry);
    const mid = blackScholesPriceOnForward(forward, 95, shortSlice.yearsToExpiry, rate, iv, false);
    const quote: SignalQuote = { expiry: "2026-10-10", strike: 95, right: "P", bid: mid * 0.98, ask: mid * 1.02, source: "day", quotedAt: "2026-09-24T15:00:00Z" };
    const held = scoreHeldLegs([leg({ expiry: "2026-10-10", entryPrice: mid / decayedFractionOfEntryCredit + 0.01 })], { spotPrice: forward, riskFreeRate: rate, slices: [shortSlice], quotes: [quote], spreadShareCharged: 1, model: modelContext })[0]!;
    expect(held.dte).toBeLessThanOrEqual(nearExpiryDaysThreshold);
    expect(held.flags).toEqual(["near_expiry", "decayed"]);
    expect(held.quoteSource).toBe("day");
    expect(held.quotedAt).toBe("2026-09-24T15:00:00Z");
    const notDecayed = scoreHeldLegs([leg({ expiry: "2026-10-10", entryPrice: mid })], { spotPrice: forward, riskFreeRate: rate, slices: [shortSlice], quotes: [quote], spreadShareCharged: 1, model: modelContext })[0]!;
    expect(notDecayed.flags).toEqual(["near_expiry"]);
  });

  it("reports why a leg cannot be scored instead of inventing numbers: no slice, no two-sided quote, no forecast", () => {
    expect(scoreOne(leg({ expiry: "2027-06-18" })).unscoredReason).toBe("no_slice");
    const noQuote = scoreOne(leg({ strike: 97.5 }));
    expect(noQuote.unscoredReason).toBe("no_quote");
    expect(noQuote.dte).toBe(30);
    const oneSided = scoreOne(leg(), [...otmQuotes.filter((q) => !(q.strike === 95 && q.expiry === expiry30)), { expiry: expiry30, strike: 95, right: "P", bid: 1.2, ask: null }]);
    expect(oneSided.unscoredReason).toBe("no_quote");
    expect(scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices, quotes: otmQuotes, spreadShareCharged: 1, model: null })[0]!.unscoredReason).toBe("no_forecast");
    expect(scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices, quotes: otmQuotes, spreadShareCharged: 1 })[0]!.unscoredReason).toBe("no_forecast");
    expect(heldLegContractKey(leg())).toBe(`${expiry30}|95|P`);
  });

  it("leaves a leg with no vega left unscored as no_quote: a 0.01% total-volatility slice puts the 95 put 513 standard deviations out", () => {
    // σ√T = √1e-8 = 0.0001; d1 = ln(100 / 95) ÷ 0.0001 ≈ 513, so φ(d1) underflows and vega is 0.
    const flatSlice = { ...slices[0]!, parameters: { a: 1e-8, b: 0, rho: 0, m: 0, sigma: 0.1 } };
    const held = scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices: [flatSlice], quotes: otmQuotes, spreadShareCharged: 1, model: modelContext })[0]!;
    expect(held).toMatchObject({ unscoredReason: "no_quote", model: null, delta: null, dte: 30 });
  });

  it("keeps a real two-sided quote on a leg that is unscored for another reason, so a roll can still be priced at the quotes", () => {
    const putQuote = { ...otmQuotes.find((q) => q.expiry === expiry30 && q.strike === 95 && q.right === "P")!, source: "day" as const, quotedAt: "2026-09-24T15:00:00Z" };
    const midOfPut = (putQuote.bid! + putQuote.ask!) / 2;

    const rejectedFit = scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices: [{ ...slices[0]!, status: "poor_fit" }, slices[1]!], quotes: [putQuote], spreadShareCharged: 1, model: modelContext })[0]!;
    expect(rejectedFit.unscoredReason).toBe("no_slice");
    expect(rejectedFit).toMatchObject({ bid: putQuote.bid, ask: putQuote.ask, quoteSource: "day", quotedAt: "2026-09-24T15:00:00Z", model: null, delta: null });
    expect(rejectedFit.mid).toBeCloseTo(midOfPut, 12);
    expect(rejectedFit.dollarRisk).toBeCloseTo((95 - midOfPut) * 100, 9);

    const coveredCall = leg({ strategyKey: "covered_call", right: "C", strike: 105 });
    const callQuote = otmQuotes.find((q) => q.expiry === expiry30 && q.strike === 105 && q.right === "C")!;
    const noSlice = scoreHeldLegs([coveredCall], { spotPrice: 98, riskFreeRate: rate, slices: [], quotes: [callQuote], spreadShareCharged: 1, model: modelContext })[0]!;
    expect(noSlice.unscoredReason).toBe("no_slice");
    expect(noSlice.dollarRisk).toBeCloseTo((98 - (callQuote.bid! + callQuote.ask!) / 2) * 100, 9);

    const noForecast = scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices, quotes: [putQuote], spreadShareCharged: 1, model: null })[0]!;
    expect(noForecast).toMatchObject({ unscoredReason: "no_forecast", bid: putQuote.bid, ask: putQuote.ask, quoteSource: "day" });

    expect(scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, slices: [], quotes: [], spreadShareCharged: 1, model: modelContext })[0]).toMatchObject({ unscoredReason: "no_slice", bid: null, ask: null, mid: null, dollarRisk: null });
    expect(scoreRollPair(rejectedFit, candidates()[0]!)).toBeNull();
  });
});

describe("compareRollsByModel", () => {
  const roll = (netExpectedPnl: number, edgeMargin: number) => ({ model: fixtureRollModel({ netExpectedPnl, edgeMargin }) });
  it("orders by the model's net roll $ across the held quantity, highest first, whatever the margin says", () => {
    const sorted = [roll(-5, 0.4), roll(40, 0.01), roll(120, 0.05)].sort(compareRollsByModel);
    expect(sorted.map((entry) => entry.model.netExpectedPnl)).toEqual([120, 40, -5]);
  });
});

describe("buildRollCandidates", () => {
  const held = scoreOne(leg());
  const all = candidates();
  const rolls = buildRollCandidates([held], all);

  it("carries the leg, the replacement and their differences: net credit at the mids, delta and exposure changes", () => {
    expect(rolls.length).toBeGreaterThan(0);
    for (const roll of rolls) {
      const B = roll.replacement;
      expect(roll.quantity).toBe(2);
      expect(roll.legId).toBe("leg-1");
      expect(roll.deltaChange).toBeCloseTo(Math.abs(B.delta) - Math.abs(held.delta!), 12);
      expect(roll.dollarRiskChange).toBeCloseTo(B.dollarRisk - held.dollarRisk!, 9);
      expect(roll.netCreditPerShare).toBeCloseTo((B.bid + B.ask) / 2 - held.mid!, 12);
    }
  });

  it("keeps only the same right, a different contract, a lower-or-equal |delta| and a positive net credit", () => {
    for (const roll of rolls) {
      const B = roll.replacement;
      expect(B.strategyKey).toBe("cash_secured_put");
      expect(B.expiry === expiry30 && B.strike === 95).toBe(false);
      expect(Math.abs(B.delta)).toBeLessThanOrEqual(Math.abs(held.delta!));
      expect(roll.netCreditPerShare).toBeGreaterThan(0);
    }
    // Every same-expiry put with a lower strike is cheaper (a debit) and every higher strike has more delta:
    // the only credit rolls with lower delta go out in time.
    expect(rolls.every((roll) => roll.replacement.expiry === expiry60)).toBe(true);
    // The excluded pairs are the ones the filters name, not an accident of the fixture.
    const excluded = all.filter((B) => B.strategyKey === "cash_secured_put" && !rolls.some((roll) => roll.replacement === B));
    for (const B of excluded) {
      const sameContract = B.expiry === expiry30 && B.strike === 95;
      const riskier = Math.abs(B.delta) > Math.abs(held.delta!);
      const debit = (B.bid + B.ask) / 2 - held.mid! <= 0;
      expect(sameContract || riskier || debit).toBe(true);
    }
    expect(all.some((B) => B.strategyKey === "covered_call")).toBe(true);
  });

  it("sorts by the model's net roll $, highest first, and pickBestRoll agrees; keys are unique per (leg, replacement)", () => {
    for (let index = 1; index < rolls.length; index += 1) {
      expect(rolls[index - 1]!.model.netExpectedPnl).toBeGreaterThanOrEqual(rolls[index]!.model.netExpectedPnl);
    }
    expect(pickBestRoll(rolls)).toBe(rolls[0]);
    expect(pickBestRoll([])).toBeNull();
    expect(new Set(rolls.map(rollCandidateKey)).size).toBe(rolls.length);
    expect(rollCandidateKey(rolls[0]!)).toBe(`leg-1|${rolls[0]!.replacement.expiry}|${rolls[0]!.replacement.strike}|P`);
  });

  it("produces nothing for an unscored leg, and carries the held leg's flags onto every roll", () => {
    expect(buildRollCandidates([scoreOne(leg({ strike: 97.5 }))], all)).toEqual([]);
    // An ITM 105 put at 30 days: the 60-day 95 put is cheaper (a debit) and every 60-day put above it is riskier or a debit
    // too -- so give the leg a quote at half the surface price to make the 60-day 95 put a credit roll, and the
    // assignment_risk flag rides onto it.
    const itmQuote = quoteAt(105, "P", expiry30);
    const cheapItm: typeof itmQuote = { ...itmQuote, bid: itmQuote.bid! * 0.3, ask: itmQuote.ask! * 0.3 };
    const itm = scoreOne(leg({ strike: 105 }), [...otmQuotes, cheapItm]);
    const fromItm = buildRollCandidates([itm], all);
    expect(fromItm.length).toBeGreaterThan(0);
    expect(fromItm.every((roll) => roll.flags.includes("assignment_risk") && roll.netCreditPerShare > 0 && Math.abs(roll.replacement.delta) <= Math.abs(itm.delta!))).toBe(true);
  });

  it("a covered-call leg only rolls to calls", () => {
    const callLeg = leg({ legId: "leg-c", strategyKey: "covered_call", strike: 105, right: "C" });
    const heldCall = scoreOne(callLeg);
    expect(heldCall.unscoredReason).toBeNull();
    expect(heldCall.dollarRisk).toBeCloseTo((forward - heldCall.mid!) * 100, 9);
    const callRolls = buildRollCandidates([heldCall], all);
    expect(callRolls.every((roll) => roll.replacement.strategyKey === "covered_call")).toBe(true);
  });
});

describe("scoreRollPair", () => {
  const held = scoreOne(leg());
  const all = candidates();
  const putAt = (strike: number, expiry: string) => all.find((B) => B.strategyKey === "cash_secured_put" && B.strike === strike && B.expiry === expiry)!;

  it("is the model's roll with no warnings for a listed roll, and buildRollCandidates returns exactly those pairs", () => {
    const listed = buildRollCandidates([held], all);
    expect(listed.length).toBeGreaterThan(0);
    for (const roll of listed) {
      expect(scoreRollPair(held, roll.replacement)).toEqual(roll);
      expect(roll.warnings).toEqual([]);
    }
  });

  it("turns the list's two hard filters into warnings instead of dropping the pair", () => {
    const debit = scoreRollPair(held, putAt(90, expiry30))!; // cheaper, lower delta
    expect(debit.warnings).toEqual(["debit"]);
    expect(debit.netCreditPerShare).toBeLessThan(0);
    expect(debit.model.netExpectedPnlPerContract).toBeCloseTo(debit.replacement.model.expectedPnlDollars - held.model!.holdValueDollars - held.model!.closeCostDollars, 9);
    const highDeltaHeld = scoreOne(leg({ strike: 90 }));
    const higher = scoreRollPair(highDeltaHeld, putAt(95, expiry30))!;
    expect(higher.warnings).toContain("higher_delta");
    expect(higher.deltaChange).toBeGreaterThan(0);
  });

  it("is null for the same contract, the other right, or an unscored held leg", () => {
    expect(scoreRollPair(held, putAt(95, expiry30))).toBeNull();
    const call = all.find((B) => B.strategyKey === "covered_call")!;
    expect(scoreRollPair(held, call)).toBeNull();
    const unscored = scoreOne(leg(), []);
    expect(unscored.unscoredReason).not.toBeNull();
    expect(scoreRollPair(unscored, putAt(90, expiry30))).toBeNull();
  });

  it("is null when the held leg has no model: scored on the surface, but valued after its expiry's close", () => {
    const afterClose = scoreOne(leg(), otmQuotes, { ...modelContext, quoteInstantMs: () => Date.parse(`${expiry60}T21:00:00Z`) });
    expect(afterClose.unscoredReason).toBeNull();
    expect(afterClose.model).toBeNull();
    const listedReplacement = buildRollCandidates([held], all)[0]!.replacement;
    expect(scoreRollPair(held, listedReplacement)).not.toBeNull();
    expect(scoreRollPair(afterClose, listedReplacement)).toBeNull();
    expect(scoreRollPair({ ...held, model: null }, listedReplacement)).toBeNull();
    expect(buildRollCandidates([afterClose], all)).toEqual([]);
  });

  describe("commission at the held leg's size (approved 2026-10-02)", () => {
    // 10 sell orders of 5+ contracts at $1.00 a contract: a bucket the flat $0.68 does not match.
    const largeSizeEstimator = buildCommissionEstimator(Array.from({ length: 10 }, () => ({ side: "sell" as const, contracts: 6, commissionDollars: 6 })));
    const replacement = buildRollCandidates([held], all)[0]!.replacement;

    it("leaves a replacement unchanged when the leg's size estimates the same commission", () => {
      expect(recostReplacementCommission(replacement, 1, largeSizeEstimator)).toBe(replacement);
    });

    it("re-prices the commission at the leg's size: $1.00 instead of $0.68 takes $0.32 off the model's Edge $ per contract", () => {
      const recosted = recostReplacementCommission(replacement, 6, largeSizeEstimator);
      expect(recosted.commissionPerContractDollars).toBe(1.0);
      expect(recosted.model.expectedPnlDollars).toBeCloseTo(replacement.model.expectedPnlDollars - 0.32, 10);
      expect({ ...recosted, model: null, commissionPerContractDollars: null }).toEqual({ ...replacement, model: null, commissionPerContractDollars: null });
    });

    it("scoreRollPair carries the re-priced replacement into the model's net roll $: $0.32 less per contract, × 6 contracts", () => {
      const sixContractHeld = { ...held, quantity: 6 };
      const flat = scoreRollPair(sixContractHeld, replacement)!;
      const sized = scoreRollPair(sixContractHeld, replacement, largeSizeEstimator)!;
      expect(sized.model.netExpectedPnlPerContract).toBeCloseTo(flat.model.netExpectedPnlPerContract - 0.32, 10);
      expect(sized.model.netExpectedPnl).toBeCloseTo(flat.model.netExpectedPnl - 0.32 * 6, 9);
      expect(sized.model.edgeMargin).toBe(flat.model.edgeMargin);
      expect(sized.replacement.commissionPerContractDollars).toBe(1.0);
    });
  });
});

describe("valuation model on held legs and rolls (model review, 2026-10-10)", () => {
  const heldQuote = otmQuotes.find((q) => q.expiry === expiry30 && q.strike === 95 && q.right === "P")!;

  it("values a held leg like a sale at its quote, charged the buy-back's friction: hold value = (mid − fair) × 100", () => {
    const held = scoreOne(leg(), otmQuotes, modelContext);
    const closeCost = frictionDollarsPerContract(heldQuote.bid!, heldQuote.ask!, 1, flatCommissionEstimator.perContractDollars("buy", 2));
    const valuation = scoreContractWithModel(modelContext, slices[0]!, { ...heldQuote, bid: heldQuote.bid!, ask: heldQuote.ask! }, rate, closeCost)!;
    expect(held.model).toEqual({ valuation, holdValueDollars: (held.mid! - valuation.fairPrice) * 100, closeCostDollars: closeCost });
    expect(scoreOne(leg(), otmQuotes, null)).toMatchObject({ unscoredReason: "no_forecast", model: null });
  });

  it("nets a roll as the replacement's expected P&L less the held leg's hold value and close cost; margin before friction", () => {
    const held = scoreOne(leg(), otmQuotes, modelContext);
    const rolls = buildRollCandidates([held], candidates(otmQuotes, modelContext));
    expect(rolls.length).toBeGreaterThan(0);
    for (const roll of rolls) {
      const replacement = roll.replacement.model;
      const replacementMid = (roll.replacement.bid + roll.replacement.ask) / 2;
      const perContract = replacement.expectedPnlDollars - held.model!.holdValueDollars - held.model!.closeCostDollars;
      const margin = ((replacementMid - replacement.fairPrice) * 100 - held.model!.holdValueDollars) / (replacementMid * 100);
      expect(roll.model.netExpectedPnlPerContract).toBeCloseTo(perContract, 9);
      expect(roll.model.netExpectedPnl).toBeCloseTo(perContract * 2, 9);
      expect(roll.model.edgeMargin).toBeCloseTo(margin, 12);
      expect(roll.model.grade).toBe(gradeForEdgeMargin(margin));
    }
    // Without the model there is no roll at all: the held leg is unscored and no replacement is a candidate.
    expect(buildRollCandidates([scoreOne(leg(), otmQuotes, null)], candidates(otmQuotes, null))).toEqual([]);
  });

  it("scoreRollModel on round numbers: $60 expected on a $1.00 mid valued at $0.80, holding worth $30 and $5 to close", () => {
    const rollModel = scoreRollModel({ quantity: 2, model: fixtureHeldLegModel(30, 5) }, { bid: 0.95, ask: 1.05, model: fixtureCandidateModel({ expectedPnlDollars: 60, fairPrice: 0.8 }) })!;
    expect(rollModel.netExpectedPnlPerContract).toBeCloseTo(25, 12); // 60 − 30 − 5
    expect(rollModel.netExpectedPnl).toBeCloseTo(50, 12);
    expect(rollModel.edgeMargin).toBeCloseTo(-0.1, 12); // ((1.00 − 0.80) × 100 − 30) ÷ 100
    expect(rollModel.grade).toBe("avoid");
    expect(scoreRollModel({ quantity: 2, model: null }, { bid: 0.95, ask: 1.05, model: fixtureCandidateModel() })).toBeNull();
  });

  it("re-pricing the commission at the leg's size moves every model dollar figure and return with it, never the margin", () => {
    const largeSizeEstimator = buildCommissionEstimator(Array.from({ length: 10 }, () => ({ side: "sell" as const, contracts: 6, commissionDollars: 6 })));
    const held = scoreOne(leg(), otmQuotes, modelContext);
    const replacement = buildRollCandidates([held], candidates(otmQuotes, modelContext))[0]!.replacement;
    const recosted = recostReplacementCommission(replacement, 6, largeSizeEstimator);
    const extra = 1.0 - 0.68;
    const before = replacement.model;
    const after = recosted.model;
    const annualized = extra / before.capitalAtRiskDollars / before.calendarYears;
    for (const key of ["expectedPnlDollars", "calibratedExpectedPnlDollars", "premiumAfterCostsDollars", "averageWinDollars", "averageLossDollars", "expectedShortfallDollars", "stressPnlDollars"] as const) expect(after[key]).toBeCloseTo(before[key] - extra, 10);
    for (const key of ["expectedAnnualizedReturn", "calibratedAnnualizedReturn", "premiumYield"] as const) expect(after[key]).toBeCloseTo(before[key] - annualized, 12);
    expect(after.edgeMargin).toBe(before.edgeMargin);
    expect(after.grade).toBe(before.grade);
  });
});
