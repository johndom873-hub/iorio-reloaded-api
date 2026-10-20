import { describe, expect, it } from "vitest";
import { valueContract } from "../../lib/contractValuation.js";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { blackScholesDelta, blackScholesPriceOnForward, forwardAtSpot, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { fixtureModelForecast } from "../../lib/testSupport/valuationModelFixtures.js";
import { volatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import { defaultBacktestBaselineSettings, type BacktestBaselineSettings, type EffectiveBacktestSettings } from "../backtestTypes.js";
import { validateBaselineSettings } from "../jobs/backtestSessionRequest.js";
import { baselineContractsForCash, runBaselineLook, selectBaselineCandidates, type BaselineCandidateInput, type BaselineModelInput } from "./backtestBaselineLook.js";
import { makeBaselineSelector, noteBaselineForwardAnchors, type BaselineCommissions, type BaselineForwardAnchor } from "./baselineSaleSteps.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";

const flatCommissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { openCashSecuredPut, settleExpiry } from "./ledger/ledgerEvents.js";
import { ledgerFreeShares, ledgerHeldSharesAverageCost } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, legsOfPosition, positionsOfSymbol, type SimulatedLedger } from "./ledger/simulatedLedger.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";

const todayIso = "2026-03-02";
const stockPrice = 100;
const riskFreeRate = 0.04;
const volatility = 0.5;

/** The look's trading calendar: today closes at 16:00. */
const oneDayCalendar = { sessionsBetween: () => [{ dateIso: todayIso, closeMinutesEt: 16 * 60 }] };

/** A quote priced by Black-76 at 50% volatility, with a 4% spread around that mid unless given. */
function quote(expiry: string, strike: number, right: "C" | "P", spreadFraction = 0.04): SymbolFileQuote {
  const years = yearsBetweenIsoDates(todayIso, expiry);
  const mid = blackScholesPriceOnForward(stockPrice * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, volatility, right === "C");
  const halfSpread = (mid * spreadFraction) / 2;
  return { expiry, strike, right, bid: Math.round((mid - halfSpread) * 10_000) / 10_000, ask: Math.round((mid + halfSpread) * 10_000) / 10_000, bidSize: 10, askSize: 10 };
}

function input(quotes: SymbolFileQuote[], overrides: Partial<BaselineCandidateInput> = {}): BaselineCandidateInput {
  // The look is the day's first: each expiry's forward is anchored on its own quotes.
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose: overrides.yearsToTodaysClose ?? 6 / 8760, stockPrice: overrides.stockPrice ?? stockPrice, riskFreeRate: overrides.riskFreeRate ?? riskFreeRate });
  return {
    quotes,
    forwardAnchors,
    commissions: flatCommissions,
    right: "P",
    todayIso,
    yearsToTodaysClose: 6 / 8760,
    stockPrice,
    riskFreeRate,
    previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])),
    settings: { minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15 },
    spreadShareCharged: 0.5,
    isHeld: () => false,
    ...overrides,
  };
}

