import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesDelta, blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import { defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, type BacktestVolFarmerV2Settings, type EffectiveBacktestSettings, type VolFarmerV2StepRule } from "../backtestTypes.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLookTypes.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { describeVolFarmerV2Run, impliedVolatilityBefore, runVolFarmerV2Look } from "./backtestVolFarmerV2Look.js";
import { chooseVolFarmerV2Leaps, contractsAffordable, volFarmerV2BreakEven, volFarmerV2ImpliedMoveStep, volFarmerV2LeapsBudget, volFarmerV2PutStrikeCap } from "./volFarmerV2Steps.js";
import { expirySettlementInstant, settleExpiry } from "./ledger/ledgerEvents.js";
import { ledgerFreeCash, ledgerNetLiquidationValue } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

/** Daily bars at 100 with IBKR's 30-day IV as given (null: none that day). */
const barsWithImpliedVolatility = (days: [string, number | null][]) => new BacktestBarHistory(days.map(([tradingDate, impliedVolatility]) => ({ tradingDate, open: 100, high: 100, low: 100, close: 100, volume: 1_000, impliedVolatility })));

describe("the v2 formulas", () => {
  it("puts a position's premiums against its shares' cost", () => {
    // 200 shares at 250.01, Calls that brought in $540 net: 250.01 − 2.70 = 247.31 a share.
    expect(volFarmerV2BreakEven({ shares: 200, costPerShare: 250.01, premiumDollars: 540 })).toBeCloseTo(247.31, 10);
    expect(volFarmerV2BreakEven({ shares: 0, costPerShare: 0, premiumDollars: 120 })).toBeNull();
  });

  it("caps the Puts' strike a set share below the first break-even", () => {
    expect(volFarmerV2PutStrikeCap(246, 15)).toBeCloseTo(209.1, 10);
  });

  it("takes the one-month implied move as the Step, from the latest IV of the 10 sessions before the day", () => {
    // IV 60%: 60 × √(21 ÷ 252) = 17.32% below the first break-even; no IV, the fixed Step.
    expect(volFarmerV2ImpliedMoveStep(15, 0.6).stepPct).toBeCloseTo(17.3205, 4);
    expect(volFarmerV2ImpliedMoveStep(15, null)).toEqual({ stepPct: 15, impliedVolatility: null });
    // IV on the 1st, none on the 2nd to the 11th, IV again on the 12th.
    const days = Array.from({ length: 12 }, (_, index) => `2026-03-${String(index + 1).padStart(2, "0")}`);
    const bars = barsWithImpliedVolatility(days.map((day, index): [string, number | null] => [day, index === 0 ? 0.5 : index === 11 ? 0.7 : null]));
    // On the 11th the 10 sessions before it reach back to the 1st; on the 12th they don't, and its own bar is not before it.
    expect(impliedVolatilityBefore(bars, "2026-03-11")).toBe(0.5);
    expect(impliedVolatilityBefore(bars, "2026-03-12")).toBeNull();
    expect(impliedVolatilityBefore(bars, "2026-03-13")).toBe(0.7);
  });

  it("caps what a LEAPS spends at a share of the account", () => {
    // No cap: all the free cash. MSTR on 27 Oct 2025 with a 10% cap: min($96,142, 10% of $363,289) = $36,328.90, 3 contracts at $10,250.68.
    expect(volFarmerV2LeapsBudget(96_142, 363_289, 0)).toBe(96_142);
    expect(volFarmerV2LeapsBudget(96_142, 363_289, 10)).toBeCloseTo(36_328.9, 6);
    expect(contractsAffordable(volFarmerV2LeapsBudget(96_142, 363_289, 10), 102.5)).toBe(3);
    // Never more than the free cash.
    expect(volFarmerV2LeapsBudget(20_000, 363_289, 10)).toBe(20_000);
  });

  it("buys as many contracts as the cash pays for, commission included", () => {
    // $29.80 a share is $2,980 a contract with $0.68 commission each: $29,763 pays for 9, $2,980 for none.
    expect(contractsAffordable(29_763, 29.8)).toBe(9);
    expect(contractsAffordable(2_980, 29.8)).toBe(0);
    expect(contractsAffordable(2_980.68, 29.8)).toBe(1);
  });

  it("takes the LEAPS whose |delta| is nearest the one asked, of usable quotes only", () => {
    const years = 1;
    const forward = 100 * Math.exp(0.04 * years);
    const quoteAt = (strike: number, spread = 0.02) => {
      const mid = blackScholesPriceOnForward(forward, strike, years, 0.04, 0.5, true);
      return { expiry: "2027-03-19", strike, right: "C" as const, bid: mid * (1 - spread), ask: mid * (1 + spread), askSize: strike };
    };
    const quotes = [70, 80, 90, 100, 110].map((strike) => quoteAt(strike));
    const deltaOf = (strike: number) => blackScholesDelta(forward, strike, years, 0.04, 0.5, true);
    const nearest = [70, 80, 90, 100, 110].reduce((best, strike) => (Math.abs(deltaOf(strike) - 0.7) < Math.abs(deltaOf(best) - 0.7) ? strike : best));
    const chosen = chooseVolFarmerV2Leaps({ quotes, expiry: "2027-03-19", stockPrice: 100, yearsToExpiry: years, riskFreeRate: 0.04, absDelta: 0.7, maxSpreadPctOfMid: 50, spreadShareCharged: 0 })!;
    expect(chosen.strike).toBe(nearest);
    expect(chosen.delta).toBeCloseTo(deltaOf(nearest), 3);
    // The contracts its ask offered come with it, for the purchase's cap.
    expect(chosen.askSize).toBe(nearest);
    // A quote whose spread is past the limit is passed over.
    const wide = quotes.map((quote) => (quote.strike === nearest ? quoteAt(nearest, 0.6) : quote));
    expect(chooseVolFarmerV2Leaps({ quotes: wide, expiry: "2027-03-19", stockPrice: 100, yearsToExpiry: years, riskFreeRate: 0.04, absDelta: 0.7, maxSpreadPctOfMid: 50, spreadShareCharged: 0 })!.strike).not.toBe(nearest);
  });
});

