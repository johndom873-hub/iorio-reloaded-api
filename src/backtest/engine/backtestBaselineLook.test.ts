import { describe, expect, it } from "vitest";
import { valueContract } from "../../lib/contractValuation.js";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { fixtureModelForecast } from "../../lib/testSupport/valuationModelFixtures.js";
import { volatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import { defaultBacktestBaselineSettings, type BacktestBaselineSettings, type EffectiveBacktestSettings } from "../backtestTypes.js";
import { validateBaselineSettings } from "../jobs/backtestSessionRequest.js";
import { baselineContractsForCash, runBaselineLook, selectBaselineCandidates, type BaselineCandidateInput, type BaselineModelInput } from "./backtestBaselineLook.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { openCashSecuredPut, settleExpiry } from "./ledger/ledgerEvents.js";
import { ledgerFreeShares, ledgerHeldSharesAverageCost } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, legsOfPosition, positionsOfSymbol, type SimulatedLedger } from "./ledger/simulatedLedger.js";

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
  return {
    quotes,
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
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "buy_write", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase", ...baseline } } as unknown as EffectiveBacktestSettings;
    const heldShareLegs = positionsOfSymbol(ledger, "WHL").flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock" && leg.exitAt === null);
    const context = { todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(heldShareLegs.map((leg) => [leg.id, stockPrice])), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext;
    return runBaselineLook(context);
  }

  it("leaves held shares uncovered when no call at or above their average has a bid", async () => {
    const plain = await look(assignedLedger(), { entryWhenSharesUncovered: "wait" });
    expect(plain.actions).toEqual([]);
    expect(plain.summary).toMatch(/no call for 100 free shares/);
  });

  it("sells one put when held shares get no call, sized by the account per day to expiry, and no other while it is open", async () => {
    // 100 shares at a $150 average, no call at or above it: the $100 put (25 days) instead. Account value: cash
    // 100,000 + 100 − 0.68 − 15,000 and the shares at $100, so 1% a day to expiry allows 25% of it.
    const puts = { entryWhenSharesUncovered: "wait", putsWhenNoCall: "dte_budget", putBudgetPctPerDte: 1, dayValueOptions: "excluded" } as const;
    const ledger = assignedLedger();
    const first = await look(ledger, puts);
    expect(first.actions.map((action) => action.kind)).toEqual(["open_cash_secured_put"]);
    const put = first.actions[0]!;
    const accountValue = 100_000 + 100 - 0.68 - 15_000 + 100 * 100;
    expect(put.candidateScores!.accountValue as number).toBeCloseTo(accountValue, 6);
    expect(put.candidateScores!.putBudgetDollars as number).toBeCloseTo(accountValue * 0.01 * 25, 6);
    expect(put.candidateScores).toMatchObject({ costCeiling: 150, averageCostBefore: 150, sharesHeldBefore: 100 });
    expect(put.quantity).toBe(Math.floor((accountValue * 0.01 * 25) / ((100 - put.fillPrice!) * 100)));
    // The next look still tries the calls, and sells no second put while this one is open.
    const second = await look(ledger, puts);
    expect(second.actions).toEqual([]);
    expect(second.summary).toMatch(/no call for 100 free shares/);
    expect(second.summary).toMatch(/no new put while one is open/);
  });

  it("buys new lots while held shares wait, their call at or above the average after the purchase", async () => {
    const ledger = assignedLedger();
    const result = await look(ledger, { entryWhenSharesUncovered: "buy" });
    expect(result.actions.length).toBeGreaterThan(0);
    let sharesHeld = 100;
    let averageCost = 150;
    for (const action of result.actions) {
      const bought = action.quantity! * 100;
      const averageAfter = (sharesHeld * averageCost + bought * 100.01) / (sharesHeld + bought);
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
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "buy_write", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost_else_break_even", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "wait", ranking: "premium_per_day" } } as unknown as EffectiveBacktestSettings;
    const result = await runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    // The free cash then goes into a buy-write; the call on the held shares is the one before it.
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

  it("buys a buy-write's shares at the 10:00 price itself when asked", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    let actionNumber = 0;
    const lookSymbol = {
      profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      splitFactorToday: 1,
      optionContractsRepresentable: true,
    } as unknown as BacktestLookSymbol;
    const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "buy_write", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase", shareFill: "ten_oclock_price" } } as unknown as EffectiveBacktestSettings;
    await runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBe(100);
  });

  it("holds buy-writes to the shares' cap at market value, sells no put while calls are sold, and a put when none clears the yield", async () => {
    const capQuotes = [100, 105, 110].map((strike) => quote(expiry, strike, "C")).concat([90, 95, 100].map((strike) => quote(expiry, strike, "P")));
    const run = async (ledger: SimulatedLedger, baseline: Partial<BacktestBaselineSettings>) => {
      let actionNumber = 0;
      const lookSymbol = {
        profile: { symbol: "WHL", calendarChecksApply: false, earnings: [] },
        market: { todayIso, quotes: capQuotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(capQuotes.map((entry) => [contractKey(entry), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
        splitFactorToday: 1,
        optionContractsRepresentable: true,
      } as unknown as BacktestLookSymbol;
      const settings = { trading: { spreadCostChargedPct: 50 }, baseline: { ...defaultBacktestBaselineSettings, entry: "buy_write", minAbsDelta: 0.01, maxAbsDelta: 1, looks: "first_look", coverage: "fill_down_ranking", callStrike: "above_average_cost_else_break_even", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "buy", shareFill: "ten_oclock_price", dayValueOptions: "excluded", maxSharesPctOfAccount: 70, putsWhenNoCall: "dte_budget", ...baseline } } as unknown as EffectiveBacktestSettings;
      return runBaselineLook({ todayIso, calendar: oneDayCalendar, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId: () => `action-${++actionNumber}` } as unknown as BacktestLookContext);
    };
    // $100,000 and no shares: 70% buys 700 shares at $100; the cap leaves no room for an eighth lot, so no put.
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30));
    const capped = await run(ledger, {});
    expect(capped.actions.every((action) => action.kind === "open_covered_call")).toBe(true);
    expect(capped.actions.reduce((sum, action) => sum + action.quantity!, 0)).toBe(7);
    // No call above a 1,000% yield: nothing is bought and one put is sold, at the highest premium yield, any strike.
    const noCall = await run(createSimulatedLedger(100_000, easternInstant("2026-02-27", 9, 30)), { minCallYieldPct: 1000 });
    expect(noCall.actions.map((action) => action.kind)).toEqual(["open_cash_secured_put"]);
    expect(noCall.summary).toMatch(/no new Covered Call \(.*yield/);
    expect(noCall.actions[0]!.candidateScores).toMatchObject({ costCeiling: null, putBudgetDollars: 100_000 * 0.01 * 25 });
    // Shares held at $95: the put's strike stays at or below that average.
    const held = createSimulatedLedger(100_000, easternInstant("2026-02-23", 9, 30));
    const assigned = openCashSecuredPut(held, { symbol: "WHL", expiryDate: "2026-02-27", strike: 95, contracts: 1, fillPrice: 1, at: easternInstant("2026-02-23", 10, 0), actionId: "put", splitFactorToday: 1 });
    settleExpiry(held, { legId: assigned.legId, expiryClose: 90 });
    const atAverage = await run(held, { minCallYieldPct: 1000, maxSharesPctOfAccount: 10 });
    expect(atAverage.actions.map((action) => action.kind)).toEqual(["open_cash_secured_put"]);
    expect(atAverage.actions[0]!.contract!.strike).toBeLessThanOrEqual(95);
    expect(atAverage.actions[0]!.candidateScores).toMatchObject({ costCeiling: 95, averageCostBefore: 95, sharesHeldBefore: 100 });
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
  it("reserves a put's strike less its fill, and pays a buy-write's shares less its fill, with commissions", () => {
    // Put: (95 − 2) × 100 + 0.68 = 9,300.68 per contract.
    expect(baselineContractsForCash(93_006.8, { strike: 95, fillPrice: 2 }, "put", 100.01)).toBe(10);
    expect(baselineContractsForCash(93_006.7, { strike: 95, fillPrice: 2 }, "put", 100.01)).toBe(9);
    // Buy-write: (100.01 − 3) × 100 + 0.68 + 100 × $0.005 = 9,702.18 per contract.
    expect(baselineContractsForCash(97_021.8, { strike: 105, fillPrice: 3 }, "buy_write", 100.01)).toBe(10);
    expect(baselineContractsForCash(97_021.7, { strike: 105, fillPrice: 3 }, "buy_write", 100.01)).toBe(9);
  });
});

describe("validateBaselineSettings", () => {
  it("accepts the defaults and refuses ranges that are out of order or out of bounds", () => {
    const valid = { entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15, callStrike: "delta_range", entryCallStrike: "any", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "best_contract", entryWhenSharesUncovered: "wait", maxSharesPctOfAccount: 100, minCallYieldPct: 0, putsWhenNoCall: "off", putBudgetPctPerDte: 1, shareFill: "plus_one_cent", dayValueOptions: "marked" };
    expect(validateBaselineSettings(valid)).toBeNull();
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
    expect(validateBaselineSettings({ ...valid, callStrike: "none", entry: "buy_write" })).toMatch(/Covered Call/);
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "own_range", callMinAbsDelta: 0.1, callMaxAbsDelta: 0.2 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "wide" })).toMatch(/callDeltaRange/);
    expect(validateBaselineSettings({ ...valid, entry: "buy_write", entryCallStrike: "above_purchase_price" })).toBeNull();
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
    expect(validateBaselineSettings({ ...valid, entry: "buy_write", callStrike: "above_average_cost", entryCallStrike: "above_average_after_purchase", entryWhenSharesUncovered: "buy" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, entryWhenSharesUncovered: "sometimes" })).toMatch(/entryWhenSharesUncovered/);
    expect(validateBaselineSettings({ ...valid, entry: "buy_write", maxSharesPctOfAccount: 70, minCallYieldPct: 30, putsWhenNoCall: "dte_budget", putBudgetPctPerDte: 0.5 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, maxSharesPctOfAccount: 70 })).toMatch(/needs a Covered Call/);
    expect(validateBaselineSettings({ ...valid, entry: "buy_write", maxSharesPctOfAccount: 0 })).toMatch(/maxSharesPctOfAccount/);
    expect(validateBaselineSettings({ ...valid, minCallYieldPct: -1 })).toMatch(/minCallYieldPct/);
    expect(validateBaselineSettings({ ...valid, putsWhenNoCall: "dte_budget" })).toMatch(/needs a Covered Call/);
    expect(validateBaselineSettings({ ...valid, putsWhenNoCall: "always" })).toMatch(/putsWhenNoCall/);
    expect(validateBaselineSettings({ ...valid, putBudgetPctPerDte: 0 })).toMatch(/putBudgetPctPerDte/);
    expect(validateBaselineSettings({ ...valid, callStrike: "above_average_cost_else_break_even", ranking: "premium_per_day", shareFill: "ten_oclock_price", dayValueOptions: "excluded" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, shareFill: "ask" })).toMatch(/shareFill/);
    expect(validateBaselineSettings({ ...valid, dayValueOptions: "never" })).toMatch(/dayValueOptions/);
    const ladder = { ...defaultBacktestBaselineSettings, entry: "buy_write", putsWhenNoCall: "reserve_ladder" };
    expect(validateBaselineSettings(ladder)).toBeNull();
    expect(validateBaselineSettings({ ...ladder, ladderMinutesBetweenRungs: 60, ladderMaxRungsPerSession: 2 })).toBeNull();
    expect(validateBaselineSettings({ ...ladder, ladderMinutesBetweenRungs: 45.5 })).toMatch(/ladderMinutesBetweenRungs/);
    expect(validateBaselineSettings({ ...ladder, ladderMaxRungsPerSession: -1 })).toMatch(/ladderMaxRungsPerSession/);
  });
});
