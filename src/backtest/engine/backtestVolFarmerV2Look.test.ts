import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesDelta, blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import { defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, type BacktestVolFarmerV2Settings, type EffectiveBacktestSettings, type VolFarmerV2StepRule } from "../backtestTypes.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLookTypes.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { describeVolFarmerV2Run, previousSessionImpliedVolatility, runVolFarmerV2Look, volFarmerV2TickerShares } from "./backtestVolFarmerV2Look.js";
import { chooseVolFarmerV2Leaps, contractsAffordable, volFarmerV2BreakEven, volFarmerV2ImpliedMoveStep, volFarmerV2LeapsBudget, volFarmerV2LeapsEntryPriceCap, volFarmerV2PutStrikeCap, volFarmerV2TurnOrder } from "./volFarmerV2Steps.js";
import { alignOpenOptionLegsToSplitFactor, expirySettlementInstant, settleExpiry } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerFreeCash, ledgerNetLiquidationValue } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

/** Daily bars at 100 with IBKR's 30-day IV as given (null: none that day). */
/** Every weekday a session: what the premium yields are annualized over. */
const weekdayCalendar = new BacktestTradingCalendar([], []);
const barsWithImpliedVolatility = (days: [string, number | null][]) => new BacktestBarHistory(days.map(([tradingDate, impliedVolatility]) => ({ tradingDate, open: 100, high: 100, low: 100, close: 100, volume: 1_000, impliedVolatility })));

/** The scenarios' values, set here so their worked numbers hold whatever the code's defaults: a fixed 15% Step, Puts up to |delta| 0.20, a 365-day |delta| 0.70 LEAPS with no cap. */
const scenarioVolFarmerV2Settings: BacktestVolFarmerV2Settings = { ...defaultBacktestVolFarmerV2Settings, putMaxAbsDelta: 0.2, stepRule: "fixed", leapsMinDte: 365, leapsAbsDelta: 0.7, leapsMaxAccountPct: 0 };