describe("selectBaselineCandidates", () => {
  it("leaves out spreads wider than maxSpreadPctOfMid of the mid", () => {
    // A 30% spread: out at the default 15%, in at 50%.
    const quotes = [quote("2026-03-06", 95, "P", 0.3), quote("2026-03-06", 100, "P")];
    const atDefault = selectBaselineCandidates(input(quotes));
    expect(atDefault.candidates.map((candidate) => candidate.strike)).toEqual([100]);
    expect(atDefault.rejections.spreadTooWide).toBe(1);
    const wider = selectBaselineCandidates(input(quotes, { settings: { minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 50 } }));
    expect(wider.candidates.map((candidate) => candidate.strike).sort((a, b) => a - b)).toEqual([95, 100]);
    expect(wider.rejections.spreadTooWide).toBe(0);
  });

  it("ranks by premium yield on the time value and reads each quote's own delta", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-06", 100, "P"), quote("2026-03-27", 95, "P"), quote("2026-03-06", 105, "C")];
    const { candidates } = selectBaselineCandidates(input(quotes));
    // The 25-day $95 put out-earns the 4-day one a year at these prices (45% vs 41%); the call is the other right.
    expect(candidates.map((candidate) => [candidate.expiry, candidate.strike])).toEqual([
      ["2026-03-06", 100],
      ["2026-03-27", 95],
      ["2026-03-06", 95],
    ]);
    for (const candidate of candidates) {
      const years = yearsBetweenIsoDates(todayIso, candidate.expiry);
      expect(candidate.impliedVolatility).toBeCloseTo(volatility, 2);
      expect(candidate.delta).toBeCloseTo(blackScholesDelta(stockPrice * Math.exp(riskFreeRate * years), candidate.strike, years, riskFreeRate, volatility, false), 2);
      expect(candidate.volumeCap).toBe(200);
    }
    // At the money: no intrinsic value, so the yield is the fill after its commission on the capital, annualized.
    const atTheMoney = candidates[0]!;
    const years = yearsBetweenIsoDates(todayIso, atTheMoney.expiry);
    expect(atTheMoney.premiumYield).toBeCloseTo((atTheMoney.fillPrice * 100 - 0.68) / ((100 - atTheMoney.fillPrice) * 100) / years, 10);
  });

  it("prices an option expiring on the look's day on the hours left to the close, and counts its yield over one day", () => {
    // A $99 Put expiring today at the 10:00 look: 6 hours to a 16:00 close.
    const years = 6 / 8760;
    const mid = blackScholesPriceOnForward(stockPrice * Math.exp(riskFreeRate * years), 99, years, riskFreeRate, volatility, false);
    const sameDay: SymbolFileQuote = { expiry: todayIso, strike: 99, right: "P", bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: 10, askSize: 10 };
    const fromZeroDays = { minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 0, maxDte: 45, maxSpreadPctOfMid: 15 };
    expect(selectBaselineCandidates(input([sameDay])).rejections.outsideExpiryRange).toBe(1);
    const { candidates } = selectBaselineCandidates(input([sameDay], { settings: fromZeroDays }));
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.impliedVolatility).toBeCloseTo(volatility, 2);
    expect(candidate.delta).toBeCloseTo(blackScholesDelta(stockPrice * Math.exp(riskFreeRate * years), 99, years, riskFreeRate, volatility, false), 2);
    expect(candidate.premiumYield).toBeCloseTo(((candidate.fillPrice * 100 - 0.68) / ((99 - candidate.fillPrice) * 100)) * 365, 10);
    // At the close nothing is left to price: no implied volatility, so it is refused.
    expect(selectBaselineCandidates(input([sameDay], { settings: fromZeroDays, yearsToTodaysClose: 0 })).rejections.noImpliedVolatility).toBe(1);
  });

  it("anchors each expiry's forward at the day's first look and moves it with the stock at later looks (Pluto's rule)", () => {
    const quotes = [90, 95, 100, 105, 110].flatMap((strike) => [quote("2026-03-20", strike, "C"), quote("2026-03-20", strike, "P")]);
    const anchors = new Map<string, BaselineForwardAnchor>();
    noteBaselineForwardAnchors(anchors, { quotes, todayIso, yearsToTodaysClose: 6 / 8760, stockPrice, riskFreeRate });
    const atTen = anchors.get("2026-03-20")!;
    expect(atTen.spotPrice).toBe(stockPrice);
    // A later look with the stock at 103 keeps the 10:00 anchor; its forward is the anchor × 103 ÷ 100.
    noteBaselineForwardAnchors(anchors, { quotes, todayIso, yearsToTodaysClose: 3 / 8760, stockPrice: 103, riskFreeRate });
    expect(anchors.get("2026-03-20")).toEqual(atTen);
    const { candidates } = selectBaselineCandidates({ ...input(quotes, { stockPrice: 103 }), forwardAnchors: anchors });
    const forward = forwardAtSpot(atTen.forward, atTen.spotPrice, 103);
    expect(forward).toBeCloseTo(atTen.forward * 1.03, 12);
    for (const candidate of candidates) {
      const years = yearsBetweenIsoDates(todayIso, candidate.expiry);
      expect(candidate.delta).toBeCloseTo(blackScholesDelta(forward, candidate.strike, years, riskFreeRate, candidate.impliedVolatility, false), 12);
    }
  });

  it("holds every Call, the Covered Call entry's included, to the Calls' own range, and the Puts to the main one", () => {
    const quotes = Array.from({ length: 41 }, (_, index) => 80 + index).flatMap((strike) => [quote("2026-03-20", strike, "C"), quote("2026-03-20", strike, "P")]);
    const { forwardAnchors } = input(quotes);
    const baseline = { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.05, maxAbsDelta: 0.4, callDeltaRange: "own_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.3, maxSpreadPctOfMid: 50 } as BacktestBaselineSettings;
    const select = makeBaselineSelector({ quotes, forwardAnchors, commissions: flatCommissions, todayIso, yearsToTodaysClose: 6 / 8760, stockPrice, riskFreeRate, previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), baseline, spreadShareCharged: 0, isHeld: () => false, earningsDatesIso: undefined, model: null });
    const maxAbsDelta = (candidates: { delta: number }[]) => Math.max(...candidates.map((candidate) => Math.abs(candidate.delta)));
    // The entry (forEntry) and the held shares' Calls both stop at 0.30; the Puts reach 0.40.
    expect(maxAbsDelta(select("C", null, true).candidates)).toBeLessThanOrEqual(0.3);
    expect(maxAbsDelta(select("C", null, false).candidates)).toBeLessThanOrEqual(0.3);
    const puts = select("P", null, true).candidates;
    expect(maxAbsDelta(puts)).toBeGreaterThan(0.3);
    expect(maxAbsDelta(puts)).toBeLessThanOrEqual(0.4);
  });

  it("sells the ladder's Puts at any |delta| with ladderPutDeltaRange none, every other Put and Call staying on its range", () => {
    const quotes = Array.from({ length: 41 }, (_, index) => 80 + index).flatMap((strike) => [quote("2026-03-20", strike, "C"), quote("2026-03-20", strike, "P")]);
    const { forwardAnchors } = input(quotes);
    const selectorFor = (ladderPutDeltaRange: BacktestBaselineSettings["ladderPutDeltaRange"]) =>
      makeBaselineSelector({ quotes, forwardAnchors, commissions: flatCommissions, todayIso, yearsToTodaysClose: 6 / 8760, stockPrice, riskFreeRate, previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.2, maxAbsDelta: 0.3, maxSpreadPctOfMid: 50, ladderPutDeltaRange } as BacktestBaselineSettings, spreadShareCharged: 0, isHeld: () => false, earningsDatesIso: undefined, model: null });
    const absDeltas = (candidates: { delta: number }[]) => candidates.map((candidate) => Math.abs(candidate.delta));
    const insideRange = (values: number[]) => values.every((value) => value >= 0.2 - 1e-12 && value <= 0.3 + 1e-12);
    // On the range: the ladder's Puts (under a $99 cap) stay within 0.20–0.30.
    const onRange = absDeltas(selectorFor("delta_range")("P", null, true, 99, true, { ladderPut: true }).candidates);
    expect(onRange.length).toBeGreaterThan(0);
    expect(insideRange(onRange)).toBe(true);
    // None: the same cap reaches Puts below 0.20 and above 0.30, and more of them.
    const none = selectorFor("none");
    const anyDelta = absDeltas(none("P", null, true, 99, true, { ladderPut: true }).candidates);
    expect(anyDelta.length).toBeGreaterThan(onRange.length);
    expect(Math.min(...anyDelta)).toBeLessThan(0.2);
    expect(Math.max(...anyDelta)).toBeGreaterThan(0.3);
    // Not the ladder's: the other Puts (the DTE-budget put, a put entry) and every Call keep the range.
    expect(insideRange(absDeltas(none("P", null, true, 99, true).candidates))).toBe(true);
    expect(insideRange(absDeltas(none("C", null, true).candidates))).toBe(true);
  });

  it("counts only the time value of an in-the-money contract", () => {
    // $1 in the money, |delta| 0.56: inside the range.
    const inTheMoney = quote("2026-03-06", 101, "P");
    const { candidates } = selectBaselineCandidates(input([inTheMoney]));
    expect(candidates[0]!.timeValue).toBeCloseTo(candidates[0]!.fillPrice - 1, 10);
  });

  it("leaves out what the delta and expiry ranges, the realism limits and the held contracts exclude", () => {
    const quotes = [
      quote("2026-03-27", 75, "P"), // bid $0.051 but |delta| below 0.05
      quote("2026-04-30", 95, "P"), // 59 days
      quote("2026-03-06", 99, "P", 0.4), // spread 40% of the mid
      { ...quote("2026-03-06", 98, "P"), bid: 0.04 }, // bid under $0.05
      quote("2026-03-06", 97, "P"), // no volume
      quote("2026-03-06", 96, "P"), // held
      quote("2026-03-06", 100, "P"), // the only one left
    ];
    const volume = new Map(quotes.filter((entry) => entry.strike !== 97).map((entry) => [contractKey(entry), 50]));
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { previousSessionVolumeByContract: volume, isHeld: (contract) => contract.strike === 96 }));
    expect(candidates.map((candidate) => candidate.strike)).toEqual([100]);
    expect(candidates[0]!.volumeCap).toBe(10);
    expect(rejections).toEqual({ outsideExpiryRange: 1, noUsableQuote: 1, spreadTooWide: 1, tooLittleVolume: 1, noImpliedVolatility: 0, outsideDeltaRange: 1, noTimeValue: 0, alreadyHeld: 1, belowCost: 0, aboveCeiling: 0, belowMinimumYield: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0 });
  });

  it("leaves out expiries that span a known earnings date when earnings are given", () => {
    const quotes = [quote("2026-03-06", 100, "P"), quote("2026-03-27", 100, "P")];
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-03-10"] }));
    expect(candidates.map((candidate) => candidate.expiry)).toEqual(["2026-03-06"]);
    expect(rejections.spansEarnings).toBe(1);
    // A report on the expiry day itself is spanned; one already past is not.
    expect(selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-03-06"] })).candidates.map((candidate) => candidate.expiry)).toEqual([]);
    expect(selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-02-27"] })).candidates).toHaveLength(2);
  });

  it("keeps calls at or above a cost floor when one is given", () => {
    const quotes = [quote("2026-03-06", 100, "C"), quote("2026-03-06", 102, "C"), quote("2026-03-06", 104, "C")];
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { right: "C", minimumStrike: 101.5 }));
    expect(candidates.map((candidate) => candidate.strike)).toEqual([102, 104]);
    expect(rejections.belowCost).toBe(1);
    expect(selectBaselineCandidates(input(quotes, { right: "C", minimumStrike: Number.POSITIVE_INFINITY })).candidates).toEqual([]);
  });

  it("ranks by time value or by the premium in dollars when asked, and can take the nearest expiry first", () => {
    // $95 in the money (fill 5.42, of which 0.42 time value), $100 at the money (2.09), $105 out of the money (0.51); and
    // the $100 three weeks later (5.29).
    const quotes = [quote("2026-03-06", 95, "C"), quote("2026-03-06", 100, "C"), quote("2026-03-06", 105, "C"), quote("2026-03-27", 100, "C")];
    const settings = { minAbsDelta: 0.01, maxAbsDelta: 1, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15 };
    const order = (overrides: Partial<BaselineCandidateInput>) => selectBaselineCandidates(input(quotes, { right: "C", settings, ...overrides })).candidates.map((candidate) => `${candidate.expiry} ${candidate.strike}`);
    expect(order({ ranking: "premium_dollars" })).toEqual(["2026-03-06 95", "2026-03-27 100", "2026-03-06 100", "2026-03-06 105"]);
    expect(order({ ranking: "time_value" })).toEqual(["2026-03-27 100", "2026-03-06 100", "2026-03-06 105", "2026-03-06 95"]);
    expect(order({ ranking: "time_value", nearestExpiryFirst: true })).toEqual(["2026-03-06 100", "2026-03-06 105", "2026-03-06 95", "2026-03-27 100"]);
    expect(order({ ranking: "premium_dollars", nearestExpiryFirst: true })).toEqual(["2026-03-06 95", "2026-03-06 100", "2026-03-06 105", "2026-03-27 100"]);
    // Deeper in the money the fill falls below the intrinsic value: no time value to earn, so it is left out.
    expect(selectBaselineCandidates(input([quote("2026-03-06", 90, "C")], { right: "C", settings })).rejections.noTimeValue).toBe(1);
  });

  it("ranks by the premium per day to expiry when asked: $1.00 over 3 days beats $2.00 over 10", () => {
    const settings = { minAbsDelta: 0.01, maxAbsDelta: 1, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15 };
    const three = { ...quote("2026-03-05", 101, "C"), bid: 0.99, ask: 1.01 };
    const ten = { ...quote("2026-03-12", 101, "C"), bid: 1.98, ask: 2.02 };
    const candidates = selectBaselineCandidates(input([ten, three], { right: "C", settings, ranking: "premium_per_day" })).candidates;
    expect(candidates.map((candidate) => [candidate.dte, candidate.strike])).toEqual([[3, 101], [10, 101]]);
    expect(candidates[0]!.fillPrice / 3).toBeGreaterThan(candidates[1]!.fillPrice / 10);
  });

  it("refuses everything when the previous session's volume is unknown", () => {
    expect(selectBaselineCandidates(input([quote("2026-03-06", 100, "P")], { previousSessionVolumeByContract: null })).candidates).toEqual([]);
  });

  it("keeps calls above a minimum premium yield when one is given", () => {
    const quotes = [100, 105, 110, 115].map((strike) => quote("2026-03-27", strike, "C"));
    const settings = { minAbsDelta: 0.01, maxAbsDelta: 1, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15 };
    const all = selectBaselineCandidates(input(quotes, { right: "C", settings })).candidates;
    const threshold = all.map((candidate) => candidate.premiumYield).sort((a, b) => a - b)[1]!;
    const above = selectBaselineCandidates(input(quotes, { right: "C", settings, minimumPremiumYield: threshold }));
    expect(above.candidates).toHaveLength(2);
    expect(above.candidates.every((candidate) => candidate.premiumYield > threshold)).toBe(true);
    expect(above.rejections.belowMinimumYield).toBe(2);
  });

  it("keeps puts at or below a strike ceiling when one is given", () => {
    const quotes = [85, 90, 95, 100].map((strike) => quote("2026-03-27", strike, "P"));
    const settings = { minAbsDelta: 0.01, maxAbsDelta: 1, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15 };
    const capped = selectBaselineCandidates(input(quotes, { settings, maximumStrike: 92 }));
    expect(capped.candidates.map((candidate) => candidate.strike).sort((a, b) => a - b)).toEqual([85, 90]);
    expect(capped.rejections.aboveCeiling).toBe(2);
    expect(selectBaselineCandidates(input(quotes, { settings, maximumStrike: null })).candidates).toHaveLength(4);
  });
});

