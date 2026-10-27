import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { blackScholesDelta, blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, type BacktestVolFarmerV2Settings, type EffectiveBacktestSettings } from "../backtestTypes.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { chooseVolFarmerV2Leaps, contractsAffordable, describeVolFarmerV2Run, runVolFarmerV2Look, volFarmerV2BreakEven, volFarmerV2PutStrikeCap } from "./backtestVolFarmerV2Look.js";
import { expirySettlementInstant, settleExpiry } from "./ledger/ledgerEvents.js";
import { ledgerFreeCash } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

describe("the v2 formulas", () => {
  it("puts a position's premiums against its shares' cost", () => {
    // 200 shares at 250.01, Calls that brought in $540 net: 250.01 − 2.70 = 247.31 a share.
    expect(volFarmerV2BreakEven({ shares: 200, costPerShare: 250.01, premiumDollars: 540 })).toBeCloseTo(247.31, 10);
    expect(volFarmerV2BreakEven({ shares: 0, costPerShare: 0, premiumDollars: 120 })).toBeNull();
  });

  it("caps the Puts' strike a set share below the first break-even", () => {
    expect(volFarmerV2PutStrikeCap(246, 15)).toBeCloseTo(209.1, 10);
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
  function look(ledger: SimulatedLedger, todayIso: string, stockPrice: number, expiry: string, more: Partial<BacktestVolFarmerV2Settings> = {}, leapsAskSize: number | null = 10) {
    const settings = { trading: { spreadCostChargedPct: 0 }, volFarmer: defaultBacktestVolFarmerSettings, volFarmerV2: { ...defaultBacktestVolFarmerV2Settings, ...more } } as unknown as EffectiveBacktestSettings;
    return runVolFarmerV2Look({ todayIso, lookTimeEt: "10:00", symbols: [lookSymbolOf(todayIso, stockPrice, expiry, leapsAskSize)], settings, ledger, priceByLegId: new Map(), nextActionId } as unknown as BacktestLookContext);
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

    // Assigned at Friday's close: Monday 23 March the second position sells its own Call, at or above its own break-even.
    settleExpiry(ledger, { legId: openOption(ledger, "put")[0]!.id, expiryClose: put.contract!.strike! - 3 });
    const assigned = await look(ledger, "2026-03-23", put.contract!.strike! - 2, "2026-03-27");
    const secondCall = assigned.actions.find((action) => action.description.includes("second position"))!;
    expect(secondCall.kind).toBe("open_covered_call");
    const secondShares = put.quantity! * 100;
    const putNet = put.fillPrice! * secondShares - 0.68 * put.quantity!;
    const callNet = secondCall.fillPrice! * secondShares - 0.68 * put.quantity!;
    expect(breakEvenIn(secondCall.description, "second")).toBeCloseTo(put.contract!.strike! - (putNet + callNet) / secondShares, 2);
    expect(assigned.actions.some((action) => action.kind === "open_cash_secured_put")).toBe(false);
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
});