describe("the v2 formulas", () => {
  it("puts a position's premiums against its shares' cost, each option for at most the shares held", () => {
    // 200 shares at 250.01, Calls on all of them that brought in $540 net: 250.01 − 2.70 = 247.31 a share.
    expect(volFarmerV2BreakEven({ shares: 200, costPerShare: 250.01, premiums: [{ legId: "c", dollars: 540, shares: 200 }] })).toBeCloseTo(247.31, 10);
    expect(volFarmerV2BreakEven({ shares: 0, costPerShare: 0, premiums: [{ legId: "p", dollars: 120, shares: 100 }] })).toBeNull();
    // PCG, 16 May 2022: 100 shares assigned at $12 after Puts of 25, 4, 18, 44 and 1 contracts ($645.94 net). Each Put counts
    // for the 100 shares held of those it covered: 12 − (145.50 ÷ 2,500 + 21.28 ÷ 400 + 167.76 ÷ 1,800 + 300.08 ÷ 4,400 +
    // 11.32 ÷ 100) = 12 − 0.386 = $11.61, not 12 − 645.94 ÷ 100 = $5.54.
    const pcgPuts = ([[25, 0.065], [4, 0.06], [18, 0.1], [44, 0.075], [1, 0.12]] as const).map(([contracts, fill], index) => ({ legId: `p${index}`, dollars: fill * 100 * contracts - 0.68 * contracts, shares: contracts * 100 }));
    expect(volFarmerV2BreakEven({ shares: 100, costPerShare: 12, premiums: pcgPuts })).toBeCloseTo(11.614, 3);
    // 2,800 shares at $50, $2,800 of Calls on all of them, then 2,300 called away: $49 on the 500 left, not 50 − 2,800 ÷ 500 = $44.40.
    expect(volFarmerV2BreakEven({ shares: 500, costPerShare: 50, premiums: [{ legId: "c", dollars: 2_800, shares: 2_800 }] })).toBeCloseTo(49, 10);
    // A Call on fewer shares than are held counts in full: 300 shares, a Call on 200 for $100: 50 − 100 ÷ 300.
    expect(volFarmerV2BreakEven({ shares: 300, costPerShare: 50, premiums: [{ legId: "c", dollars: 100, shares: 200 }] })).toBeCloseTo(50 - 100 / 300, 10);
    // A premium total saved before premiums were kept per option counts in full.
    expect(volFarmerV2BreakEven({ shares: 100, costPerShare: 12, premiums: [{ legId: "", dollars: 645.94, shares: 0 }] })).toBeCloseTo(5.5406, 4);
  });

  it("caps the Puts' strike a set share below the first break-even", () => {
    expect(volFarmerV2PutStrikeCap(246, 15)).toBeCloseTo(209.1, 10);
  });

  it("takes the one-month implied move as the Step, from the IV stored for the previous session only", () => {
    // IV 60%: 60 × √(21 ÷ 252) = 17.32% below the first break-even.
    expect(volFarmerV2ImpliedMoveStep(0.6).stepPct).toBeCloseTo(17.3205, 4);
    // IV on Monday 2 March, a bar without one on Tuesday 3rd, an IV of 0 on Wednesday 4th, no bar on Thursday 5th.
    const bars = barsWithImpliedVolatility([["2026-03-02", 0.5], ["2026-03-03", null], ["2026-03-04", 0]]);
    expect(previousSessionImpliedVolatility(bars, "2026-03-02")).toBe(0.5);
    // Monday's IV never stands in for a later session's missing one.
    expect(previousSessionImpliedVolatility(bars, "2026-03-03")).toBeNull();
    expect(previousSessionImpliedVolatility(bars, "2026-03-04")).toBeNull();
    expect(previousSessionImpliedVolatility(bars, "2026-03-05")).toBeNull();
    expect(previousSessionImpliedVolatility(bars, null)).toBeNull();
  });

  it("buys the LEAPS half a Step below B-E2", () => {
    // B-E2 $100, IV 60%: Step 17.32%, so the LEAPS is bought at $91.34 or lower.
    expect(volFarmerV2LeapsEntryPriceCap(100, volFarmerV2ImpliedMoveStep(0.6).stepPct / 2)).toBeCloseTo(91.3397, 4);
  });

  it("caps what a LEAPS spends at a share of the account", () => {
    // No cap: all the free cash. MSTR on 27 Oct 2025 with a 10% cap: min($96,142, 10% of $363,289) = $36,328.90, 3 contracts at $10,250.68.
    expect(volFarmerV2LeapsBudget(96_142, 363_289, 0)).toBe(96_142);
    expect(volFarmerV2LeapsBudget(96_142, 363_289, 10)).toBeCloseTo(36_328.9, 6);
    expect(contractsAffordable(volFarmerV2LeapsBudget(96_142, 363_289, 10), 102.5)).toBe(3);
    // Never more than the free cash.
    expect(volFarmerV2LeapsBudget(20_000, 363_289, 10)).toBe(20_000);
  });

  it("gives each ticker its allocation raised by the excess allowance, as Pluto does, and moves the tickers' turn one place a day", () => {
    const twentyFour = ["BABA", "BAC", "CSCO", "CVNA", "EWZ", "F", "GDX", "GLD", "INTC", "IWM", "MRVL", "NKE", "NOK", "ORCL", "PBR", "PCG", "PTON", "SLV", "TLT", "TQQQ", "UBER", "WMT", "XLE", "XLF"];
    // An equal share of 4.1667% raised by 26.3158%: 5.2632% each, $100,000 on $1,900,000, 126.3% together.
    const equal = volFarmerV2TickerShares(twentyFour, { tickerAllocationPct: {}, excessAllowancePct: 26.3158 });
    expect(equal.get("BABA")! * 1_900_000).toBeCloseTo(100_000, 0);
    expect([...equal.values()].reduce((total, share) => total + share, 0)).toBeCloseTo(1.263158, 6);
    // GDX set to 8% and TQQQ to 6%: the other 22 share the 86% left, 3.9091% each.
    const mixed = volFarmerV2TickerShares(twentyFour, { tickerAllocationPct: { GDX: 8, TQQQ: 6 }, excessAllowancePct: 0 });
    expect([mixed.get("GDX"), mixed.get("TQQQ")]).toEqual([0.08, 0.06]);
    expect(mixed.get("BABA")).toBeCloseTo(0.86 / 22, 12);
    // One ticker alone: all of the account.
    expect(volFarmerV2TickerShares(["GDX"], { tickerAllocationPct: {}, excessAllowancePct: 0 }).get("GDX")).toBe(1);
    expect(volFarmerV2TurnOrder(["XLF", "BAC", "CSCO"], 0)).toEqual(["BAC", "CSCO", "XLF"]);
    expect(volFarmerV2TurnOrder(["XLF", "BAC", "CSCO"], 1)).toEqual(["CSCO", "XLF", "BAC"]);
    expect(volFarmerV2TurnOrder(["XLF", "BAC", "CSCO"], 5)).toEqual(["XLF", "BAC", "CSCO"]);
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
  function lookSymbolOf(todayIso: string, stockPrice: number, expiry: string, leapsAskSize: number | null = 10, leapsExpiry = "2027-04-16", tickerSymbol = symbol): BacktestLookSymbol {
    const quotes = [...quotesAt({ todayIso, stockPrice, expiry, strikes: range(40, 140), right: "C" }), ...quotesAt({ todayIso, stockPrice, expiry, strikes: range(40, 140), right: "P" })];
    const leaps = quotesAt({ todayIso, stockPrice, expiry: leapsExpiry, strikes: range(30, 120), right: "C" }).map((quote) => ({ ...quote, askSize: leapsAskSize }));
    return {
      profile: { symbol: tickerSymbol, calendarChecksApply: false, earnings: [] },
      market: { todayIso, quotes, previousSessionVolumeByContract: new Map(quotes.map((quote) => [contractKey(quote), 1_000])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      adjustedDailyClosesBeforeToday: [],
      splitFactorToday: 1,
      optionContractsRepresentable: true,
      leapsCallQuotes: { listedExpiries: () => [expiry, leapsExpiry], quotesOf: (listed: string) => (listed === leapsExpiry ? leaps : quotes.filter((quote) => quote.right === "C")) },
    } as unknown as BacktestLookSymbol;
  }

  let actionNumber = 0;
  const nextActionId = () => `action-${++actionNumber}`;
  function look(ledger: SimulatedLedger, todayIso: string, stockPrice: number, expiry: string, more: Partial<BacktestVolFarmerV2Settings> = {}, leapsAskSize: number | null = 10, bars = barsWithImpliedVolatility([])) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...scenarioVolFarmerV2Settings, ...more } } as unknown as EffectiveBacktestSettings;
    return runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso, lookTimeEt: "10:00", symbols: [{ ...lookSymbolOf(todayIso, stockPrice, expiry, leapsAskSize), bars }], sectorBySymbol: new Map([[symbol, null]]), settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
  }
  /** A look of tickers sharing one account, each at its price: `prices` holds those at the look, `sessionSymbols` every one of the session. */
  function lookBook(ledger: SimulatedLedger, todayIso: string, prices: Record<string, number>, expiry: string, book: { sessionSymbols: string[]; sessionDayIndex: number; more: Partial<BacktestVolFarmerV2Settings> }) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...scenarioVolFarmerV2Settings, ...book.more } } as unknown as EffectiveBacktestSettings;
    const symbols = Object.entries(prices).map(([tickerSymbol, stockPrice]) => ({ ...lookSymbolOf(todayIso, stockPrice, expiry, 10, "2027-04-16", tickerSymbol), bars: barsWithImpliedVolatility([]) }));
    return runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso, lookTimeEt: "10:00", symbols, sectorBySymbol: new Map(book.sessionSymbols.map((tickerSymbol) => [tickerSymbol, null])), settings, ledger, priceByLegId: new Map(), nextActionId, sessionDayIndex: book.sessionDayIndex } as unknown as BacktestLookContext);
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

  it("buys the first position with the First position share of the pot and sells Puts on the rest", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    // 70% of $100,000: 6 lots at 100 ($60,000 and commission; a seventh would pass $70,000).
    const opened = await look(ledger, "2026-03-09", 100, "2026-03-13", { firstPositionPct: 70 });
    expect(opened.actions[0]!.description).toContain("with 600 shares bought @ 100.00");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const afterFall = await look(ledger, "2026-03-16", 80, "2026-03-20", { firstPositionPct: 70 });
    const put = afterFall.actions.find((action) => action.kind === "open_cash_secured_put")!;
    // The rest, 30% of the pot, secures floor(30,000 ÷ (strike × 100)) contracts.
    expect(put.quantity).toBe(Math.floor(30_000 / (put.contract!.strike! * 100)));
    expect(put.chosenBecause).toContain("on 30% of the pot");
  });

  it("takes the Step from the previous session's IV at each Put sale, and sells no Put without it", async () => {
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

    // At the Put sale the previous session's IV is Friday's 90%: 90 × √(21 ÷ 252) = 25.98%, so the Put is struck lower than
    // with the fixed 15%.
    const fixed = await putAfterFall("fixed", bars);
    const atSale = await putAfterFall("implied_move_at_put_sale", bars);
    expect(atSale.scores.stepPct).toBeCloseTo(90 * Math.sqrt(21 / 252), 10);
    expect(atSale.scores.stepImpliedVolatility).toBe(0.9);
    expect(atSale.put.contract!.strike).toBeLessThanOrEqual(volFarmerV2PutStrikeCap(atSale.firstBreakEven, atSale.scores.stepPct) + 0.01);
    expect(atSale.put.contract!.strike).toBeLessThan(fixed.put.contract!.strike!);
    expect(atSale.put.description).toContain("(Step 26.0%: IV 90.0% × √(21 ÷ 252))");

    // No IV for Friday 13 March, the session before the Put's day, with or without one on Thursday 12th: no Put, and the look
    // says why.
    for (const history of [barsWithImpliedVolatility([]), barsWithImpliedVolatility([["2026-03-06", 0.3], ["2026-03-12", 0.9]])]) {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
      await look(ledger, "2026-03-09", 100, "2026-03-13", { stepRule: "implied_move_at_put_sale" }, 10, history);
      settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
      const afterFall = await look(ledger, "2026-03-16", 80, "2026-03-20", { stepRule: "implied_move_at_put_sale" }, 10, history);
      expect(afterFall.actions.some((action) => action.kind === "open_cash_secured_put")).toBe(false);
      expect(afterFall.summary).toContain("but the previous session has no IV for the Step");
    }
  });

  it("buys a LEAPS with the free cash, up to the contracts its ask offers, tops it up to the count intended, and sells it whole once the second position is called away", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    // Monday 23 March at 55, far under both break-evens and more than half a Step below B-E2: the LEAPS. The free cash pays for
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
    // The next look tops it up with the same contract to the count the cash paid for at the purchase (its ask offers 10);
    // no new LEAPS is chosen for the same holding, and none is bought once the count is held.
    const topUp = (await look(ledger, "2026-03-24", 54, "2026-03-27")).actions.filter((action) => action.kind === "buy_leaps");
    expect(topUp.map((action) => action.quantity)).toEqual([affordable - 5]);
    expect(topUp[0]!.contract).toEqual(leaps.contract);
    expect(topUp[0]!.description).toContain(`LEAPS top-up: 5 of ${affordable} held`);
    expect(openOption(ledger, "call", "long").reduce((sum, leg) => sum + leg.quantity, 0)).toBe(affordable);
    expect((await look(ledger, "2026-03-25", 54, "2026-03-27")).actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);

    // Back up to 85 on Monday 30 March: the second position sells a Call, assigned at Friday's close at 90.
    const recovered = await look(ledger, "2026-03-30", 85, "2026-04-02");
    expect(recovered.actions.some((action) => action.description.includes("second position"))).toBe(true);
    const secondCallLeg = openOption(ledger, "call").find((leg) => leg.strikePrice! < 99)!;
    settleExpiry(ledger, { legId: secondCallLeg.id, expiryClose: 90 });
    // Both purchases are sold as one order.
    const afterCallAway = await look(ledger, "2026-04-06", 90, "2026-04-10");
    expect(afterCallAway.actions[0]).toMatchObject({ kind: "sell_leaps", quantity: affordable, contract: { strategyKey: "leaps", right: "C" } });
    expect(afterCallAway.actions.filter((action) => action.kind === "sell_leaps")).toHaveLength(1);
    expect(openOption(ledger, "call", "long")).toEqual([]);
    expect(describeVolFarmerV2Run(ledger, [symbol])).toMatch(new RegExp(`1 LEAPS trigger\\(s\\), 1 bought \\(${affordable}× on 2026-03-23\\)`));
  });

  it("buys and sells a LEAPS 33% of the half-spread past the mid, and values it at what selling it would bring", async () => {
    // The lab's default 33, about two-thirds of the way across the spread: bid $10, ask $13 buys at $11.995 and sells at $11.005.
    const leapsShare = scenarioVolFarmerV2Settings.leapsSpreadCostChargedPct / 100;
    expect(optionPurchaseFillPrice(10, 13, leapsShare)).toBeCloseTo(11.995, 10);
    expect(optionSaleFillPrice(10, 13, leapsShare)).toBeCloseTo(11.005, 10);
    const pastTheMid = (quote: { bid: number; ask: number }, side: 1 | -1) => (quote.bid + quote.ask) / 2 + (side * leapsShare * (quote.ask - quote.bid)) / 2;
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    // Monday 23 March at 55, quotes 2% either side of the mid: bought 33% of the half-spread above the mid, valued 33% of it
    // below.
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: scenarioVolFarmerV2Settings } as unknown as EffectiveBacktestSettings;
    const priceByLegId = new Map<string, number>();
    const bought = await runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso: "2026-03-23", lookTimeEt: "10:00", symbols: [{ ...lookSymbolOf("2026-03-23", 55, "2026-03-27", 100), bars: barsWithImpliedVolatility([]) }], sectorBySymbol: new Map([[symbol, null]]), settings, ledger, priceByLegId, nextActionId } as unknown as BacktestLookContext);
    const purchase = bought.actions.find((action) => action.kind === "buy_leaps")!;
    const purchaseQuote = purchase.candidateScores as { bid: number; ask: number };
    expect(purchase.fillPrice).toBeCloseTo(pastTheMid(purchaseQuote, 1), 10);
    expect(priceByLegId.get(openOption(ledger, "call", "long")[0]!.id)).toBeCloseTo(pastTheMid(purchaseQuote, -1), 10);
    // The second position's Call is assigned at Friday's close at 90: the LEAPS sells 33% of the half-spread below the mid.
    await look(ledger, "2026-03-30", 85, "2026-04-02");
    settleExpiry(ledger, { legId: openOption(ledger, "call").find((leg) => leg.strikePrice! < 99)!.id, expiryClose: 90 });
    const sale = (await look(ledger, "2026-04-06", 90, "2026-04-10")).actions.find((action) => action.kind === "sell_leaps")!;
    const saleQuote = sale.candidateScores as { bid: number; ask: number };
    expect(sale.fillPrice).toBeCloseTo(pastTheMid(saleQuote, -1), 10);
    // At 0, a LEAPS fills at the mid.
    const atMid = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(atMid, "2026-03-09", 100, "2026-03-13", { leapsSpreadCostChargedPct: 0 });
    settleExpiry(atMid, { legId: openOption(atMid, "call")[0]!.id, expiryClose: 99 });
    const putAtMid = (await look(atMid, "2026-03-16", 80, "2026-03-20", { leapsSpreadCostChargedPct: 0 })).actions[0]!;
    settleExpiry(atMid, { legId: openOption(atMid, "put")[0]!.id, expiryClose: putAtMid.contract!.strike! - 3 });
    const purchaseAtMid = (await look(atMid, "2026-03-23", 55, "2026-03-27", { leapsSpreadCostChargedPct: 0 }, 100)).actions.find((action) => action.kind === "buy_leaps")!;
    const quoteAtMid = purchaseAtMid.candidateScores as { bid: number; ask: number };
    expect(purchaseAtMid.fillPrice).toBeCloseTo((quoteAtMid.bid + quoteAtMid.ask) / 2, 10);
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

  it("buys the LEAPS once the price is half a Step below B-E2, whatever the Calls, and one a holding", async () => {
    // IV 60% on each session before a look: a Step of 17.32% for the Put and for the LEAPS entry, which waits for half of it.
    const bars = barsWithImpliedVolatility(["2026-03-06", "2026-03-13", "2026-03-20", "2026-03-23", "2026-03-24", "2026-03-25"].map((day): [string, number] => [day, 0.6]));
    const more = { stepRule: "implied_move_at_put_sale" as const };
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13", more, 10, bars);
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20", more, 10, bars)).actions[0]!;
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    const leapsBought = (result: Awaited<ReturnType<typeof look>>) => result.actions.filter((action) => action.kind === "buy_leaps");

    // At 90, above B-E2, the second position sells a Call and buys no LEAPS.
    const above = await look(ledger, "2026-03-23", 90, "2026-03-27", more, 100, bars);
    expect(leapsBought(above)).toEqual([]);
    const secondBreakEven = Number(/no LEAPS: the price 90\.00 is at or above B-E2 (\d+\.\d+)/.exec(above.summary)![1]);
    const expectedCap = volFarmerV2LeapsEntryPriceCap(secondBreakEven, volFarmerV2ImpliedMoveStep(0.6).stepPct / 2);
    // Between B-E2 less half the Step and B-E2 it waits, and the note gives the price it waits for.
    const waiting = await look(ledger, "2026-03-24", Math.round((expectedCap + secondBreakEven) * 50) / 100, "2026-03-27", more, 100, bars);
    expect(leapsBought(waiting)).toEqual([]);
    const priceCap = Number(/is above B-E2 \d+\.\d+ less half the Step 17\.3% \(IV 60\.0% × √\(21 ÷ 252\)\): (\d+\.\d+)/.exec(waiting.summary)![1]);
    expect(priceCap).toBeCloseTo(expectedCap, 1);
    // Under it the LEAPS is bought beside the second position's open Call, the reason in its description; a lower price
    // later buys no other for the same holding.
    const bought = leapsBought(await look(ledger, "2026-03-25", Math.floor(priceCap) - 1, "2026-03-27", more, 100, bars));
    expect(bought).toHaveLength(1);
    expect(bought[0]!.description).toContain(`at or below the second position's break-even ${secondBreakEven.toFixed(2)} less half the Step 17.3%`);
    expect(leapsBought(await look(ledger, "2026-03-26", Math.floor(priceCap) - 10, "2026-03-27", more, 100, bars))).toEqual([]);
  });

  it("makes no LEAPS entry without the previous session's IV, however low the price", async () => {
    // IV for the Put's day only (Friday 13 March); none for Tuesday 24 March, the session before the look at 40.
    const more = { stepRule: "implied_move_at_put_sale" as const };
    const bars = barsWithImpliedVolatility([["2026-03-13", 0.6]]);
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13", more, 10, bars);
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
    const put = (await look(ledger, "2026-03-16", 80, "2026-03-20", more, 10, bars)).actions[0]!;
    expect(put.kind).toBe("open_cash_secured_put");
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    const result = await look(ledger, "2026-03-25", 40, "2026-03-27", more, 100, bars);
    expect(result.actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);
    expect(result.summary).toContain("no LEAPS: the previous session has no IV for the Step");
  });

  it("never buys or tops up a LEAPS with the price at or above B-E2, even when no Call fits", async () => {
    const withSecondPosition = async () => {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
      await look(ledger, "2026-03-09", 100, "2026-03-13");
      settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
      const put = (await look(ledger, "2026-03-16", 80, "2026-03-20")).actions[0]!;
      settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
      return ledger;
    };
    // A look whose next expiry's Calls all bid $0.01, under the $0.05 a Call needs: neither position finds one, whatever the price.
    const lookWithoutCalls = (ledger: SimulatedLedger, todayIso: string, stockPrice: number, expiry: string) => {
      const symbolLook = lookSymbolOf(todayIso, stockPrice, expiry);
      const market = { ...symbolLook.market, quotes: symbolLook.market.quotes.map((quote) => (quote.right === "C" && quote.expiry === expiry ? { ...quote, bid: 0.01 } : quote)) };
      const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: scenarioVolFarmerV2Settings } as unknown as EffectiveBacktestSettings;
      return runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso, lookTimeEt: "10:00", symbols: [{ ...symbolLook, market, bars: barsWithImpliedVolatility([]) }], sectorBySymbol: new Map([[symbol, null]]), settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
    };

    // At 80, above B-E2 (the Put was struck at most 85 and kept its premium), no Call fits but no LEAPS is bought.
    const ledger = await withSecondPosition();
    const aboveBreakEven = await lookWithoutCalls(ledger, "2026-03-23", 80, "2026-03-27");
    expect(aboveBreakEven.actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);
    expect(aboveBreakEven.summary).toMatch(/no LEAPS: the price 80\.00 is at or above B-E2 \d+\.\d+/);
    expect((await lookWithoutCalls(ledger, "2026-03-24", 60, "2026-03-27")).actions.filter((action) => action.kind === "buy_leaps")).toHaveLength(1);

    // Bought short of its count at 55 (5 offered), the top-up waits while the price is at or above B-E2, then goes ahead below it.
    const shortLedger = await withSecondPosition();
    expect((await look(shortLedger, "2026-03-23", 55, "2026-03-27", {}, 5)).actions.filter((action) => action.kind === "buy_leaps").map((action) => action.quantity)).toEqual([5]);
    const recovered = await look(shortLedger, "2026-03-24", 85, "2026-03-27");
    expect(recovered.actions.filter((action) => action.kind === "buy_leaps")).toEqual([]);
    expect(recovered.summary).toMatch(/LEAPS top-up: waits, the price 85\.00 is at or above B-E2 \d+\.\d+ \(5 of \d+ held\)/);
    expect((await look(shortLedger, "2026-03-25", 60, "2026-03-27")).actions.filter((action) => action.kind === "buy_leaps").map((action) => action.description)).toEqual([expect.stringContaining("LEAPS top-up: 5 of")]);
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
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...scenarioVolFarmerV2Settings, looks: "every_look" } } as unknown as EffectiveBacktestSettings;
    // The 10:00 capture at 100; the 10:30 look's own quotes at 90.
    const tenOClock = lookSymbolOf("2026-03-09", 100, "2026-03-13");
    const later = lookSymbolOf("2026-03-09", 90, "2026-03-13");
    const lookSymbol = { ...tenOClock, bars: barsWithImpliedVolatility([]), intraday: { quotes: later.market.quotes, stockPrice: 90 } } as BacktestLookSymbol;
    const result = await runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso: "2026-03-09", lookTimeEt: "10:30", symbols: [lookSymbol], sectorBySymbol: new Map([[symbol, null]]), settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
    expect(result.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    // Half the pot at 90: floor(50,000 ÷ 9,000.50) = 5 lots, bought at the look's price.
    expect(result.actions[0]!.description).toContain("with 500 shares bought @ 90.00");
    expect(result.actions[0]!.lookTimeEt).toBe("10:30");
    expect(result.actions[0]!.at).toBe(easternInstant("2026-03-09", 10, 30).toISOString());
    expect(result.breakEvenLevels![0]!.lookTimeEt).toBe("10:30");
  });

  /** A 10:00 look with the Calls and Puts of `strikes` on each of `expiries`, at the day's split factor. */
  function lookWithExpiries(ledger: SimulatedLedger, input: { todayIso: string; stockPrice: number; expiries: string[]; strikes: number[]; splitFactorToday?: number; more?: Partial<BacktestVolFarmerV2Settings> }) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...scenarioVolFarmerV2Settings, ...input.more } } as unknown as EffectiveBacktestSettings;
    const quotes = input.expiries.flatMap((expiry) => (["C", "P"] as const).flatMap((right) => quotesAt({ todayIso: input.todayIso, stockPrice: input.stockPrice, expiry, strikes: input.strikes, right })));
    const lookSymbol = lookSymbolOf(input.todayIso, input.stockPrice, input.expiries[0]!);
    const market = { ...lookSymbol.market, quotes, previousSessionVolumeByContract: new Map(quotes.map((quote) => [contractKey(quote), 1_000])) };
    return runVolFarmerV2Look({ calendar: weekdayCalendar, todayIso: input.todayIso, lookTimeEt: "10:00", symbols: [{ ...lookSymbol, market, splitFactorToday: input.splitFactorToday ?? 1, bars: barsWithImpliedVolatility([]) }], sectorBySymbol: new Map([[symbol, null]]), settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
  }

  it("trades on through a 3-for-1 split, its cycle started on the scale every contract fits", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    // The session sets it each day: with a 3-for-1 ahead, a cycle started at F = 3 takes F = 1.
    ledger.newCycleSplitFactorBySymbol.set(symbol, 1);
    // Before the split, at 150: 3 lots (300 shares), 900 of the cycle's shares, 300 of them a contract.
    const opened = await lookWithExpiries(ledger, { todayIso: "2026-03-09", stockPrice: 150, expiries: ["2026-03-13"], strikes: range(120, 200), splitFactorToday: 3 });
    expect(opened.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    expect(opened.actions[0]!.description).toContain("with 300 shares bought @ 150.00");
    const firstBreakEven = breakEvenIn(opened.actions[0]!.description, "first");
    const call = openOption(ledger, "call")[0]!;
    expect([call.quantity, call.multiplier]).toEqual([3, 300]);
    // It expires worthless on the last day before the split (the close on the cycle's scale: 149 as traded ÷ 3).
    settleExpiry(ledger, { legId: call.id, expiryClose: 149 / 3 });
    // The split: a contract is now 100 of the cycle's shares, a whole number.
    expect(alignOpenOptionLegsToSplitFactor(ledger, symbol, 1).representable).toBe(true);
    // After it, at 50: a Call on each of the 9 lots the 900 shares now make, 100 shares a contract.
    const after = await lookWithExpiries(ledger, { todayIso: "2026-03-16", stockPrice: 50, expiries: ["2026-03-20"], strikes: range(40, 70) });
    expect(after.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    expect(after.actions[0]!.description).toContain("on held shares");
    const newCall = openOption(ledger, "call")[0]!;
    expect([newCall.quantity, newCall.multiplier]).toEqual([9, 100]);
    // B-E¹ as traded is the one before the split ÷ 3 (before the new Call's premium; the description's has 2 decimals).
    expect((after.actions[0]!.candidateScores as { breakEvenFirst: number }).breakEvenFirst).toBeCloseTo(firstBreakEven / 3, 2);
    expect(`${opened.summaryOfActions} ${after.summaryOfActions}`).not.toContain("split");
  });

  it("tells the shares called away as traded, on a cycle whose scale is not the day's", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    ledger.newCycleSplitFactorBySymbol.set(symbol, 1);
    await lookWithExpiries(ledger, { todayIso: "2026-03-09", stockPrice: 150, expiries: ["2026-03-13"], strikes: range(120, 200), splitFactorToday: 3 });
    // Assigned at a 160 close (160 ÷ 3 on the cycle's scale): 300 shares as traded, 900 of the cycle's.
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 160 / 3 });
    // The cycle has ended: a new one would start on today's scale, but the note reads the ended cycle's.
    ledger.newCycleSplitFactorBySymbol.set(symbol, 3);
    const next = await lookWithExpiries(ledger, { todayIso: "2026-03-16", stockPrice: 160, expiries: ["2026-03-20"], strikes: range(120, 200), splitFactorToday: 3 });
    expect(next.summaryOfActions).toContain("the first position's Call was assigned: 300 shares called away");
  });

  it("sells on the next expiry only: with no Call there that passes, the Puts start though a later expiry has one", async () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    await look(ledger, "2026-03-09", 100, "2026-03-13");
    settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 92 });
    // Wednesday 18 March at 90: the Calls of Friday 20 March at or above B-E¹ (about 99) have |delta| under 0.05; those of
    // Friday 3 April, 16 days out, do not, and are not sold.
    const result = await lookWithExpiries(ledger, { todayIso: "2026-03-18", stockPrice: 90, expiries: ["2026-03-20", "2026-04-03"], strikes: range(40, 140) });
    expect(result.summaryOfActions).toContain("first position: no Call at or above its break-even");
    expect(result.actions.map((action) => `${action.kind} ${action.contract?.expiry}`)).toEqual(["open_cash_secured_put 2026-03-20"]);
  });

  describe("tickers sharing one account", () => {
    // Two tickers on an equal share (50%) with an 80% excess allowance: each cycle's pot 90% of the account, the pots adding
    // up to 180%, the LEAPS capped at 10% of a ticker's share.
    const book = (sessionDayIndex: number) => ({ sessionSymbols: ["VFA", "VFB"], sessionDayIndex, more: { excessAllowancePct: 80, leapsMaxAccountPct: 10 } });

    it("sizes each ticker from its share of the account and cuts what the free cash can't cover, the turn moving each day", async () => {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
      // Monday 9 March at 100, day 0, VFA's turn first: each buys floor(90% of the account ÷ 2 ÷ 10,000.50) = 4 lots;
      // VFB, second, sizes from the account's value, not from the cash VFA left.
      const opened = await lookBook(ledger, "2026-03-09", { VFA: 100, VFB: 100 }, "2026-03-13", book(0));
      expect(opened.actions.map((action) => [action.symbol, action.kind])).toEqual([
        ["VFA", "open_covered_call"],
        ["VFB", "open_covered_call"],
      ]);
      for (const action of opened.actions) expect(action.description).toContain("with 400 shares bought @ 100.00");
      expect(opened.shortfalls).toBeUndefined();
      for (const leg of openOption(ledger, "call")) settleExpiry(ledger, { legId: leg.id, expiryClose: 99 });

      // Monday 16 March at 80, day 5, VFB's turn first: both want Puts on half their pot, $45,000 of strikes, with about
      // $20,000 free. VFB sells what the free cash secures, VFA after it none; both cuts are recorded.
      const freeCash = ledgerFreeCash(ledger);
      const afterFall = await lookBook(ledger, "2026-03-16", { VFA: 80, VFB: 80 }, "2026-03-20", book(5));
      expect(afterFall.summary.indexOf("VFB: ")).toBeLessThan(afterFall.summary.indexOf("VFA: "));
      const puts = afterFall.actions.filter((action) => action.kind === "open_cash_secured_put");
      expect(puts.map((action) => action.symbol)).toEqual(["VFB"]);
      const strike = puts[0]!.contract!.strike!;
      expect(puts[0]!.quantity).toBe(Math.floor(freeCash / (strike * 100)));
      expect(puts[0]!.description).toContain(`the free cash (${formatWholeDollars(freeCash)}) secures ${puts[0]!.quantity} of the`);
      const cutOf = (tickerSymbol: string) => afterFall.shortfalls!.find((row) => row.symbol === tickerSymbol)!;
      expect(cutOf("VFB")).toMatchObject({ step: "budget_put", right: "P", reason: "cash", filledContracts: puts[0]!.quantity, lookCount: 1 });
      expect(cutOf("VFB").wantedContracts).toBeGreaterThan(puts[0]!.quantity!);
      // VFA's pot is 90% of the account when it opened first, all cash: half of it wants floor(45,000 ÷ (strike × 100)).
      expect(cutOf("VFA")).toMatchObject({ step: "budget_put", right: "P", reason: "cash", filledContracts: 0, wantedContracts: Math.floor(45_000 / (strike * 100)), bestCandidate: { strike } });
      expect(ledgerFreeCash(ledger)).toBeLessThan(strike * 100);
      expect(afterFall.summary).toContain(`secures no contract of the ${strike} Put`);
    });

    it("buys a ticker's LEAPS after every ticker's new cycle and Puts, which have the free cash first", async () => {
      const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
      // VFA alone at first (VFB has no look yet): 4 lots at 100, Puts after the fall to 80, assigned.
      await lookBook(ledger, "2026-03-09", { VFA: 100 }, "2026-03-13", book(0));
      settleExpiry(ledger, { legId: openOption(ledger, "call")[0]!.id, expiryClose: 99 });
      const put = (await lookBook(ledger, "2026-03-16", { VFA: 80 }, "2026-03-20", book(5))).actions.find((action) => action.kind === "open_cash_secured_put")!;
      settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });

      // Monday 23 March, day 10, VFA's turn first: at 55, more than half a Step below its B-E2, VFA's LEAPS is due; VFB, flat
      // at 50, opens a cycle. The cycle takes the lots the free cash pays for, fewer than half its pot wants, and only
      // then does VFA's LEAPS spend what is left, below its cap.
      const freeCash = ledgerFreeCash(ledger);
      const lotCost = 50 * 100 + stockCommissionDollars(100);
      const looked = await lookBook(ledger, "2026-03-23", { VFA: 55, VFB: 50 }, "2026-03-27", book(10));
      const opening = looked.actions.findIndex((action) => action.symbol === "VFB" && action.kind === "open_covered_call");
      const lots = Math.floor(freeCash / lotCost);
      expect(looked.actions[opening]!.description).toContain(`with ${lots * 100} shares bought @ 50.00`);
      expect(looked.shortfalls).toEqual([expect.objectContaining({ symbol: "VFB", step: "entry", right: "C", reason: "cash", filledContracts: lots })]);
      expect(looked.shortfalls![0]!.wantedContracts).toBeGreaterThan(lots);
      const call = looked.actions[opening]!;
      const leftAfterVfb = freeCash - lots * 100 * 50 - stockCommissionDollars(lots * 100) + call.fillPrice! * 100 * call.quantity! - optionCommissionDollars(call.quantity!);
      const leaps = looked.actions.findIndex((action) => action.kind === "buy_leaps");
      expect(leaps).toBeGreaterThan(opening);
      expect(looked.actions[leaps]!.quantity).toBe(contractsAffordable(leftAfterVfb, looked.actions[leaps]!.fillPrice!));
      expect(looked.actions[leaps]!.description).toContain("of its share of the account");
      expect(describeVolFarmerV2Run(ledger, ["VFA", "VFB"])).toMatch(/VFA: .*1 look\(s\) at which the account's free cash held it below its cap \(first on 2026-03-23\)/);
    });
  });
});