describe("Vol Farmer v2 at the looks", () => {
  const symbol = "VFT";
  const riskFreeRate = 0.04;
  const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  /** Black-Scholes quotes at IV 50% on the forward, 2% either side of the mid, at 10:00 on `todayIso`. */
  function quotesAt(input: { todayIso: string; stockPrice: number; expiry: string; strikes: number[]; right: "C" | "P" }): SymbolFileQuote[] {
    const atMs = easternInstant(input.todayIso, 10, 0).getTime();
    const years = (expirySettlementInstant(input.expiry).getTime() - atMs) / (365 * 86_400_000);
    return input.strikes.map((strike) => {
      const mid = blackScholesPriceOnForward(input.stockPrice * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, 0.5, input.right === "C");
      return { expiry: input.expiry, strike, right: input.right, bid: round4(mid * 0.98), ask: round4(mid * 1.02), bidSize: 10, askSize: 10 };
    });
  }

  /** A 10:00 look's symbol: the next expiry's Calls and Puts, and a LEAPS expiry a year out whose asks offer `leapsAskSize` contracts. */
  function lookSymbolOf(todayIso: string, stockPrice: number, expiry: string, leapsAskSize: number | null = 10, leapsExpiry = "2027-04-16"): BacktestLookSymbol {
    const quotes = [...quotesAt({ todayIso, stockPrice, expiry, strikes: range(40, 140), right: "C" }), ...quotesAt({ todayIso, stockPrice, expiry, strikes: range(40, 140), right: "P" })];
    const leaps = quotesAt({ todayIso, stockPrice, expiry: leapsExpiry, strikes: range(30, 120), right: "C" }).map((quote) => ({ ...quote, askSize: leapsAskSize }));
    return {
      profile: { symbol, calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(quotes.map((quote) => [contractKey(quote), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      adjustedDailyClosesBeforeToday: [],
      splitFactorToday: 1,
      optionContractsRepresentable: true,
      leapsCallQuotes: { listedExpiries: () => [expiry, leapsExpiry], quotesOf: (listed: string) => (listed === leapsExpiry ? leaps : quotes.filter((quote) => quote.right === "C")) },
    } as unknown as BacktestLookSymbol;
  }

  let actionNumber = 0;
  const nextActionId = () => `action-${++actionNumber}`;
  function look(ledger: SimulatedLedger, todayIso: string, stockPrice: number, expiry: string, more: Partial<BacktestVolFarmerV2Settings> = {}, leapsAskSize: number | null = 10, bars = barsWithImpliedVolatility([])) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...defaultBacktestVolFarmerV2Settings, ...more } } as unknown as EffectiveBacktestSettings;
    return runVolFarmerV2Look({ todayIso, lookTimeEt: "10:00", symbols: [{ ...lookSymbolOf(todayIso, stockPrice, expiry, leapsAskSize), bars }], settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
  }
  const openOption = (ledger: SimulatedLedger, optionType: "call" | "put", side: "short" | "long" = "short"): LedgerLeg[] => ledger.legs.filter((leg) => leg.legType === "option" && leg.optionType === optionType && leg.side === side && leg.exitAt === null);
  const breakEvenIn = (description: string, position: "first" | "second") => Number(new RegExp(`${position} position \\d+×, break-even now (\\d+\\.\\d+)`).exec(description)![1]);

  it("opens with half the pot, sells Puts on the other half after a fall, and gives their shares a break-even of their own", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    // Monday 9 March at 100: 4 lots ($40,000 and commission; a fifth would pass $50,000) with the first Call.
    const opened = await look(ledger, "2026-03-09", 100, "2026-03-13");
    expect(opened.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    expect(opened.actions[0]!.description).toContain("with 400 shares bought @ 100.00");
    const firstCall = opened.actions[0]!;
    const firstBreakEven = breakEvenIn(firstCall.description, "first");
    // What the shares cost (commission in) less the Call's premium net of its commission, per share.
    expect(firstBreakEven).toBeCloseTo((40_000 + 400 * 0.005 + 1 - (firstCall.fillPrice! * 400 - 4 * 0.68)) / 400, 1);
    expect(firstCall.contract!.strike).toBeGreaterThanOrEqual(firstBreakEven);
    // The Wheel cycles' B-E¹ of the sale: the break-even the Call was held to, before its own premium (the shares' cost,
    // $0.005 a share commission included).
    expect((firstCall.candidateScores as { breakEvenFirst: number }).breakEvenFirst).toBeCloseTo((40_000 + 400 * 0.005) / 400, 6);

    // Thursday 12 March at 80, the Call sold on Monday is still open: no Put, however far the price fell.
    const callStillOpen = await look(ledger, "2026-03-12", 80, "2026-03-13");
    expect(callStillOpen.actions).toEqual([]);

    // The Call expires below its strike; Monday 16 March at 80 no Call reaches the first break-even, so Puts are sold.
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const afterFall = await look(ledger, "2026-03-16", 80, "2026-03-20");
    expect(afterFall.actions.map((action) => action.kind)).toEqual(["open_cash_secured_put"]);
    const put = afterFall.actions[0]!;
    const cap = volFarmerV2PutStrikeCap(firstBreakEven, 15);
    expect(put.contract!.strike).toBeLessThanOrEqual(cap + 0.01);
    expect(Math.abs((put.candidateScores as { delta: number }).delta)).toBeLessThanOrEqual(0.2);
    // Half the pot secures floor(50,000 ÷ (strike × 100)) contracts.
    expect(put.quantity).toBe(Math.floor(50_000 / (put.contract!.strike! * 100)));
    expect(put.description).toContain(`no Call at or above the first break-even ${firstBreakEven.toFixed(2)}`);
    // A Put records B-E¹, the break-even its strike cap is measured from.
    expect((put.candidateScores as { breakEvenFirst: number }).breakEvenFirst).toBeCloseTo(firstBreakEven, 2);
    // The fixed Step is neither said nor recorded.
    expect(put.description).not.toContain("Step");
    expect(put.candidateScores).not.toHaveProperty("stepPct");

    // Assigned at Friday's close: Monday 23 March the second position sells its own Call, at or above its own break-even.
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    const assigned = await look(ledger, "2026-03-23", put.contract!.strike! - 2, "2026-03-27");
    const secondCall = assigned.actions.find((action) => action.description.includes("second position"))!;
    expect(secondCall.kind).toBe("open_covered_call");
    const secondShares = put.quantity! * 100;
    const putNet = put.fillPrice! * secondShares - 0.68 * put.quantity!;
    const callNet = secondCall.fillPrice! * secondShares - 0.68 * put.quantity!;
    expect(breakEvenIn(secondCall.description, "second")).toBeCloseTo(put.contract!.strike! - (putNet + callNet) / secondShares, 2);
    // The second position's Call records B-E², before its own premium.
    expect((secondCall.candidateScores as { breakEvenSecond: number }).breakEvenSecond).toBeCloseTo(put.contract!.strike! - putNet / secondShares, 6);
    expect(assigned.actions.some((action) => action.kind === "open_cash_secured_put")).toBe(false);
  });

  it("takes the Step from IBKR's IV at each Put sale, and the fixed Step without one", async () => {
    // IV 30% on Friday 6 March, before the cycle opens on Monday 9 March; 90% on Friday 13 March, before the Put on Monday 16 March.
    const bars = barsWithImpliedVolatility([["2026-03-06", 0.3], ["2026-03-13", 0.9]]);
    const putAfterFall = async (stepRule: VolFarmerV2StepRule, history: BacktestBarHistory) => {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
      const opened = await look(ledger, "2026-03-09", 100, "2026-03-13", { stepRule }, 10, history);
      settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
      const afterFall = await look(ledger, "2026-03-16", 80, "2026-03-20", { stepRule }, 10, history);
      const put = afterFall.actions.find((action) => action.kind === "open_cash_secured_put")!;
      return { firstBreakEven: breakEvenIn(opened.actions[0]!.description, "first"), put, scores: put.candidateScores as { stepPct: number; stepImpliedVolatility: number | null } };
    };

    // At the Put sale the latest IV is Friday's 90%: 90 × √(21 ÷ 252) = 25.98%, so the Put is struck lower than with the fixed 15%.
    const fixed = await putAfterFall("fixed", bars);
    const atSale = await putAfterFall("implied_move_at_put_sale", bars);
    expect(atSale.scores.stepPct).toBeCloseTo(90 * Math.sqrt(21 / 252), 10);
    expect(atSale.scores.stepImpliedVolatility).toBe(0.9);
    expect(atSale.put.contract!.strike).toBeLessThanOrEqual(volFarmerV2PutStrikeCap(atSale.firstBreakEven, atSale.scores.stepPct) + 0.01);
    expect(atSale.put.contract!.strike).toBeLessThan(fixed.put.contract!.strike!);
    expect(atSale.put.description).toContain("(Step 26.0%: IV 90.0% × √(21 ÷ 252))");

    // No IV in the 10 sessions before the day: the fixed Step, 15%.
    const withoutIv = await putAfterFall("implied_move_at_put_sale", barsWithImpliedVolatility([]));
    expect(withoutIv.scores).toMatchObject({ stepPct: 15, stepImpliedVolatility: null });
    expect(withoutIv.put.description).toContain("(Step 15.0%: no IV in the last 10 sessions, the fixed Step)");
  });

  it("buys a LEAPS with the free cash, up to the contracts its ask offers, when the second position finds no Call, and sells it once that position is called away", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    // Monday 23 March at 55, far under both break-evens: no Call for either position, so the LEAPS. The free cash pays for
    // more contracts than the 5 its ask offers: 5 are bought, the rest stays in cash.
    const freeCash = ledgerFreeCash(ledger);
    const fallen = await look(ledger, "2026-03-23", 55, "2026-03-27", {}, 5);
    const leaps = fallen.actions.find((action) => action.kind === "buy_leaps")!;
    expect(leaps.contract).toMatchObject({ strategyKey: "leaps", right: "C", expiry: "2027-04-16" });
    expect(Math.abs((leaps.candidateScores as { delta: number }).delta - 0.7)).toBeLessThan(0.05);
    const affordable = contractsAffordable(freeCash, leaps.fillPrice!);
    expect(affordable).toBeGreaterThan(5);
    expect(leaps.quantity).toBe(5);
    expect(leaps.description).toContain(`which pays for ${affordable}: 5 offered at the ask`);
    expect(openOption(ledger, "call", "long")).toHaveLength(1);
    expect(ledger.positions.find((position) => position.id === leaps.positionIds![0])!.strategyKey).toBe("leaps");
    // Not again for the same holding.
    expect((await look(ledger, "2026-03-24", 54, "2026-03-27")).actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);

    // Back up to 85 on Monday 30 March: the second position sells a Call, assigned at Friday's close at 90.
    const recovered = await look(ledger, "2026-03-30", 85, "2026-04-02");
    expect(recovered.actions.some((action) => action.description.includes("second position"))).toBe(true);
    const secondCallLeg = openOption(ledger, "call").find((leg) => leg.strikePrice! < 99)!;
    settleExpiry(ledger, { legId: secondCallLeg.id, expiryClose: 90 });
    const afterCallAway = await look(ledger, "2026-04-06", 90, "2026-04-10");
    expect(afterCallAway.actions[0]).toMatchObject({ kind: "sell_leaps", contract: { strategyKey: "leaps", right: "C" } });
    expect(openOption(ledger, "call", "long")).toEqual([]);
    expect(describeVolFarmerV2Run(ledger, [symbol])).toMatch(/1 LEAPS trigger\(s\), 1 bought \(\d+× on 2026-03-23\)/);
  });

  it("spends no more than the LEAPS cap's share of the account on the LEAPS", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    const cap = { leapsMaxAccountPct: 10 };
    await look(ledger, "2026-03-09", 100, "2026-03-13", cap, 100);
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20", cap, 100)).actions[0]!;
    // The cap leaves the Puts on half the pot.
    expect(put.quantity).toBe(Math.floor(50_000 / (put.contract!.strike! * 100)));
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    // The free cash would pay for more; 10% of the account (no marks given: each leg at its entry price) is the limit, though the ask offers 100.
    const freeCash = ledgerFreeCash(ledger);
    const accountValue = ledgerNetLiquidationValue(ledger, new Map());
    expect(freeCash).toBeGreaterThan(accountValue * 0.1);
    const leaps = (await look(ledger, "2026-03-23", 55, "2026-03-27", cap, 100)).actions.find((action) => action.kind === "buy_leaps")!;
    expect(leaps.quantity).toBe(contractsAffordable(accountValue * 0.1, leaps.fillPrice!));
    expect(leaps.quantity).toBeLessThan(contractsAffordable(freeCash, leaps.fillPrice!));
    expect((leaps.candidateScores as { accountValue: number }).accountValue).toBeCloseTo(accountValue, 6);
    expect(leaps.description).toContain(`LEAPS cap ${formatWholeDollars(accountValue * 0.1)} (10% of the account ${formatWholeDollars(accountValue)})`);
  });

  it("buys no LEAPS while its ask shows no size, and buys it at a later look that shows one", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    const noSize = await look(ledger, "2026-03-23", 55, "2026-03-27", {}, null);
    expect(noSize.actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);
    expect(noSize.summary).toMatch(/no LEAPS: the \d+ Call shows no size at its ask/);
    expect((await look(ledger, "2026-03-24", 54, "2026-03-27", {}, 3)).actions.filter((action) => action.kind === "buy_leaps").map((action) => action.quantity)).toEqual([3]);
  });

  it("sells one Call for both positions when they pick the same contract", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    // Monday 23 March at 105, above both break-evens: the lowest strike within |delta| 0.30 fits both.
    const both = await look(ledger, "2026-03-23", 105, "2026-03-27");
    const calls = both.actions.filter((action) => action.kind === "open_covered_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.quantity).toBe(4 + put.quantity!);
    expect(calls[0]!.description).toMatch(/first position 4×.*second position \d+×/);
  });

  it("decides at a later look on that look's quotes and price, and records the look's time", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...defaultBacktestVolFarmerV2Settings, looks: "every_look" } } as unknown as EffectiveBacktestSettings;
    // The 10:00 capture at 100; the 10:30 look's own quotes at 90.
    const tenOClock = lookSymbolOf("2026-03-09", 100, "2026-03-13");
    const later = lookSymbolOf("2026-03-09", 90, "2026-03-13");
    const lookSymbol = { ...tenOClock, bars: barsWithImpliedVolatility([]), intraday: { quotes: later.market.quotes, stockPrice: 90 } } as BacktestLookSymbol;
    const result = await runVolFarmerV2Look({ todayIso: "2026-03-09", lookTimeEt: "10:30", symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
    expect(result.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    // Half the pot at 90: floor(50,000 ÷ 9,000.50) = 5 lots, bought at the look's price.
    expect(result.actions[0]!.description).toContain("with 500 shares bought @ 90.00");
    expect(result.actions[0]!.lookTimeEt).toBe("10:30");
    expect(result.actions[0]!.at).toBe(easternInstant("2026-03-09", 10, 30).toISOString());
    expect(result.breakEvenLevels![0]!.lookTimeEt).toBe("10:30");
  });
});