describe("runBaselineLook with the average-cost floor", () => {
  // 100 WHL shares assigned at $150 the week before; today the stock is at $100 and calls run out to $150 over 25 days.
  const expiry = "2026-03-27";
  const quotes = [100, 105, 110, 115, 120, 130, 150].map((strike) => quote(expiry, strike, "C")).concat([quote(expiry, 100, "P")]);
  function assignedLedger(): SimulatedLedger {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-02-27", strike: 150, contracts: 1, fillPrice: 1, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 140 });
    return ledger;
  }
  function look(ledger: SimulatedLedger, baseline: Partial<BacktestBaselineSettings>) {
    let actionNumber = 0;
    const lookSymbol = {
      profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      splitFactorToday: 1,
      optionContractsRepresentable: true,
    } as unknown as BacktestLookSymbol;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase", ...baseline } } as unknown as EffectiveBacktestSettings;
    const heldShareLegs = positionsOfSymbol(ledger, "WHL").flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock" && leg.exitAt === null);
    const context = { todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(heldShareLegs.map((leg) => [leg.id, stockPrice])), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext;
    return runBaselineLook(context);
  }

  it("leaves held shares uncovered when no call at or above their average has a bid", async () => {
    const plain = await look(assignedLedger(), { entryWhenSharesUncovered: "wait" });
    expect(plain.actions).toEqual([]);
    expect(plain.summary).toMatch(/no call for 100 free shares/);
  });

  it("buys new lots while held shares wait, their call at or above the average after the purchase", async () => {
    const ledger = assignedLedger();
    const result = await look(ledger, { entryWhenSharesUncovered: "buy" });
    expect(result.actions.length).toBeGreaterThan(0);
    let sharesHeld = 100;
    let averageCost = 150;
    for (const action of result.actions) {
      const bought = action.quantity! * 100;
      const averageAfter = (sharesHeld * averageCost + bought * 100) / (sharesHeld + bought);
      expect(action.candidateScores).toMatchObject({ averageCostBefore: averageCost, sharesHeldBefore: sharesHeld });
      expect(action.candidateScores!.averageCostAfter as number).toBeCloseTo(averageAfter, 9);
      expect(action.candidateScores!.costFloor as number).toBeCloseTo(averageAfter, 9);
      expect(action.contract!.strike).toBeGreaterThanOrEqual(averageAfter);
      sharesHeld += bought;
      averageCost = averageAfter;
    }
    // The assigned shares are still the ones uncovered; the new lots hold their own calls.
    expect(ledgerFreeShares(ledger, "WHL")).toBe(100);
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeCloseTo(averageCost, 9);
    // Waiting instead: nothing is bought while the assigned lot has no call.
    expect((await look(assignedLedger(), { entryWhenSharesUncovered: "wait" })).actions).toEqual([]);
  });

  it("falls back to the break-even only when no call at or above the average price has a usable bid", async () => {
    // 100 shares assigned at $112 for a $4.00 put: average $112, break-even (11,200 − 400 + 0.68) ÷ 100 = $108.0068. No call
    // at or above $112 has a bid; the $110 call is above the break-even.
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-02-27", strike: 112, contracts: 1, fillPrice: 4, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 100 });
    const fallbackQuotes = [100, 105, 110, 115, 120].map((strike) => (strike >= 112 ? { ...quote(expiry, strike, "C"), bid: 0 } : quote(expiry, strike, "C"))).concat([quote(expiry, 100, "P")]);
    let actionNumber = 0;
    const lookSymbol = {
      profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes: fallbackQuotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(fallbackQuotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      splitFactorToday: 1,
      optionContractsRepresentable: true,
    } as unknown as BacktestLookSymbol;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost_else_break_even", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "wait", ranking: "premium_per_day" } } as unknown as EffectiveBacktestSettings;
    const result = await runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    // The free cash then goes into a Covered Call entry; the call on the held shares is the one before it.
    const heldShareCalls = result.actions.filter((action) => action.chosenBecause.includes("free shares"));
    expect(heldShareCalls).toHaveLength(1);
    expect(heldShareCalls[0]!.contract!.strike).toBe(110);
    expect(heldShareCalls[0]!.chosenBecause).toMatch(/break-even/);
    expect(heldShareCalls[0]!.candidateScores!.costFloor as number).toBeCloseTo(108.0068, 4);
    // With a call at or above the average quoted, that one is sold and the break-even is not reached.
    const withAverageCall = fallbackQuotes.map((entry) => (entry.strike === 115 && entry.right === "C" ? quote(expiry, 115, "C") : entry));
    const ledgerAgain = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
    const putAgain = openCashSecuredPut(ledgerAgain, { symbol: "WHL", expiryDate: "2026-02-27", strike: 112, contracts: 1, fillPrice: 4, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
    settleExpiry(ledgerAgain, { legId: putAgain.legId, expiryClose: 100 });
    const again = await runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [{ ...lookSymbol, market: { ...lookSymbol.market, quotes: withAverageCall } } as unknown as BacktestLookSymbol], settings, ledger: ledgerAgain, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    const heldShareCallsAgain = again.actions.filter((action) => action.chosenBecause.includes("free shares"));
    expect(heldShareCallsAgain.map((action) => action.contract!.strike)).toEqual([115]);
    expect(heldShareCallsAgain[0]!.chosenBecause).toMatch(/at or above the average/);
  });

  it("buys a new Covered Call's shares at the 10:00 price itself", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    let actionNumber = 0;
    const lookSymbol = {
      profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      splitFactorToday: 1,
      optionContractsRepresentable: true,
    } as unknown as BacktestLookSymbol;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase" } } as unknown as EffectiveBacktestSettings;
    await runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBe(100);
  });

  it("holds Covered Call entries to the shares' cap at market value", async () => {
    const capQuotes = [100, 105, 110].map((strike) => quote(expiry, strike, "C")).concat([90, 95, 100].map((strike) => quote(expiry, strike, "P")));
    const run = async (ledger: SimulatedLedger, baseline: Partial<BacktestBaselineSettings>) => {
      let actionNumber = 0;
      const lookSymbol = {
        profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
        market: { todayIso, quotes: capQuotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(capQuotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
        splitFactorToday: 1,
        optionContractsRepresentable: true,
      } as unknown as BacktestLookSymbol;
      const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost_else_break_even", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "buy", dayValueOptions: "excluded", maxSharesPctOfAccount: 70, ...baseline } } as unknown as EffectiveBacktestSettings;
      return runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    };
    // $100,000 and no shares: 70% buys 700 shares at $100; the cap leaves no room for an eighth lot.
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    const capped = await run(ledger, {});
    expect(capped.actions.every((action) => action.kind === "open_covered_call")).toBe(true);
    expect(capped.actions.reduce((sum, action) => sum + action.quantity!, 0)).toBe(7);
  });

  it("holds only new Covered Calls to the yield threshold when it applies to them alone", async () => {
    const callQuotes = [100, 105, 110].map((strike) => quote(expiry, strike, "C"));
    const run = async (ledger: SimulatedLedger, minCallYieldAppliesTo: BacktestBaselineSettings["minCallYieldAppliesTo"]) => {
      let actionNumber = 0;
      const lookSymbol = {
        profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
        market: { todayIso, quotes: callQuotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(callQuotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
        splitFactorToday: 1,
        optionContractsRepresentable: true,
      } as unknown as BacktestLookSymbol;
      const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", callStrike: "delta_range", entryWhenSharesUncovered: "buy", dayValueOptions: "excluded", maxSharesPctOfAccount: 10, minCallYieldPct: 1000, minCallYieldAppliesTo } } as unknown as EffectiveBacktestSettings;
      return runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    };
    // 100 shares from an assigned put, the 10% cap full: only the held shares' call is on offer.
    const assignedShares = () => {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
      const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-02-27", strike: 95, contracts: 1, fillPrice: 1, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
      settleExpiry(ledger, { legId: put.legId, expiryClose: 90 });
      return ledger;
    };
    const heldAtAnyYield = await run(assignedShares(), "new_covered_calls");
    expect(heldAtAnyYield.actions.map((action) => [action.kind, action.quantity])).toEqual([["open_covered_call", 1]]);
    expect(heldAtAnyYield.actions[0]!.chosenBecause).toMatch(/free shares/);
    const heldToTheYield = await run(assignedShares(), "every_call");
    expect(heldToTheYield.actions).toEqual([]);
    expect(heldToTheYield.summary).toMatch(/no call for 100 free shares \(.*yield/);
    // No shares: the new Covered Call is held to the threshold either way, so nothing is bought and the cash waits.
    const flat = await run(createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30)), "new_covered_calls");
    expect(flat.actions).toEqual([]);
    expect(flat.summary).toMatch(/no new Covered Call \(.*yield/);
  });
});

describe("runBaselineLook in a session of per-ticker pots", () => {
  const expiry = "2026-03-27";
  const quotes = [100, 105, 110, 115].map((strike) => quote(expiry, strike, "C")).concat([90, 95].map((strike) => quote(expiry, strike, "P")));
  const lookSymbolOf = (symbol: string) =>
    ({
      profile: { symbol, calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      adjustedDailyClosesBeforeToday: [],
      splitFactorToday: 1,
      optionContractsRepresentable: true,
    }) as unknown as BacktestLookSymbol;
  const baseline = { ...defaultBacktestBaselineSettings, entry: "covered_call", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_break_even", entryWhenSharesUncovered: "buy", dayValueOptions: "excluded", putsWhenNoCall: "reserve_ladder", ladderSharesPct: 50 } as BacktestBaselineSettings;
  const lookOfTwo = (tickerSetupBySymbol?: BacktestLookContext["tickerSetupBySymbol"]) => {
    let actionNumber = 0;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline } as unknown as EffectiveBacktestSettings;
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    return runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbolOf("AAA"), lookSymbolOf("BBB")], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}`, ...(tickerSetupBySymbol ? { tickerSetupBySymbol } : {}) } as unknown as BacktestLookContext);
  };
  const contractsBySymbol = async (tickerSetupBySymbol?: BacktestLookContext["tickerSetupBySymbol"]) => {
    const result = await lookOfTwo(tickerSetupBySymbol);
    const contracts: Record<string, number> = {};
    for (const action of result.actions) if (action.kind === "open_covered_call") contracts[action.symbol] = (contracts[action.symbol] ?? 0) + action.quantity!;
    return contracts;
  };

  it("gives each ticker its own share level and its weight of the account as the ladder's base", async () => {
    // One account of $100,000, shares at $100. Shared: each ticker's budget is 50% of the whole account, $50,000 = 5 lots
    // each (the calls' premiums cover the rest). Pots: AAA 0.3 × 100,000 × 40% = $12,000 = 1 lot; BBB 0.7 × 100,000 ×
    // 60% = $42,000 = 4 lots.
    expect(await contractsBySymbol()).toEqual({ AAA: 5, BBB: 5 });
    const pots = new Map([
      ["AAA", { baseline: { ...baseline, ladderSharesPct: 40 }, weight: 0.3 }],
      ["BBB", { baseline: { ...baseline, ladderSharesPct: 60 }, weight: 0.7 }],
    ]);
    expect(await contractsBySymbol(pots)).toEqual({ AAA: 1, BBB: 4 });
  });

  it("records what each order wanted, and an order the cash cut, without changing what is sold", async () => {
    // Budgets of 0.7 × $100,000 × 90% = $63,000 each, 6 lots: AAA takes its 6 first; BBB's cash then pays for fewer.
    const tight = new Map(["AAA", "BBB"].map((symbol) => [symbol, { baseline: { ...baseline, ladderSharesPct: 90 }, weight: 0.7 }]));
    const result = await lookOfTwo(tight);
    const sold = (symbol: string) => result.actions.filter((action) => action.symbol === symbol).reduce((sum, action) => sum + action.quantity!, 0);
    expect(sold("AAA")).toBe(6);
    expect(sold("BBB")).toBeLessThan(6);
    const firstSale = result.actions[0]!;
    expect(firstSale.candidateScores).toMatchObject({ wantedContracts: 6, rank: 1, bestCandidateStrike: firstSale.contract!.strike, bestCandidateVolumeCap: 200 });
    expect(result.shortfalls).toEqual([
      expect.objectContaining({ symbol: "BBB", step: "entry", right: "C", reason: "cash", wantedContracts: 6, filledContracts: sold("BBB"), unsoldContracts: 6 - sold("BBB"), lookCount: 1, tradingDate: todayIso }),
    ]);
  });
});

describe("runBaselineLook with a Cash-Secured Put entry and the ladder", () => {
  // $100,000, the ladder's shares at most 50%: Puts at $90 and $95, Calls from $100, the stock at $100.
  const expiry = "2026-03-27";
  const quotes = [100, 105, 110].map((strike) => quote(expiry, strike, "C")).concat([90, 95].map((strike) => quote(expiry, strike, "P")));
  const lookSymbol = {
    profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
    market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
    adjustedDailyClosesBeforeToday: [],
    splitFactorToday: 1,
    optionContractsRepresentable: true,
  } as unknown as BacktestLookSymbol;
  const baseline = { ...defaultBacktestBaselineSettings, entry: "put", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_break_even", dayValueOptions: "excluded", putsWhenNoCall: "reserve_ladder", ladderSharesPct: 50, ladderShock: "fixed", ladderShockPct: 10, ladderPutDeltaRange: "none" } as BacktestBaselineSettings;
  const look = (ledger: SimulatedLedger, overrides: Partial<BacktestBaselineSettings> = {}, symbol: BacktestLookSymbol = lookSymbol) => {
    let actionNumber = 0;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...baseline, ...overrides } } as unknown as EffectiveBacktestSettings;
    const heldShareLegs = positionsOfSymbol(ledger, "WHL").flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock" && leg.exitAt === null);
    return runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [symbol], settings, ledger, priceByLegId: new Map(heldShareLegs.map((leg) => [leg.id, stockPrice])), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
  };
  /** 500 shares assigned at $100 the week before: the shares' budget ($50,000) used. */
  function assignedLedger(): SimulatedLedger {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-02-27", strike: 100, contracts: 5, fillPrice: 1, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 99 });
    return ledger;
  }

  it("sells entry Puts on the shares' budget alone with no shares held, and no ladder Put before them", async () => {
    const result = await look(createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30)));
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.kind === "open_cash_secured_put" && !("ladderCap" in (action.candidateScores ?? {})))).toBe(true);
    // The best Put takes floor($50,000 ÷ (strike × 100)) contracts; with the next in order, the collateral stays within $50,000.
    const first = result.actions[0]!;
    expect(first.quantity).toBe(Math.floor(50_000 / (first.contract!.strike! * 100)));
    const collateral = result.actions.reduce((sum, action) => sum + action.contract!.strike! * 100 * action.quantity!, 0);
    expect(collateral).toBeLessThanOrEqual(50_000);
    expect(collateral).toBeGreaterThan(50_000 - 9_500);
  });

  it("holds the entry Puts to the minimum premium yield (the cash waits), never the ladder's", async () => {
    const waiting = await look(createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30)), { minCallYieldPct: 1000, minCallYieldAppliesTo: "new_covered_calls" });
    expect(waiting.actions).toEqual([]);
    expect(waiting.summary).toMatch(/no put \(.*yield/);
    // Recorded for the Wheel cycles: what each check left out, with its rule as the look applied it.
    expect(waiting.noCandidateNotes).toEqual([expect.objectContaining({ tradingDate: todayIso, symbol: "WHL", order: "entry", right: "P", rejections: expect.objectContaining({ belowMinimumYield: expect.any(Number) }) })]);
    const [note] = waiting.noCandidateNotes!;
    expect(note!.rejections.belowMinimumYield).toBeGreaterThan(0);
    expect(note!.rules?.belowMinimumYield).toBe("premium yield not above 1000% a year");
    // With shares held and every Call held to 1,000% (none qualifies), the ladder still sells its rung at any yield.
    const ladder = await look(assignedLedger(), { minCallYieldPct: 1000, minCallYieldAppliesTo: "every_call" });
    expect(ladder.actions.length).toBeGreaterThan(0);
    expect(ladder.actions.every((action) => action.kind === "open_cash_secured_put" && "ladderCap" in (action.candidateScores ?? {}))).toBe(true);
  });

  it("skips the entry while a drop-risk filter blocks it; Calls on held shares and the ladder's Puts carry on", async () => {
    // 199 closes at 100 and one at 121 before today: extension z 0.5475 (entryDropRiskFilters.test.ts).
    const stretched = { ...lookSymbol, adjustedDailyClosesBeforeToday: [...Array(199).fill(100), 121].map((close, index) => ({ date: addCalendarDays("2025-01-01", index), close })) } as unknown as BacktestLookSymbol;
    const flatLedger = () => createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    const blocked = await look(flatLedger(), { entryExtensionFilter: "on", entryMaxExtensionZ: 0.5 }, stretched);
    expect(blocked.actions).toEqual([]);
    expect(blocked.summary).toContain("WHL: no new entry (extension z 0.55 ≥ 0.5)");
    // Recorded for the Wheel cycles' gaps, with the limit that blocked it.
    expect(blocked.noSaleNotes).toEqual([{ tradingDate: todayIso, symbol: "WHL", reason: "entry_filter", entryFilterLimits: { extensionZ: 0.5, ivRank: null } }]);
    const allowed = await look(flatLedger(), { entryExtensionFilter: "on", entryMaxExtensionZ: 0.6 }, stretched);
    expect(allowed.actions.length).toBeGreaterThan(0);
    expect(allowed.noSaleNotes).toEqual([]);
    // Off, the limit is not read.
    expect((await look(flatLedger(), { entryExtensionFilter: "off", entryMaxExtensionZ: 0.5 }, stretched)).actions.length).toBe(allowed.actions.length);
    // Shares held while blocked: the Calls on them are sold, and with no Call above a 1,000% yield the ladder sells its rung.
    const calls = await look(assignedLedger(), { entryExtensionFilter: "on", entryMaxExtensionZ: 0.5 }, stretched);
    expect(calls.actions.map((action) => action.kind)).toEqual(calls.actions.map(() => "open_covered_call"));
    expect(calls.actions.reduce((sum, action) => sum + action.quantity!, 0)).toBe(5);
    const ladder = await look(assignedLedger(), { entryExtensionFilter: "on", entryMaxExtensionZ: 0.5, minCallYieldPct: 1000 }, stretched);
    expect(ladder.actions.length).toBeGreaterThan(0);
    expect(ladder.actions.every((action) => action.kind === "open_cash_secured_put" && "ladderCap" in (action.candidateScores ?? {}))).toBe(true);
  });

  it("skips the entry at a high IV Rank", async () => {
    // IBKR's daily IV before today: 0.4, 1.4, 1.2, so IV Rank 80.
    const rows = [0.4, 1.4, 1.2].map((impliedVolatility, index) => ({ tradingDate: addCalendarDays("2026-02-25", index), open: 100, high: 100, low: 100, close: 100, volume: 1, impliedVolatility }));
    const highIv = { ...lookSymbol, bars: new BacktestBarHistory(rows) } as unknown as BacktestLookSymbol;
    const flatLedger = () => createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    const blocked = await look(flatLedger(), { entryIvRankFilter: "on", entryMaxIvRank: 80 }, highIv);
    expect(blocked.actions).toEqual([]);
    expect(blocked.summary).toContain("WHL: no new entry (IV Rank 80 ≥ 80)");
    expect(blocked.noSaleNotes).toEqual([{ tradingDate: todayIso, symbol: "WHL", reason: "entry_filter", entryFilterLimits: { extensionZ: null, ivRank: 80 } }]);
    expect((await look(flatLedger(), { entryIvRankFilter: "on", entryMaxIvRank: 81 }, highIv)).actions.length).toBeGreaterThan(0);
  });

  it("records why the free shares got no call when a ladder Put is sold instead of them", async () => {
    // No Call qualifies (all held to a 1,000% yield): the ladder's Put is sold, the shares wait for want of a Call.
    const noCall = await look(assignedLedger(), { ladderPutVersusCall: "higher_yield", minCallYieldPct: 1000 });
    expect(noCall.actions.every((action) => action.kind === "open_cash_secured_put")).toBe(true);
    expect(noCall.noSaleNotes).toEqual([{ tradingDate: todayIso, symbol: "WHL", reason: "no_call_candidate", entryFilterLimits: null }]);
    // Calls qualify and sell first by default: nothing to record.
    expect((await look(assignedLedger())).noSaleNotes).toEqual([]);
  });

  it("once assigned: no entry Put with the budget used, Calls on the shares, and the ladder's Puts on the reserve when no Call qualifies", async () => {
    const withCalls = await look(assignedLedger());
    expect(withCalls.actions.map((action) => action.kind)).toEqual(withCalls.actions.map(() => "open_covered_call"));
    expect(withCalls.actions.reduce((sum, action) => sum + action.quantity!, 0)).toBe(5);
    // No Call above a 1,000% yield: the ladder (started at the assignment) sells a rung, its cap from the break-even.
    const withoutCalls = await look(assignedLedger(), { minCallYieldPct: 1000 });
    expect(withoutCalls.actions.length).toBeGreaterThan(0);
    expect(withoutCalls.actions.every((action) => action.kind === "open_cash_secured_put")).toBe(true);
    // The base is the account's value, the assigned Put's premium included: the reserve is half of it, in 5 rungs.
    const scores = withoutCalls.actions[0]!.candidateScores!;
    expect(scores.ladderReserve as number).toBeCloseTo((scores.ladderBase as number) / 2, 6);
    expect(scores.ladderReserve as number).toBeGreaterThan(50_000);
    expect(scores.ladderRungCollateral as number).toBeCloseTo((scores.ladderReserve as number) / 5, 6);
    expect(withoutCalls.actions[0]!.contract!.strike).toBeLessThanOrEqual(scores.ladderCap as number);
    // The look records the ladder's levels before its orders: the cap the rung sold under, nothing committed yet.
    expect(withoutCalls.ladderLevels).toEqual([
      expect.objectContaining({ symbol: "WHL", tradingDate: todayIso, splitFactor: 1, levels: expect.objectContaining({ nextPutCap: scores.ladderCap, firstRungCap: scores.ladderCap, floor: scores.ladderFloor, committed: 0, blockedBecause: null }) }),
    ]);
  });

  it("records no ladder levels while no shares are held", async () => {
    expect((await look(createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30)))).ladderLevels).toEqual([]);
  });
});

describe("selectBaselineCandidates with the Signals model", () => {
  /** τ: 0.8 variance sessions per calendar day, so the forecast's clock runs slower than the calendar's 1 ÷ 365. */
  const varianceSessionsPerDay = 0.8;
  function model(overrides: Partial<BaselineModelInput> = {}): BaselineModelInput {
    return { tables: volatilityModelTables, group: "stock", forecast: fixtureModelForecast(0.4), varianceSessionsTo: (expiryIso) => yearsBetweenIsoDates(todayIso, expiryIso) * 365 * varianceSessionsPerDay, minVolatilityEdge: null, rankByEdgeYield: false, ...overrides };
  }
  // The quotes' 50% on the calendar's clock is √(252 × 0.25 ÷ 365 ÷ 0.8) = 46.4% on the forecast's: 6.4 points above 40%.
  const edgeOnForecastClock = Math.sqrt((252 * volatility * volatility) / 365 / varianceSessionsPerDay) - 0.4;

  it("measures the volatility edge on the forecast's clock and sells only at or above the margin", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-20", 95, "P")];
    const kept = selectBaselineCandidates(input(quotes, { model: model({ minVolatilityEdge: 0.06 }) }));
    expect(kept.candidates).toHaveLength(2);
    for (const candidate of kept.candidates) expect(candidate.volatilityEdge).toBeCloseTo(edgeOnForecastClock, 2);
    const refused = selectBaselineCandidates(input(quotes, { model: model({ minVolatilityEdge: 0.07 }) }));
    expect(refused.candidates).toEqual([]);
    expect(refused.rejections.belowVolatilityEdge).toBe(2);
    // Without the model the edge is not measured; with it but no margin it is measured and nothing is left out.
    expect(selectBaselineCandidates(input(quotes)).candidates[0]!.volatilityEdge).toBeNull();
    expect(selectBaselineCandidates(input(quotes, { model: model() })).candidates).toHaveLength(2);
  });

  it("leaves everything out without a forecast or once the expiry's variance is spent", () => {
    const quotes = [quote("2026-03-06", 95, "P")];
    expect(selectBaselineCandidates(input(quotes, { model: model({ forecast: null }) })).rejections.noForecast).toBe(1);
    expect(selectBaselineCandidates(input(quotes, { model: model({ varianceSessionsTo: () => 0 }) })).rejections.noForecast).toBe(1);
  });

  it("ranks by the model's Edge Yield when asked, valued with the session's friction", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-06", 100, "P"), quote("2026-03-27", 95, "P"), quote("2026-03-27", 90, "P")];
    const byPremium = selectBaselineCandidates(input(quotes, { model: model() })).candidates;
    const byEdge = selectBaselineCandidates(input(quotes, { model: model({ rankByEdgeYield: true }) })).candidates;
    expect(byPremium.every((candidate) => candidate.edgeYield === null)).toBe(true);
    const edgeYields = byEdge.map((candidate) => candidate.edgeYield!);
    expect(edgeYields).toEqual([...edgeYields].sort((a, b) => b - a));
    expect(byEdge.map((candidate) => `${candidate.expiry} ${candidate.strike}`)).not.toEqual(byPremium.map((candidate) => `${candidate.expiry} ${candidate.strike}`));
    const first = byEdge[0]!;
    const years = yearsBetweenIsoDates(todayIso, first.expiry);
    const forward = stockPrice * Math.exp(riskFreeRate * years);
    const expected = valueContract(volatilityModelTables, {
      isCall: false,
      strike: first.strike,
      forward,
      mid: (first.bid + first.ask) / 2,
      frictionDollars: frictionDollarsPerContract(first.bid, first.ask, 0.5, 0.68),
      perSessionVariance: fixtureModelForecast(0.4).perSessionVariance,
      varianceSessions: years * 365 * varianceSessionsPerDay,
      calendarYears: years,
      riskFreeRate,
      group: "stock",
      spot: stockPrice,
    })!;
    expect(first.edgeYield).toBeCloseTo(expected.expectedAnnualizedReturn, 3);
  });
});

describe("baselineContractsForCash", () => {
  it("reserves a put's strike less its fill, and pays a Covered Call entry's shares less its fill, with commissions", () => {
    // Put: (95 − 2) × 100 + 0.68 = 9,300.68 per contract.
    expect(baselineContractsForCash(93_006.8, { strike: 95, fillPrice: 2 }, "put", 100.01, flatCommissions)).toBe(10);
    expect(baselineContractsForCash(93_006.7, { strike: 95, fillPrice: 2 }, "put", 100.01, flatCommissions)).toBe(9);
    // Covered Call entry: (100.01 − 3) × 100 + 0.68 + 100 × $0.005 = 9,702.18 per contract.
    expect(baselineContractsForCash(97_021.8, { strike: 105, fillPrice: 3 }, "covered_call", 100.01, flatCommissions)).toBe(10);
    expect(baselineContractsForCash(97_021.7, { strike: 105, fillPrice: 3 }, "covered_call", 100.01, flatCommissions)).toBe(9);
  });
});

describe("validateBaselineSettings", () => {
  it("accepts the defaults and refuses ranges that are out of order or out of bounds", () => {
    const valid = { entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15, callStrike: "delta_range", entryCallStrike: "any", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, entryExtensionFilter: "off", entryMaxExtensionZ: 1, entryIvRankFilter: "off", entryMaxIvRank: 80, ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "best_contract", entryWhenSharesUncovered: "wait", maxSharesPctOfAccount: 100, minCallYieldPct: 0, minCallYieldAppliesTo: "every_call", putsWhenNoCall: "off", dayValueOptions: "marked" };
    expect(validateBaselineSettings(valid)).toBeNull();
    expect(validateBaselineSettings({ ...valid, entryExtensionFilter: "on", entryMaxExtensionZ: 1.5, entryIvRankFilter: "on", entryMaxIvRank: 90 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, entryExtensionFilter: "entries" })).toMatch(/entryExtensionFilter must be off or on/);
    expect(validateBaselineSettings({ ...valid, entryMaxExtensionZ: 0 })).toMatch(/entryMaxExtensionZ/);
    expect(validateBaselineSettings({ ...valid, entryMaxExtensionZ: 11 })).toMatch(/entryMaxExtensionZ/);
    expect(validateBaselineSettings({ ...valid, entryIvRankFilter: true })).toMatch(/entryIvRankFilter must be off or on/);
    expect(validateBaselineSettings({ ...valid, entryMaxIvRank: 0 })).toMatch(/entryMaxIvRank/);
    expect(validateBaselineSettings({ ...valid, entryMaxIvRank: 101 })).toMatch(/entryMaxIvRank/);
    expect(validateBaselineSettings({ ...valid, entry: "strangle" })).toMatch(/entry/);
    expect(validateBaselineSettings({ ...valid, minAbsDelta: 0.7 })).toMatch(/minAbsDelta must not be above/);
    expect(validateBaselineSettings({ ...valid, maxDte: 60 })).toMatch(/0 to 45/);
    expect(validateBaselineSettings({ ...valid, minDte: -1 })).toMatch(/0 to 45/);
    expect(validateBaselineSettings({ ...valid, minDte: 0 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, minDte: 10, maxDte: 5 })).toMatch(/minDte must not be above/);
    expect(validateBaselineSettings({ ...valid, maxSpreadPctOfMid: 50 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, maxSpreadPctOfMid: 0 })).toMatch(/maxSpreadPctOfMid/);
    expect(validateBaselineSettings({ ...valid, maxSpreadPctOfMid: 250 })).toMatch(/maxSpreadPctOfMid/);
    expect(validateBaselineSettings({ ...valid, callStrike: "above_break_even", takeProfitPct: 75 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callStrike: "anywhere" })).toMatch(/callStrike/);
    expect(validateBaselineSettings({ ...valid, callStrike: "none" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callStrike: "none", entry: "covered_call" })).toMatch(/Covered Call/);
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "own_range", callMinAbsDelta: 0.1, callMaxAbsDelta: 0.2 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "wide" })).toMatch(/callDeltaRange/);
    expect(validateBaselineSettings({ ...valid, entry: "covered_call", entryCallStrike: "above_purchase_price" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, entryCallStrike: "otm" })).toMatch(/entryCallStrike/);
    expect(validateBaselineSettings({ ...valid, callMinAbsDelta: 0 })).toMatch(/callMinAbsDelta/);
    expect(validateBaselineSettings({ ...valid, callMinAbsDelta: 0.3, callMaxAbsDelta: 0.2 })).toMatch(/callMinAbsDelta must not be above/);
    expect(validateBaselineSettings({ ...valid, takeProfitPct: 100 })).toMatch(/takeProfitPct/);
    expect(validateBaselineSettings({ ...valid, shareStopLossPct: 25, earnings: "skip_spanning", maxAccountPctPerStock: 50, looks: "first_look" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, shareStopLossPct: -1 })).toMatch(/shareStopLossPct/);
    expect(validateBaselineSettings({ ...valid, earnings: "close_before" })).toMatch(/earnings/);
    expect(validateBaselineSettings({ ...valid, maxAccountPctPerStock: 0 })).toMatch(/maxAccountPctPerStock/);
    expect(validateBaselineSettings({ ...valid, looks: "hourly" })).toMatch(/looks/);
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "entries", minVolatilityEdgePoints: -5, ranking: "edge_yield" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "all_sales" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "on" })).toMatch(/volatilityEdgeFilter/);
    expect(validateBaselineSettings({ ...valid, minVolatilityEdgePoints: 150 })).toMatch(/minVolatilityEdgePoints/);
    expect(validateBaselineSettings({ ...valid, ranking: "delta" })).toMatch(/ranking/);
    expect(validateBaselineSettings({ ...valid, ranking: "premium_dollars", callStrike: "above_latest_entry", expiryChoice: "nearest_qualifying", coverage: "fill_down_ranking" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, expiryChoice: "farthest" })).toMatch(/expiryChoice/);
    expect(validateBaselineSettings({ ...valid, coverage: "all" })).toMatch(/coverage/);
    expect(validateBaselineSettings({ ...valid, entry: "covered_call", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "buy" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, entryWhenSharesUncovered: "sometimes" })).toMatch(/entryWhenSharesUncovered/);
    expect(validateBaselineSettings({ ...valid, entry: "covered_call", maxSharesPctOfAccount: 70, minCallYieldPct: 30 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, maxSharesPctOfAccount: 70 })).toMatch(/needs baseline.entry set to Covered Call/);
    expect(validateBaselineSettings({ ...valid, entry: "covered_call", maxSharesPctOfAccount: 0 })).toMatch(/maxSharesPctOfAccount/);
    expect(validateBaselineSettings({ ...valid, minCallYieldPct: -1 })).toMatch(/minCallYieldPct/);
    expect(validateBaselineSettings({ ...valid, minCallYieldAppliesTo: "held_calls" })).toMatch(/minCallYieldAppliesTo/);
    expect(validateBaselineSettings({ ...valid, minCallYieldAppliesTo: "new_covered_calls" })).toBeNull();
    // One put sized per day to expiry is gone: only None and the ladder, the ladder with either entry.
    expect(validateBaselineSettings({ ...valid, putsWhenNoCall: "dte_budget" })).toMatch(/putsWhenNoCall must be off or reserve_ladder/);
    expect(validateBaselineSettings({ ...defaultBacktestBaselineSettings, entry: "put", putsWhenNoCall: "reserve_ladder" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, putsWhenNoCall: "always" })).toMatch(/putsWhenNoCall/);
    expect(validateBaselineSettings({ ...valid, callStrike: "above_average_cost_else_break_even", ranking: "premium_per_day", dayValueOptions: "excluded" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, dayValueOptions: "never" })).toMatch(/dayValueOptions/);
    const ladder = { ...defaultBacktestBaselineSettings, entry: "covered_call", putsWhenNoCall: "reserve_ladder" };
    expect(validateBaselineSettings(ladder)).toBeNull();
  });
});
