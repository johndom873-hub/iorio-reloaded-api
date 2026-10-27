import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { defaultBacktestVolFarmerSettings, type BacktestVolFarmerSettings, type EffectiveBacktestSettings } from "../backtestTypes.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { chooseVolFarmerPut, findVolFarmerCrossing, runVolFarmerLook, scanVolFarmerCrossing, volFarmerCycleNet, volFarmerHedgeSurplus, volFarmerOptionValue, volFarmerPutCostPerYear, volFarmerProtection, type VolFarmerPutCandidate } from "./backtestVolFarmerLook.js";
import { buyHedgePut, closeCoveredCall, expirySettlementInstant, openCoveredCall, sellHedgePut, settleExpiry } from "./ledger/ledgerEvents.js";
import { ledgerOpenHedgeLegs, ledgerRealizedPnl } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

const commissionPerShare = 0.0068;

describe("volFarmerOptionValue", () => {
  it("prices a Put as Black-Scholes on the forward and floors it at intrinsic value", () => {
    // S 100, K 100, 45 days, IV 30%, r 4%: 3.95 (the figure the formula was approved on).
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 100, strike: 100, yearsToExpiry: 45 / 365, riskFreeRate: 0.04, impliedVolatility: 0.3 })).toBeCloseTo(3.95, 2);
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 80, strike: 100, yearsToExpiry: 0, riskFreeRate: 0.04, impliedVolatility: 0.3 })).toBe(20);
    // Deep in the money a European Put is worth less than its intrinsic value; a listed (American) one is not.
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 50, strike: 100, yearsToExpiry: 1, riskFreeRate: 0.05, impliedVolatility: 0.1 })).toBe(50);
  });
});

describe("volFarmerHedgeSurplus", () => {
  it("passes an ATM Put when the stock reaches the Call's strike on its expiry day", () => {
    // S 100, $103 Call 7 days out, $100 Put 45 days out at IV 60%: the Put loses 1.90 of its 8.12 against the shares' +3.
    const put = { strike: 100, costPerShare: 8.12 + commissionPerShare, impliedVolatility: 0.6, yearsLeftAtCallExpiry: 38 / 365 };
    const surplus = volFarmerHedgeSurplus({ callStrike: 103, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 });
    expect(surplus).toBeCloseTo(3 - 1.9 - 2 * commissionPerShare, 1);
    expect(surplus).toBeGreaterThan(0);
  });

  it("fails when the Put's decay to the Call's expiry is more than the shares make", () => {
    // A $100.50 Call 14 days out: +0.50 from the shares, far less than a 14-day ATM Put at IV 60% loses to time.
    const put = { strike: 100, costPerShare: 3.25 + commissionPerShare, impliedVolatility: 0.6, yearsLeftAtCallExpiry: 0 };
    expect(volFarmerHedgeSurplus({ callStrike: 100.5, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 })).toBeLessThan(0);
  });

  it("counts the cycle's realized Put P&L and the shares' cost", () => {
    const put = { strike: 90, costPerShare: 1, impliedVolatility: 0.4, yearsLeftAtCallExpiry: 30 / 365 };
    const base = volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 });
    expect(volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 6, riskFreeRate: 0.04 })).toBeCloseTo(base + 6, 10);
    expect(volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 98, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 })).toBeCloseTo(base + 2, 10);
  });
});

describe("volFarmerProtection", () => {
  it("is the share of a fall the Put offsets after its cost", () => {
    // 45-day ATM Put at IV 30% costs 3.95; a 20% fall within 7 days leaves it worth its intrinsic 20 (the European value is
    // just below): (20 − 3.95 − 0.0068) ÷ 20 = 80%.
    const put = { strike: 100, costPerShare: 3.95, impliedVolatility: 0.3, yearsLeftAtCallExpiry: 38 / 365 };
    expect(volFarmerProtection({ stockPrice: 100, fallFraction: 0.2, put, riskFreeRate: 0.04 })).toBeCloseTo(0.802, 3);
  });
});

