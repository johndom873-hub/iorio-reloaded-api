import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { blackScholesVega, computeFrictionCost } from "./optionFriction.js";
import { buildSignalCandidates, gradeForNetEdge, gradeSignalCandidates, type SignalCandidate, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { assignmentRiskDeltaThreshold, buildRollCandidates, decayedFractionOfEntryCredit, heldLegContractKey, nearExpiryDaysThreshold, pickBestRoll, rollCandidateKey, scoreHeldLegs, type OpenShortLeg } from "./rollSignalCandidates.js";

// Formula 3j (approved 2026-09-24). Fixtures mirror signalsLiveScoring.test.ts: one
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

const forecast = { volatility: surfaceIvAt(100, expiry30) - 0.03, windowDays: 63 as const };
const otmQuotes: SignalQuote[] = [];
for (const expiry of [expiry30, expiry60]) {
  for (const strike of [80, 85, 90, 95]) otmQuotes.push(quoteAt(strike, "P", expiry));
  for (const strike of [105, 110, 115]) otmQuotes.push(quoteAt(strike, "C", expiry));
}

function candidates(quotes = otmQuotes): SignalCandidate[] {
  return gradeSignalCandidates(
    buildSignalCandidates({
      spotPrice: forward,
      riskFreeRate: rate,
      forecast,
      slices,
      quotes,
      earningsDatesIso: [],
      earningsCalendarResolved: true,
      macroEventDatesIso: [],
      snapshotDateIso,
      freeShares: 0,
      freeCash: 1_000_000,
      maxNetDelta: 1,
      minAnnualizedYieldPct: 0,
    }),
  );
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

function scoreOne(theLeg: OpenShortLeg, quotes: SignalQuote[] = otmQuotes) {
  return scoreHeldLegs([theLeg], { spotPrice: forward, riskFreeRate: rate, forecast, slices, quotes })[0]!;
}

describe("scoreHeldLegs", () => {
  it("scores an OTM held put exactly as a candidate at that contract would be (surface IV, delta, vega, friction), edge = surface IV − forecast", () => {
    const held = scoreOne(leg());
    expect(held.unscoredReason).toBeNull();
    const iv = surfaceIvAt(95, expiry30);
    const quote = otmQuotes.find((q) => q.expiry === expiry30 && q.strike === 95 && q.right === "P")!;
    const friction = computeFrictionCost({ bid: quote.bid, ask: quote.ask, forward, strike: 95, yearsToExpiry: years30, riskFreeRate: rate, impliedVolatility: iv })!;
    expect(held.surfaceImpliedVolatility).toBeCloseTo(iv, 12);
    expect(held.edge).toBeCloseTo(iv - forecast.volatility, 12);
    expect(held.frictionVolatility).toBeCloseTo(friction.frictionVolatility, 12);
    expect(held.delta).toBeCloseTo(blackScholesDelta(forward, 95, years30, rate, iv, false), 12);
    expect(held.vega).toBeCloseTo(blackScholesVega(forward, 95, years30, rate, iv), 12);
    expect(held.holdEdgeDollars).toBeCloseTo(held.edge! * held.vega! * 100, 9);
    expect(held.closeCostDollars).toBeCloseTo(held.frictionVolatility! * held.vega! * 100, 9);
    expect(held.dte).toBe(30);
    expect(held.dollarRisk).toBeCloseTo(95 * 100 - held.mid!, 9);
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
    const held = scoreHeldLegs([leg({ expiry: "2026-10-10", entryPrice: mid / decayedFractionOfEntryCredit + 0.01 })], { spotPrice: forward, riskFreeRate: rate, forecast, slices: [shortSlice], quotes: [quote] })[0]!;
    expect(held.dte).toBeLessThanOrEqual(nearExpiryDaysThreshold);
    expect(held.flags).toEqual(["near_expiry", "decayed"]);
    expect(held.quoteSource).toBe("day");
    expect(held.quotedAt).toBe("2026-09-24T15:00:00Z");
    const notDecayed = scoreHeldLegs([leg({ expiry: "2026-10-10", entryPrice: mid })], { spotPrice: forward, riskFreeRate: rate, forecast, slices: [shortSlice], quotes: [quote] })[0]!;
    expect(notDecayed.flags).toEqual(["near_expiry"]);
  });

  it("reports why a leg cannot be scored instead of inventing numbers: no slice, no two-sided quote, no forecast", () => {
    expect(scoreOne(leg({ expiry: "2027-06-18" })).unscoredReason).toBe("no_slice");
    const noQuote = scoreOne(leg({ strike: 97.5 }));
    expect(noQuote.unscoredReason).toBe("no_quote");
    expect(noQuote.dte).toBe(30);
    const oneSided = scoreOne(leg(), [...otmQuotes.filter((q) => !(q.strike === 95 && q.expiry === expiry30)), { expiry: expiry30, strike: 95, right: "P", bid: 1.2, ask: null }]);
    expect(oneSided.unscoredReason).toBe("no_quote");
    expect(scoreHeldLegs([leg()], { spotPrice: forward, riskFreeRate: rate, forecast: null, slices, quotes: otmQuotes })[0]!.unscoredReason).toBe("no_forecast");
    expect(heldLegContractKey(leg())).toBe(`${expiry30}|95|P`);
  });
});

describe("buildRollCandidates", () => {
  const held = scoreOne(leg());
  const all = candidates();
  const rolls = buildRollCandidates([held], all);

  it("applies Formula 3j exactly: netRollEdge = netEdge(B) − edge(A) − friction(A), dollars weighted by each leg's own vega", () => {
    expect(rolls.length).toBeGreaterThan(0);
    for (const roll of rolls) {
      const B = roll.replacement;
      expect(roll.netRollEdge).toBeCloseTo(B.netEdge - held.edge! - held.frictionVolatility!, 12);
      expect(roll.netRollEdgeDollarsPerContract).toBeCloseTo(B.edgeDollars - (held.edge! + held.frictionVolatility!) * held.vega! * 100, 9);
      expect(roll.netRollEdgeDollars).toBeCloseTo(roll.netRollEdgeDollarsPerContract * 2, 9);
      // Equivalent form: netEdge(B) − netEdge(A) − 2·friction(A), with netEdge(A) = edge(A) − friction(A).
      expect(roll.netRollEdge).toBeCloseTo(B.netEdge - (held.edge! - held.frictionVolatility!) - 2 * held.frictionVolatility!, 12);
      expect(roll.grade).toBe(gradeForNetEdge(roll.netRollEdge));
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

  it("sorts by net roll Edge $ then vol points, and pickBestRoll agrees; keys are unique per (leg, replacement)", () => {
    for (let index = 1; index < rolls.length; index += 1) {
      const previous = rolls[index - 1]!;
      const current = rolls[index]!;
      expect(previous.netRollEdgeDollars > current.netRollEdgeDollars || (previous.netRollEdgeDollars === current.netRollEdgeDollars && previous.netRollEdge >= current.netRollEdge)).toBe(true);
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
    expect(heldCall.dollarRisk).toBeCloseTo(forward * 100 - heldCall.mid!, 9);
    const callRolls = buildRollCandidates([heldCall], all);
    expect(callRolls.every((roll) => roll.replacement.strategyKey === "covered_call")).toBe(true);
  });
});