describe("chooseVolFarmerPut", () => {
  // Days to expiry from Friday 6 March 2026, a week before the Call's expiry.
  const putQuote = (expiry: string, strike: number, fillPrice: number, impliedVolatility: number): VolFarmerPutCandidate => ({ expiry, dte: Math.round((Date.parse(expiry) - Date.parse("2026-03-06")) / 86_400_000), strike, bid: fillPrice - 0.05, ask: fillPrice + 0.05, fillPrice, impliedVolatility });
  const look = { callStrike: 103, callExpiry: "2026-03-13", shareCostPerShare: 100, realizedHedgePnlPerShare: 0, stockPrice: 100, fallFraction: 0.2, riskFreeRate: 0.04 };

  it("takes the Put with the most protection among those that pass, never one expiring before the Call", () => {
    const puts = [putQuote("2026-03-06", 100, 1.2, 0.3), putQuote("2026-03-13", 100, 1.62, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3), putQuote("2026-04-17", 95, 1.9, 0.3), putQuote("2027-03-05", 100, 9.78, 0.3)];
    const chosen = chooseVolFarmerPut({ ...look, puts })!;
    expect(chosen.put.expiry).toBe("2026-03-13");
    expect(chosen.put.strike).toBe(100);
    expect(chosen.surplus).toBeGreaterThanOrEqual(0);
    expect(chosen.protection).toBeGreaterThan(volFarmerProtection({ stockPrice: 100, fallFraction: 0.2, put: { strike: 100, costPerShare: 3.95 + commissionPerShare, impliedVolatility: 0.3, yearsLeftAtCallExpiry: 35 / 365 }, riskFreeRate: 0.04 }));
  });

  it("returns null when no Put passes the hedge rule", () => {
    // A Put priced far above its value: its loss at the strike is more than the shares' +3.
    expect(chooseVolFarmerPut({ ...look, puts: [putQuote("2026-03-13", 100, 9, 0.3)] })).toBeNull();
  });

  it("keeps to the Call's expiry with sameExpiry, where a longer Put would protect more", () => {
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts })!.put.expiry).toBe("2026-04-17");
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true })!.put).toMatchObject({ expiry: "2026-03-13", strike: 95 });
  });

  it("refuses Puts below the least protection asked for", () => {
    // The March 95 Put offsets (95 − 80 − 0.41) ÷ 20 = 73% of a 20% fall; the April 100 Put about 80%.
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true, minProtection: 0.75 })).toBeNull();
    expect(chooseVolFarmerPut({ ...look, puts, minProtection: 0.75 })!.put.expiry).toBe("2026-04-17");
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true, minProtection: 0 })!.put.strike).toBe(95);
  });

  it("takes the cheapest per year with putChoice cheapest_per_year: a longer Put at the same strike, though it protects less", () => {
    // $100 Puts at IV 30%: 42 days @ 3.95 costs (395 + 0.68) ÷ 10,000 ÷ (42 ÷ 365) = 34.4% a year, 196 days @ 8.80 costs 16.4%.
    const puts = [putQuote("2026-04-17", 100, 3.95, 0.3), putQuote("2026-09-18", 100, 8.8, 0.3)];
    expect(volFarmerPutCostPerYear(puts[0]!, 100)).toBeCloseTo(0.3439, 4);
    expect(volFarmerPutCostPerYear(puts[1]!, 100)).toBeCloseTo(0.164, 4);
    expect(chooseVolFarmerPut({ ...look, puts })!.put.expiry).toBe("2026-04-17");
    const cheapest = chooseVolFarmerPut({ ...look, puts, choice: "cheapest_per_year" })!;
    expect(cheapest.put.expiry).toBe("2026-09-18");
    // A 20% fall leaves it worth its intrinsic 20: (20 − 8.8068 − 0.0068) ÷ 20 = 55.9%, against 80% for the 42-day Put.
    expect(cheapest.protection).toBeCloseTo(0.5593, 4);
    // The least protection asked for still rules a Put out first.
    expect(chooseVolFarmerPut({ ...look, puts, choice: "cheapest_per_year", minProtection: cheapest.protection + 0.001 })!.put.expiry).toBe("2026-04-17");
  });

  it("reads no hedge rule with no Call: a Put that would fail it at the strike passes, with no surplus", () => {
    // 42 days @ 9.00 at IV 30% loses far more than the shares' +3 at a $103 strike.
    const puts = [putQuote("2026-04-17", 100, 9, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts })).toBeNull();
    expect(chooseVolFarmerPut({ ...look, callStrike: null, puts, choice: "cheapest_per_year" })).toMatchObject({ put: { expiry: "2026-04-17" }, surplus: null });
  });

  it("keeps within the Put budget, taking the most protection inside it", () => {
    // A Call sold at 1.00 with a 100% budget: the 3.95 April Put is out, the March 95 Put at 0.40 is in.
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-03-13", 97, 1.2, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 1 })!.put).toMatchObject({ expiry: "2026-03-13", strike: 95 });
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 1.2 })!.put).toMatchObject({ expiry: "2026-03-13", strike: 97 });
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 0.3 })).toBeNull();
  });
});

describe("findVolFarmerCrossing", () => {
  const bar = (startMinutesEt: number, open: number, high: number) => ({ startMinutesEt, open, high, close: open });

  it("crosses in the first bar whose high reaches the strike, at the strike, in the bar's middle", () => {
    const crossing = findVolFarmerCrossing([bar(600, 100, 101), bar(630, 101, 103.2), bar(660, 103, 104)], 103)!;
    expect(crossing.bar.startMinutesEt).toBe(630);
    expect(crossing.price).toBe(103);
    expect(crossing.minutesEt).toBe(645);
    expect(crossing.gapped).toBe(false);
  });

  it("fills at the open when the bar opened past the strike", () => {
    const crossing = findVolFarmerCrossing([bar(570, 106, 107)], 103)!;
    expect(crossing).toMatchObject({ price: 106, minutesEt: 570, gapped: true });
  });

  it("finds none below the strike", () => {
    expect(findVolFarmerCrossing([bar(570, 100, 102.99)], 103)).toBeNull();
  });
});

describe("volFarmerCycleNet", () => {
  const start = easternInstant("2026-03-09", 10, 0);
  const openCycle = () => {
    const ledger = createSimulatedLedger(100_000, start);
    const coveredCall = openCoveredCall(ledger, { symbol: "VFT", expiryDate: "2026-03-13", strike: 105, contracts: 1, callFillPrice: 1.2, stockFillPrice: 100, at: start, actionId: null, splitFactorToday: 1 });
    const put = buyHedgePut(ledger, { symbol: "VFT", expiryDate: "2026-06-19", strike: 95, contracts: 1, fillPrice: 4, at: start, actionId: null });
    return { ledger, coveredCall, put };
  };
  const closingAt = (prices: { stock: number; call: number; put: number | null }) => (leg: LedgerLeg) => (leg.legType === "stock" ? prices.stock : leg.optionType === "call" ? prices.call : prices.put);

  it("is what unwinding there realizes: shares, Call and Put, each commission once", () => {
    // 100 shares at 100.005 (commission in), the $105 Call sold at 1.20, the $95 Put bought at 4.00. Closed at 105, the
    // Call bought back at 2.50 and the Put sold at 2.60: shares 499.50 − 0.50, Call −130.68 − 0.68, Put −140.68 − 0.68.
    const { ledger, coveredCall, put } = openCycle();
    const net = volFarmerCycleNet({ ledger, symbol: "VFT", cycleStartedAt: start, priceToCycleScale: 1, closePriceOf: closingAt({ stock: 105, call: 2.5, put: 2.6 }) })!;
    expect(net.shares).toBeCloseTo(499, 6);
    expect(net.calls).toBeCloseTo(-131.36, 6);
    expect(net.puts).toBeCloseTo(-141.36, 6);
    expect(net.total).toBeCloseTo(226.28, 6);
    const at = easternInstant("2026-03-11", 11, 15);
    closeCoveredCall(ledger, { positionId: coveredCall.positionId, callFillPrice: 2.5, stockFillPrice: 105, at, actionId: null });
    sellHedgePut(ledger, { legId: put.legId, contracts: 1, fillPrice: 2.6, at, actionId: null });
    expect(ledger.cash - 100_000).toBeCloseTo(net.total, 6);
  });

  it("counts what the cycle realized before: an expired Call, the shares handed between positions at their cost", () => {
    const { ledger, coveredCall, put } = openCycle();
    settleExpiry(ledger, { legId: coveredCall.callLegId, expiryClose: 103 });
    const secondCall = openCoveredCall(ledger, { symbol: "VFT", expiryDate: "2026-03-20", strike: 106, contracts: 1, callFillPrice: 0.9, stockFillPrice: null, at: easternInstant("2026-03-16", 10, 0), actionId: null, splitFactorToday: 1 });
    // Calls: the first kept (1.20 − 0.0068) × 100 = +119.32, the second (0.8932 − 1.50) × 100 − 0.68 = −61.36.
    const net = volFarmerCycleNet({ ledger, symbol: "VFT", cycleStartedAt: start, priceToCycleScale: 1, closePriceOf: closingAt({ stock: 106, call: 1.5, put: 1.8 }) })!;
    expect(net.calls).toBeCloseTo(119.32 - 61.36, 6);
    expect(net.shares).toBeCloseTo(599, 6);
    expect(net.puts).toBeCloseTo(-221.36, 6);
    const at = easternInstant("2026-03-18", 12, 0);
    closeCoveredCall(ledger, { positionId: secondCall.positionId, callFillPrice: 1.5, stockFillPrice: 106, at, actionId: null });
    sellHedgePut(ledger, { legId: put.legId, contracts: 1, fillPrice: 1.8, at, actionId: null });
    expect(ledger.cash - 100_000).toBeCloseTo(net.total, 6);
  });

  it("is null when a leg has no price", () => {
    const { ledger } = openCycle();
    expect(volFarmerCycleNet({ ledger, symbol: "VFT", cycleStartedAt: start, priceToCycleScale: 1, closePriceOf: closingAt({ stock: 105, call: 2.5, put: null }) })).toBeNull();
  });
});

describe("the VF4 rules at the looks", () => {
  const symbol = "VFT";
  const riskFreeRate = 0.04;
  const vf4: Partial<BacktestVolFarmerSettings> = { callExpiry: "next", putMinDte: 90, crossing: "unwind_if_net_positive", hedgeAfterExpiry: "sell_if_in_profit", afterAssignment: "continue_if_under_water", hedgeRuleStockPnl: "included" };
  const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  /** Black-Scholes quotes at `volatility` on the forward, 2% either side of the mid, priced at `timeEt` on `todayIso`. */
  function quotesAt(input: { todayIso: string; timeEt?: [number, number]; stockPrice: number; expiries: string[]; strikes: number[]; right: "C" | "P"; volatility: number }): SymbolFileQuote[] {
    const atMs = easternInstant(input.todayIso, ...(input.timeEt ?? [10, 0])).getTime();
    return input.expiries.flatMap((expiry) =>
      input.strikes.map((strike) => {
        const years = (expirySettlementInstant(expiry).getTime() - atMs) / (365 * 86_400_000);
        const mid = blackScholesPriceOnForward(input.stockPrice * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, input.volatility, input.right === "C");
        return { expiry, strike, right: input.right, bid: round4(mid * 0.98), ask: round4(mid * 1.02), bidSize: 10, askSize: 10 };
      }),
    );
  }

  /** The look's symbol: the Calls as its quotes, the Puts as its hedge Put quotes; with intradayStockPrice, a later look's. */
  function lookSymbolOf(input: { todayIso: string; stockPrice: number; calls: SymbolFileQuote[]; puts: SymbolFileQuote[]; laterLook?: boolean }): BacktestLookSymbol {
    const putExpiries = [...new Set(input.puts.map((quote) => quote.expiry))].sort();
    return {
      profile: { symbol, calendarChecksApply: false, earnings: [] },
      market: { todayIso: input.todayIso, quotes: input.calls, openInterestByContract: new Map(), previousSessionVolumeByContract: new Map(input.calls.map((quote) => [contractKey(quote), 1_000])), stockPrice: input.stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
      adjustedDailyClosesBeforeToday: [],
      splitFactorToday: 1,
      optionContractsRepresentable: true,
      hedgePutQuotes: { listedExpiries: () => putExpiries, quotesOf: (expiry: string) => input.puts.filter((quote) => quote.expiry === expiry) },
      ...(input.laterLook ? { intraday: { quotes: input.calls, stockPrice: input.stockPrice } } : {}),
    } as unknown as BacktestLookSymbol;
  }

  let actionNumber = 0;
  const nextActionId = () => `action-${++actionNumber}`;
  function look(ledger: SimulatedLedger, todayIso: string, lookSymbol: BacktestLookSymbol, lookTimeEt = "10:00", more: Partial<BacktestVolFarmerSettings> = {}) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: { ...defaultBacktestVolFarmerSettings, ...vf4, ...more } } as unknown as EffectiveBacktestSettings;
    return runVolFarmerLook({ todayIso, lookTimeEt, symbols: [lookSymbol], settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
  }

  /** Monday 9 March at 100: Calls of 13 and 20 March, Puts of 17 April (39 days) and 19 June (102 days), all at IV 50%. */
  async function openedCycle(more: Partial<BacktestVolFarmerSettings> = {}) {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-09", 9, 30));
    const calls = quotesAt({ todayIso: "2026-03-09", stockPrice: 100, expiries: ["2026-03-13", "2026-03-20"], strikes: range(101, 115), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-09", stockPrice: 100, expiries: ["2026-04-17", "2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.5 });
    const opened = await look(ledger, "2026-03-09", lookSymbolOf({ todayIso: "2026-03-09", stockPrice: 100, calls, puts }), "10:00", more);
    const callLeg = ledger.legs.find((leg) => leg.legType === "option" && leg.optionType === "call" && leg.exitAt === null)!;
    const putLeg = ledgerOpenHedgeLegs(ledger, symbol)[0]!;
    return { ledger, opened, callLeg, putLeg };
  }

  it("sells a Call of the next expiry only, with a Put of 90 days or more (rules 1 and 5)", async () => {
    const { opened, callLeg, putLeg } = await openedCycle();
    expect(opened.actions.map((action) => action.kind)).toEqual(["open_covered_call", "buy_hedge"]);
    expect(callLeg.expiryDate).toBe("2026-03-13");
    expect(putLeg.expiryDate).toBe("2026-06-19");
    expect(opened.actions[1]!.candidateScores!.hedgeSurplusPerShare).toBeGreaterThanOrEqual(0);
  });

  it("holds at a crossing that would lose the cycle money, then unwinds at the first look that nets a gain (rule 2)", async () => {
    const { ledger, callLeg, putLeg } = await openedCycle();
    const strike = callLeg.strikePrice!;
    // Tuesday's 10:00 look reads the Put at IV 30%: at the strike the shares' gain is less than the Call's and the Put's losses.
    const tuesdayCalls = quotesAt({ todayIso: "2026-03-10", stockPrice: 101, expiries: ["2026-03-13", "2026-03-20"], strikes: range(101, 115), right: "C", volatility: 0.5 });
    const tuesdayPuts = quotesAt({ todayIso: "2026-03-10", stockPrice: 101, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.3 });
    expect((await look(ledger, "2026-03-10", lookSymbolOf({ todayIso: "2026-03-10", stockPrice: 101, calls: tuesdayCalls, puts: tuesdayPuts }))).actions).toEqual([]);
    const bars = [
      { startMinutesEt: 600, open: 101, high: 101.5, close: 101.4 },
      { startMinutesEt: 630, open: 101.4, high: 102, close: 101.9 },
      { startMinutesEt: 660, open: 101.9, high: strike + 0.5, close: strike + 0.2 },
      { startMinutesEt: 690, open: strike + 0.2, high: strike + 0.8, close: strike + 0.5 },
    ];
    const scan = (throughEt: string) => scanVolFarmerCrossing({ ledger, symbol, todayIso: "2026-03-10", adjustedBars: bars, splitFactorToday: 1, throughEt, riskFreeRate, priceByLegId: new Map(), nextActionId, onlyIfCycleNetPositive: true });
    const held = scan("11:30")!;
    expect(held.actions).toEqual([]);
    expect(held.lookTimeEt).toBe("11:15");
    expect(held.summary).toMatch(/^Held at the crossing: VFT reached .* in the 11:00 bar; unwinding there would net the cycle −\$/);
    // The held Call's strike is not scanned for again.
    expect(scan("12:00")).toBeNull();
    // At 14:00 the Put trades at IV 70% with the stock above the strike: the cycle nets a gain, so everything is closed at the look's mids.
    const stockPrice = strike + 0.5;
    const laterCalls = quotesAt({ todayIso: "2026-03-10", timeEt: [14, 0], stockPrice, expiries: ["2026-03-13", "2026-03-20"], strikes: range(101, 115), right: "C", volatility: 0.5 });
    const laterPuts = quotesAt({ todayIso: "2026-03-10", timeEt: [14, 0], stockPrice, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.7 });
    const unwound = await look(ledger, "2026-03-10", lookSymbolOf({ todayIso: "2026-03-10", stockPrice, calls: laterCalls, puts: laterPuts, laterLook: true }), "14:00");
    expect(unwound.actions.map((action) => action.kind)).toEqual(["close_position", "sell_hedge"]);
    const callQuote = laterCalls.find((quote) => quote.expiry === callLeg.expiryDate && quote.strike === strike)!;
    const putQuote = laterPuts.find((quote) => quote.strike === putLeg.strikePrice)!;
    expect(unwound.actions[0]!.fillPrice).toBeCloseTo((callQuote.bid! + callQuote.ask!) / 2, 10);
    expect(unwound.actions[1]!.fillPrice).toBeCloseTo((putQuote.bid! + putQuote.ask!) / 2, 10);
    expect(unwound.summary).toMatch(/^Unwound at the 14:00 look: /);
    expect(ledger.legs.filter((leg) => leg.exitAt === null)).toEqual([]);
    // The net it unwound on is what the cycle made.
    expect(ledger.cash - 100_000).toBeCloseTo(Number(unwound.actions[0]!.candidateScores!.cycleNetDollars), 6);
  });

  it("after a Call expired below its strike, sells a Put in profit with a new Call and a new Put (rule 3)", async () => {
    const { ledger, callLeg, putLeg } = await openedCycle();
    settleExpiry(ledger, { legId: callLeg.id, expiryClose: 99 });
    // Monday 16 March at 99, the Puts at IV 60%: the $100 Put held is worth more than it cost.
    const calls = quotesAt({ todayIso: "2026-03-16", stockPrice: 99, expiries: ["2026-03-20", "2026-03-27"], strikes: range(100, 115), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-16", stockPrice: 99, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.6 });
    const result = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice: 99, calls, puts }));
    expect(result.actions.map((action) => action.kind)).toEqual(["sell_hedge", "open_covered_call", "buy_hedge"]);
    expect(result.actions[0]!.contract).toMatchObject({ expiry: "2026-06-19", strike: putLeg.strikePrice });
    expect(result.actions[1]!.contract!.expiry).toBe("2026-03-20");
    expect(result.actions[2]!.contract!.strike).toBeLessThanOrEqual(99);
  });

  it("after a Call expired below its strike, keeps a Put that is not in profit and sells the Call with it (rule 3)", async () => {
    const { ledger, callLeg, putLeg } = await openedCycle();
    settleExpiry(ledger, { legId: callLeg.id, expiryClose: 99 });
    const calls = quotesAt({ todayIso: "2026-03-16", stockPrice: 99, expiries: ["2026-03-20", "2026-03-27"], strikes: range(100, 115), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-16", stockPrice: 99, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.4 });
    const result = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice: 99, calls, puts }));
    expect(result.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
    expect(result.actions[0]!.contract!.expiry).toBe("2026-03-20");
    expect(ledgerOpenHedgeLegs(ledger, symbol).map((leg) => leg.id)).toEqual([putLeg.id]);
  });

  it("after the shares were called away under water, buys them back, keeps the Put and sells the next Call (rule 4)", async () => {
    const { ledger, callLeg, putLeg } = await openedCycle();
    const strike = callLeg.strikePrice!;
    settleExpiry(ledger, { legId: callLeg.id, expiryClose: strike + 1 });
    // The Put at IV 20%: it lost more than the shares made at the strike.
    const stockPrice = strike + 2;
    const calls = quotesAt({ todayIso: "2026-03-16", stockPrice, expiries: ["2026-03-20", "2026-03-27"], strikes: range(Math.ceil(stockPrice) + 1, Math.ceil(stockPrice) + 20), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-16", stockPrice, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.2 });
    const result = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice, calls, puts }));
    expect(result.actions.map((action) => action.kind)).toEqual(["buy_shares", "open_covered_call"]);
    expect(result.actions[0]).toMatchObject({ quantity: callLeg.quantity * 100, fillPrice: stockPrice });
    expect(result.actions[0]!.candidateScores!.cycleNetDollars).toBeLessThan(0);
    expect(result.actions[1]!.contract!.expiry).toBe("2026-03-20");
    expect(ledgerOpenHedgeLegs(ledger, symbol).map((leg) => leg.id)).toEqual([putLeg.id]);
  });

  it("keeps shares with no Put and no Call that passes hedged: the cheapest Put per year offering the least protection (hedgeWithoutCall cheapest_per_year)", async () => {
    const { ledger, callLeg, putLeg } = await openedCycle();
    settleExpiry(ledger, { legId: callLeg.id, expiryClose: 95 });
    // The Put is gone, as after its own expiry: the shares are left without a hedge.
    sellHedgePut(ledger, { legId: putLeg.id, contracts: putLeg.quantity, fillPrice: 12, at: easternInstant("2026-03-13", 15, 0), actionId: null });
    // Monday 16 March at 85, far below what the shares cost: no next-week Call passes the hedge rule with any Put.
    const calls = quotesAt({ todayIso: "2026-03-16", stockPrice: 85, expiries: ["2026-03-20", "2026-03-27"], strikes: range(86, 100), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-16", stockPrice: 85, expiries: ["2026-06-19", "2026-09-18", "2027-01-15"], strikes: range(60, 85), right: "P", volatility: 0.5 });
    const result = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice: 85, calls, puts }), "10:00", { putChoice: "cheapest_per_year", minPutProtectionPct: 30, hedgeWithoutCall: "cheapest_per_year", putMaxDte: 540 });
    expect(result.actions.map((action) => action.kind)).toEqual(["buy_hedge"]);
    const bought = result.actions[0]!;
    expect(bought.chosenBecause).toBe("vol farmer: shares with no Call that qualifies keep a Put: of those offering at least 30% protection, the cheapest per year");
    // At one IV the longest expiry is the cheapest per year; it still offers the 30% asked for.
    expect(bought.contract!.expiry).toBe("2027-01-15");
    expect(Number(bought.candidateScores!.protection)).toBeGreaterThanOrEqual(0.3);
    expect(bought.description).toMatch(/; costs \d+% a year; no Call qualifies, the shares stay hedged\)$/);
    expect(bought.quantity).toBe(callLeg.quantity);
  });

  it("after the shares were called away with the cycle in profit, sells the Put and ends the cycle (rule 4)", async () => {
    const { ledger, callLeg } = await openedCycle();
    const strike = callLeg.strikePrice!;
    settleExpiry(ledger, { legId: callLeg.id, expiryClose: strike + 1 });
    const stockPrice = strike + 1;
    const calls = quotesAt({ todayIso: "2026-03-16", stockPrice, expiries: ["2026-03-20"], strikes: range(Math.ceil(stockPrice) + 1, Math.ceil(stockPrice) + 15), right: "C", volatility: 0.5 });
    const puts = quotesAt({ todayIso: "2026-03-16", stockPrice, expiries: ["2026-06-19"], strikes: range(80, 100), right: "P", volatility: 0.5 });
    const result = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice, calls, puts }));
    expect(result.actions.map((action) => action.kind)).toEqual(["sell_hedge"]);
    expect(result.summary).toMatch(/, so the cycle ends$/);
    expect(ledger.legs.filter((leg) => leg.exitAt === null)).toEqual([]);
  });

  describe("hedge none", () => {
    const noHedge: Partial<BacktestVolFarmerSettings> = { hedge: "none", hedgeWithoutCall: "cheapest_per_year", putChoice: "cheapest_per_year", minPutProtectionPct: 30 };

    it("opens a cycle with the shares and a Call, no Put: lots = free cash less the reserve ÷ (100 × price + commission)", async () => {
      const { ledger, opened } = await openedCycle(noHedge);
      expect(opened.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
      // floor(100,000 × 0.9 ÷ (100 × 100 + 0.50)) = 8 lots.
      expect(opened.actions[0]!.quantity).toBe(8);
      expect(ledgerOpenHedgeLegs(ledger, symbol)).toEqual([]);
      expect(opened.actions[0]!.chosenBecause).toMatch(/^vol farmer: the highest premium yield whose strike passes the hedge rule on the shares alone \(no hedge\)/);
    });

    it("sells the next Call only at or above what the shares cost, and buys no Put when none passes", async () => {
      const { ledger, callLeg } = await openedCycle(noHedge);
      settleExpiry(ledger, { legId: callLeg.id, expiryClose: 95 });
      const stockLeg = ledger.legs.find((leg) => leg.legType === "stock" && leg.exitAt === null)!;
      // Monday 16 March at 95: next-week Calls from 96 to 104 all sit below what the shares cost, so none is sold.
      const low = quotesAt({ todayIso: "2026-03-16", stockPrice: 95, expiries: ["2026-03-20", "2026-03-27"], strikes: range(96, 99), right: "C", volatility: 0.5 });
      const puts = quotesAt({ todayIso: "2026-03-16", stockPrice: 95, expiries: ["2026-06-19"], strikes: range(80, 95), right: "P", volatility: 0.5 });
      const none = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice: 95, calls: low, puts }), "10:00", noHedge);
      expect(none.actions).toEqual([]);
      expect(none.summary).toMatch(/^VFT: no Call passes the hedge rule on the shares alone \(shares at 100\.\d+\)/);
      // Tuesday at 99: the first Call by premium yield at or above the shares' cost is sold.
      const calls = quotesAt({ todayIso: "2026-03-17", stockPrice: 99, expiries: ["2026-03-20"], strikes: range(100, 106), right: "C", volatility: 0.5 });
      const sold = await look(ledger, "2026-03-17", lookSymbolOf({ todayIso: "2026-03-17", stockPrice: 99, calls, puts }), "10:00", noHedge);
      expect(sold.actions.map((action) => action.kind)).toEqual(["open_covered_call"]);
      expect(sold.actions[0]!.contract!.strike).toBeGreaterThanOrEqual(stockLeg.entryPrice);
      expect(ledgerOpenHedgeLegs(ledger, symbol)).toEqual([]);
    });
  });

  describe("putCashIn when_no_call", () => {
    // R5's hedge (the cheapest Put per year offering 30% of a 20% fall, kept by shares with no Call) with the cash-in.
    const r5CashIn: Partial<BacktestVolFarmerSettings> = { putChoice: "cheapest_per_year", minPutProtectionPct: 30, putMaxDte: 540, hedgeWithoutCall: "cheapest_per_year", putCashIn: "when_no_call", cashInPutMinProtectionPct: 30 };
    const r5Keep: Partial<BacktestVolFarmerSettings> = { ...r5CashIn, putCashIn: "none" };
    const putsAt = (todayIso: string, stockPrice: number, volatility = 0.5) => quotesAt({ todayIso, stockPrice, expiries: ["2026-06-19", "2026-09-18"], strikes: range(60, 100), right: "P", volatility });

    /** The cycle opened at 100 and its Call expired below its strike; Monday 16 March at `stockPrice`, next-week Calls up to 88. */
    async function mondayLook(more: Partial<BacktestVolFarmerSettings>, stockPrice = 80, putVolatility = 0.5) {
      const { ledger, callLeg, putLeg } = await openedCycle(more);
      settleExpiry(ledger, { legId: callLeg.id, expiryClose: 95 });
      const calls = quotesAt({ todayIso: "2026-03-16", stockPrice, expiries: ["2026-03-20", "2026-03-27"], strikes: range(81, 100).filter((strike) => strike > stockPrice && strike <= 88), right: "C", volatility: 0.5 });
      const monday = await look(ledger, "2026-03-16", lookSymbolOf({ todayIso: "2026-03-16", stockPrice, calls, puts: putsAt("2026-03-16", stockPrice, putVolatility) }), "10:00", more);
      return { ledger, putLeg, monday };
    }

    /** Tuesday 17 March at 90: Calls of 20 March from 91 to 100. */
    function tuesdayLook(ledger: SimulatedLedger, more: Partial<BacktestVolFarmerSettings>) {
      const calls = quotesAt({ todayIso: "2026-03-17", stockPrice: 90, expiries: ["2026-03-20"], strikes: range(91, 100), right: "C", volatility: 0.5 });
      return look(ledger, "2026-03-17", lookSymbolOf({ todayIso: "2026-03-17", stockPrice: 90, calls, puts: putsAt("2026-03-17", 90) }), "10:00", more);
    }

    it("sells the Put in profit when no Call is sold, and hedges the shares with a new Put at the cash-in's floor", async () => {
      const { ledger, putLeg, monday } = await mondayLook({ ...r5CashIn, cashInPutMinProtectionPct: 40 });
      expect(monday.actions.map((action) => action.kind)).toEqual(["sell_hedge", "buy_hedge"]);
      const [sale, purchase] = monday.actions;
      expect(sale!.contract).toMatchObject({ expiry: putLeg.expiryDate, strike: putLeg.strikePrice });
      expect(sale!.chosenBecause).toBe("vol farmer: no Call is sold with the Put in profit; it is sold so its gain lowers the strike the hedge rule asks of a Call, and the shares get a new Put");
      expect(ledger.legs.find((leg) => leg.id === putLeg.id)!.exitAt).not.toBeNull();
      // What the sale realized is what the cycle's Put P&L now holds.
      expect(ledgerRealizedPnl(ledger, putLeg.positionId).total).toBeCloseTo(Number(sale!.candidateScores!.gainDollars), 6);
      expect(Number(sale!.candidateScores!.gainDollars)).toBeGreaterThan(0);
      expect(purchase!.chosenBecause).toBe("vol farmer: the lots a cash-in left without a Put keep one: of those offering at least 40% protection, the cheapest per year");
      expect(Number(purchase!.candidateScores!.protection)).toBeGreaterThanOrEqual(0.4);
      expect(purchase!.quantity).toBe(putLeg.quantity);
      expect(monday.summary).toMatch(/^VFT: no Call passes the hedge rule with the Put held and expires by it \(shares at [\d.]+\) · VFT Sell .* \(hedge cashed in: no Call sold; its gain of \$[\d,]+ counts in the hedge rule from the next look\) · VFT Buy /);
    });

    it("keeps a Put that would not sell at a gain", async () => {
      // Monday at 95 with the Puts at IV 30%: no Call passes, and the Put held is worth less than it cost.
      const { ledger, putLeg, monday } = await mondayLook(r5CashIn, 95, 0.3);
      expect(monday.actions).toEqual([]);
      expect(ledgerOpenHedgeLegs(ledger, symbol).map((leg) => leg.id)).toEqual([putLeg.id]);
    });

    it("lets the next look's Call pass below what the shares cost: the cash-in's gain lowers their breakeven", async () => {
      // Kept, the Put leaves no Call passing on Monday or Tuesday.
      const kept = await mondayLook(r5Keep);
      expect(kept.monday.actions).toEqual([]);
      expect((await tuesdayLook(kept.ledger, r5Keep)).actions.filter((action) => action.kind === "open_covered_call")).toEqual([]);
      // Cashed in on Monday, its gain lets Tuesday's Call pass at a strike below what the shares cost.
      const { ledger, putLeg, monday } = await mondayLook(r5CashIn);
      expect(monday.actions.map((action) => action.kind)).toEqual(["sell_hedge", "buy_hedge"]);
      const stockLeg = ledger.legs.find((leg) => leg.legType === "stock" && leg.exitAt === null)!;
      const breakEven = stockLeg.entryPrice - ledgerRealizedPnl(ledger, putLeg.positionId).total / stockLeg.quantity;
      const call = (await tuesdayLook(ledger, r5CashIn)).actions.find((action) => action.kind === "open_covered_call")!;
      expect(call.contract!.strike).toBeLessThan(stockLeg.entryPrice);
      expect(call.contract!.strike).toBeGreaterThan(breakEven);
      expect(call.chosenBecause).toContain(`the cycle's Puts sold or expired +$`);
      expect(call.chosenBecause).toContain(`so the shares break even at ${breakEven.toFixed(2)}`);
    });
  });
});
