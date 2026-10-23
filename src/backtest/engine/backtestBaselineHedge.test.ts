import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import type { OpenCycleSummary } from "../../lib/cycleBreakEven.js";
import { defaultBacktestBaselineSettings, type BacktestAction, type BacktestBaselineSettings } from "../backtestTypes.js";
import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { BaselineHedgeSteps, hedgeCoverageRatio, hedgePutExpiry, hedgePutQuote, hedgePutQuoteByDelta, realizedVolatility21, summarizeHedge, typicalYearlyFall, withHedgeInBreakEven, type HedgePutQuoteSource } from "./backtestBaselineHedge.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buyHedgePut, openCashSecuredPut, openCoveredCall, sellHedgePut, sellShares, settleExpiry, settleHedgePut } from "./ledger/ledgerEvents.js";
import { ledgerCycles, ledgerKeptHedgeLegs, ledgerOpenHedgeLegs, ledgerRealizedPnl } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, isSymbolFlat, legsOfPosition, requireLeg, requirePosition, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// The hedge's long Puts (backtestBaselineHedge.ts): the ledger's events, the sizing, expiry and strike rules, the
// break-even with the hedge's P&L, and the steps at a look. Commissions: $0.68 per option contract, $0.005 per share.

const at = (dateIso: string, hour = 10, minute = 0) => easternInstant(dateIso, hour, minute);
const newLedger = () => createSimulatedLedger(500_000, easternInstant("2021-11-01", 9, 30));
const journalTotal = (ledger: SimulatedLedger) => ledger.cashJournal.reduce((sum, entry) => sum + entry.amount, 0);

/** 600 NFLX shares bought at $687 with 6 Calls $700 sold at 4.43 (a Covered Call entry): the cycle the hedge needs. */
function coveredCallEntry(ledger: SimulatedLedger, contracts = 6) {
  return openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-05", strike: 700, contracts, callFillPrice: 4.43, stockFillPrice: 687, at: at("2021-11-01"), actionId: "action-entry", splitFactorToday: 10 });
}

describe("the hedge's ledger events", () => {
  it("buys long Puts into a hedge position at the fill plus the commission per share", () => {
    // 6 Puts $690 at 83.30: cost 83.30 × 600 = 49,980, commission 6 × 0.68 = 4.08, entry 83.30 + 4.08 ÷ 600 = 83.3068.
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const cashBefore = ledger.cash;
    const { positionId, legId } = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: "action-hedge" });

    expect(requirePosition(ledger, positionId)).toMatchObject({ symbol: "NFLX", strategyKey: "hedge", status: "open", closeReason: null });
    expect(requireLeg(ledger, legId)).toMatchObject({ legType: "option", side: "long", optionType: "put", quantity: 6, multiplier: 100, strikePrice: 690, expiryDate: "2022-09-16", exitAt: null });
    expect(requireLeg(ledger, legId).entryPrice).toBeCloseTo(83.3068, 10);
    expect(ledger.cash).toBeCloseTo(cashBefore - 49_980 - 4.08, 6);
    expect(journalTotal(ledger)).toBeCloseTo(ledger.cash, 6);
    expect(ledger.trades.at(-1)).toMatchObject({ legId, side: "buy", quantity: 6, price: 83.3, isClosingTrade: false, actionId: "action-hedge" });
    expect(ledger.trades.at(-1)!.commission).toBeCloseTo(4.08, 10);
  });

  it("never starts a cycle, and refuses a contract a short option holds", () => {
    const ledger = newLedger();
    expect(() => buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null })).toThrow(/only while the cycle is open/);
    coveredCallEntry(ledger);
    expect(() => buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2021-11-05", strike: 700, contracts: 1, fillPrice: 20, at: at("2021-11-01"), actionId: null })).toThrow(/one position per contract/);
  });

  it("adds a second purchase of a held contract to its hedge position as a leg of its own", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const first = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 5, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    const second = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 1, fillPrice: 85, at: at("2021-11-01", 10, 30), actionId: null });
    expect(second.positionId).toBe(first.positionId);
    expect(second.legId).not.toBe(first.legId);
    expect(ledgerOpenHedgeLegs(ledger, "NFLX").map((leg) => leg.quantity)).toEqual([5, 1]);
  });

  it("sells part of a leg as a carved closed leg, and closes the position and the cycle with its last contract", () => {
    // 6 bought at 83.30 (entry 83.3068); 3 sold at 467.48: proceeds 140,244 less 2.04 commission, P&L (467.48 − 83.3068) × 300 − 2.04 = 115,249.92.
    const ledger = newLedger();
    const entry = coveredCallEntry(ledger);
    const { positionId, legId } = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    const cashBefore = ledger.cash;
    const partial = sellHedgePut(ledger, { legId, contracts: 3, fillPrice: 467.48, at: at("2022-04-25"), actionId: "action-rung" });

    expect(partial.positionClosed).toBe(false);
    expect(requireLeg(ledger, partial.soldLegId)).toMatchObject({ parentLegId: legId, quantity: 3, exitPrice: 467.48 });
    expect(requireLeg(ledger, legId)).toMatchObject({ quantity: 3, exitAt: null });
    expect(ledger.cash).toBeCloseTo(cashBefore + 140_244 - 2.04, 6);
    expect(ledgerRealizedPnl(ledger, positionId).total).toBeCloseTo((467.48 - 83.3068) * 300 - 2.04, 6);

    // The call expires worthless and the shares are sold: the hedge alone keeps the cycle open until its last Put goes.
    settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 645.72 });
    const sharesLeg = ledger.legs.find((leg) => leg.legType === "stock" && leg.exitAt === null)!;
    sellShares(ledger, { positionId: sharesLeg.positionId, shares: 600, fillPrice: 230, at: at("2022-09-08"), actionId: null });
    expect(isSymbolFlat(ledger, "NFLX")).toBe(false);
    const last = sellHedgePut(ledger, { legId, contracts: 3, fillPrice: 446.82, at: at("2022-09-09"), actionId: null });
    expect(last.positionClosed).toBe(true);
    expect(requirePosition(ledger, positionId)).toMatchObject({ status: "closed", closeReason: "closed_via_app" });
    expect(isSymbolFlat(ledger, "NFLX")).toBe(true);
    expect(legsOfPosition(ledger, positionId).every((leg) => leg.exitAt !== null)).toBe(true);
    expect(journalTotal(ledger)).toBeCloseTo(ledger.cash, 6);
  });

  it("settles a Put still held at expiry: at its intrinsic value without commission in the money, worthless otherwise", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const inTheMoney = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 2, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    const outOfTheMoney = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 200, contracts: 1, fillPrice: 2, at: at("2021-11-01"), actionId: null });
    const cashBefore = ledger.cash;
    expect(settleHedgePut(ledger, { legId: inTheMoney.legId, expiryClose: 240.13 })).toBe("hedge_sold_at_intrinsic");
    expect(requireLeg(ledger, inTheMoney.legId)).toMatchObject({ exitPrice: 449.87, expiryClose: 240.13, exitAt: easternInstant("2022-09-16", 16, 0) });
    expect(ledger.cash).toBeCloseTo(cashBefore + 449.87 * 200, 6);
    expect(ledger.trades.at(-1)).toMatchObject({ side: "sell", quantity: 2, commission: 0, isClosingTrade: true });
    expect(settleHedgePut(ledger, { legId: outOfTheMoney.legId, expiryClose: 240.13 })).toBe("hedge_worthless");
    expect(requireLeg(ledger, outOfTheMoney.legId)).toMatchObject({ exitPrice: 0, settledAs: "worthless" });
    expect(requirePosition(ledger, outOfTheMoney.positionId)).toMatchObject({ status: "closed", closeReason: "expired_worthless" });
  });

  it("puts the hedge in the cycle's own bucket, out of its premium and break-even", () => {
    // Shares 600 at 687 (+ commission 3), call premium 4.43 × 600 − 4.08; the hedge's 6 Puts cost 49,984.08 and are marked at 100.
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const hedge = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    const [cycle] = ledgerCycles(ledger, "NFLX", { dailyCloses: [{ date: "2021-11-01", close: 687 }], optionMarkByLegId: new Map([[hedge.legId, 100]]) });
    expect(cycle!.buckets.hedge.total).toBeCloseTo(100 * 600 - (83.3 * 600 + 4.08), 6);
    expect(cycle!.breakEvenPerShare).toBeCloseTo((687 * 600 + 3 - (4.43 * 600 - 4.08)) / 600, 6);
  });
});

describe("the hedge's rules", () => {
  const settings = (values: Partial<BacktestBaselineSettings>) => ({ ...defaultBacktestBaselineSettings, putsWhenNoCall: "reserve_ladder" as const, ladderSharesPct: 60, ladderRungs: 2, ...values });

  it("sizes the Puts at share level, a share of it, or the rung level (at most one Put per 100 shares)", () => {
    expect(hedgeCoverageRatio(settings({ hedgePutSize: "share_level", hedgePutCoveragePct: 100 }), 0.7)).toBe(1);
    expect(hedgeCoverageRatio(settings({ hedgePutSize: "share_level", hedgePutCoveragePct: 50 }), 0.7)).toBe(0.5);
    // (1 − 0.6) ÷ (0.6 × (2 − 0.7)) = 0.4 ÷ 0.78 = 0.5128: $144,137 a rung at its $446.52 cap is 3.2 contracts, the $432,412 budget at $686.95 is 6.3 lots.
    expect(hedgeCoverageRatio(settings({ hedgePutSize: "rung_level", hedgePutCoveragePct: 100 }), 0.7)).toBeCloseTo(0.4 / 0.78, 10);
    // One rung at the floor: 0.4 ÷ (0.6 × 0.3) = 2.2 Puts per lot, capped at one.
    expect(hedgeCoverageRatio(settings({ hedgePutSize: "rung_level", ladderRungs: 1 }), 0.7)).toBe(1);
    expect(hedgeCoverageRatio(settings({ hedgePutSize: "rung_level", putsWhenNoCall: "off" }), 0.7)).toBe(1);
  });

  it("picks the expiry nearest the days (a tie: the later) or the first at or after them, past the days left to roll at", () => {
    // NFLX on 2021-11-01: 81, 109, 137, 228, 319 and 445 days out.
    const listed = ["2022-01-21", "2022-02-18", "2022-03-18", "2022-06-17", "2022-09-16", "2023-01-20"];
    const pick = (hedgePutTenorDays: number, hedgePutExpiry: "nearest" | "first_at_or_after") => hedgePutExpiry === "nearest" ? hedgePutExpiryOf(listed, hedgePutTenorDays, "nearest") : hedgePutExpiryOf(listed, hedgePutTenorDays, "first_at_or_after");
    function hedgePutExpiryOf(expiries: string[], days: number, rule: "nearest" | "first_at_or_after") {
      return hedgePutExpiry(expiries, "2021-11-01", { hedgePutTenorDays: days, hedgePutExpiry: rule, hedgePutRollDaysLeft: 7 });
    }
    expect([90, 180, 360].map((days) => pick(days, "nearest"))).toEqual(["2022-01-21", "2022-03-18", "2022-09-16"]);
    expect([90, 180, 360].map((days) => pick(days, "first_at_or_after"))).toEqual(["2022-02-18", "2022-06-17", "2023-01-20"]);
    // 95 days sits between 81 and 109: 14 either way, the later wins.
    expect(pick(95, "nearest")).toBe("2022-02-18");
    expect(hedgePutExpiry(["2021-11-05", "2021-11-12"], "2021-11-01", { hedgePutTenorDays: 90, hedgePutExpiry: "nearest", hedgePutRollDaysLeft: 7 })).toBe("2021-11-12");
    expect(hedgePutExpiry([], "2021-11-01", { hedgePutTenorDays: 90, hedgePutExpiry: "nearest", hedgePutRollDaysLeft: 7 })).toBeNull();
  });

  it("buys the listed strike nearest the target with a usable quote and no short option on it", () => {
    const quote = (strike: number, bid: number | null, ask: number | null): SymbolFileQuote => ({ expiry: "2022-09-16", strike, right: "P", bid, ask, bidSize: 10, askSize: 10 });
    const quotes = [quote(680, 75.75, 79.7), quote(690, 81.05, 85.55), quote(700, 0, 90), quote(650, 60, 200)];
    expect(hedgePutQuote(quotes, 686.95, 50, () => false)?.strike).toBe(690);
    expect(hedgePutQuote(quotes, 686.95, 50, (strike) => strike === 690)?.strike).toBe(680);
    // 700 has no bid and 650 a spread of 108% of its mid: neither is bought.
    expect(hedgePutQuote(quotes, 700, 50, (strike) => strike === 690 || strike === 680)).toBeNull();
    // A tie between 680 and 690: the higher strike.
    expect(hedgePutQuote(quotes, 685, 50, () => false)?.strike).toBe(690);
  });

  it("buys by delta the Put whose own |delta| is nearest the target", () => {
    // $100 stock, 1 year, r 0, Puts priced at 40% IV: |delta| 0.2243 at $80, 0.2722 at $85, so 0.25 → $85 and 0.22 → $80.
    const quotes: SymbolFileQuote[] = [70, 75, 80, 85, 90, 95, 100].map((strike) => {
      const price = blackScholesPriceOnForward(100, strike, 1, 0, 0.4, false);
      return { expiry: "2022-11-01", strike, right: "P", bid: price - 0.05, ask: price + 0.05, bidSize: 10, askSize: 10 };
    });
    const pick = (absDelta: number) => hedgePutQuoteByDelta(quotes, { stockPrice: 100, yearsToExpiry: 1, riskFreeRate: 0, absDelta }, 50, () => false);
    expect(pick(0.25)?.quote.strike).toBe(85);
    expect(pick(0.25)?.absDelta).toBeCloseTo(0.2722, 3);
    expect(pick(0.22)?.quote.strike).toBe(80);
    expect(hedgePutQuoteByDelta(quotes, { stockPrice: 100, yearsToExpiry: 1, riskFreeRate: 0, absDelta: 0.25 }, 50, (strike) => strike === 85)?.quote.strike).toBe(80);
  });

  it("measures the typical yearly fall and the 21-session realized volatility from the closes before the day", () => {
    // A saw: 100 up to 200 over 63 sessions, back to 100 over 63: every year of closes holds a 50% fall.
    const saw = Array.from({ length: 1300 }, (_, index) => ({ close: 100 + 100 * (1 - Math.abs(((index % 126) - 63) / 63)) }));
    expect(typicalYearlyFall(saw)).toBeCloseTo(0.5, 10);
    expect(typicalYearlyFall(Array.from({ length: 300 }, (_, index) => ({ close: 100 + index })))).toBe(0);
    expect(typicalYearlyFall(saw.slice(0, 251))).toBeNull();
    // ±1% every other day: 21 log returns of ±0.00995, sample deviation × √252.
    const zigzag = Array.from({ length: 22 }, (_, index) => ({ close: index % 2 === 0 ? 100 : 101 }));
    const returns = zigzag.slice(1).map((bar, index) => Math.log(bar.close / zigzag[index]!.close));
    const mean = returns.reduce((sum, value) => sum + value, 0) / 21;
    expect(realizedVolatility21(zigzag)).toBeCloseTo(Math.sqrt((returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 20) * 252), 12);
    expect(realizedVolatility21(zigzag.slice(1))).toBeNull();
  });

  it("counts the Puts' realized P&L in the break-even and the cash break-even only with it included", () => {
    const summary: OpenCycleSummary = { sharesHeld: 1200, sharesAcquired: 1200, acquisitionCost: 412_200 + 144_000, netPremium: 20_000, breakEvenPerShare: (556_200 - 20_000) / 1200, disposalProceeds: 0, cashBreakEvenPerShare: (556_200 - 20_000) / 1200, unavailableReason: null, openShortPuts: [], contributionsByPositionId: new Map() };
    const withHedge = withHedgeInBreakEven(summary, 115_250)!;
    expect(withHedge.breakEvenPerShare).toBeCloseTo((556_200 - 20_000 - 115_250) / 1200, 10);
    expect(withHedge.cashBreakEvenPerShare).toBeCloseTo((556_200 - 20_000 - 115_250) / 1200, 10);
    expect(withHedgeInBreakEven(summary, 0)).toBe(summary);
    expect(withHedgeInBreakEven({ ...summary, unavailableReason: "no expiry-date price bar" }, 115_250)!.breakEvenPerShare).toBe(summary.breakEvenPerShare);
  });
});

describe("the hedge's steps at a look", () => {
  /** A look on NFLX with a quote source of Put expiries (by default one, 319 days out from 2021-11-01), strikes 10 apart, mid = max(strike − price, 0) + 80. */
  function lookOn(ledger: SimulatedLedger, dateIso: string, stockPrice: number, values: Partial<BacktestBaselineSettings> = {}, lookTime: [number, number] = [10, 0], options: { splitBeforeNextSession?: boolean; priceByLegId?: Map<string, number>; expiries?: string[]; pastDailyCloses?: { close: number }[]; pastImpliedVolatilities?: number[] } = {}) {
    const actions: BacktestAction[] = [];
    const summaries: string[] = [];
    const priceByLegId = options.priceByLegId ?? new Map<string, number>();
    const expiries = options.expiries ?? ["2022-09-16"];
    const quotesByExpiry = new Map(
      expiries.map((expiry): [string, SymbolFileQuote[]] => [
        expiry,
        Array.from({ length: 80 }, (_, index) => 100 + index * 10).map((strike) => {
          const mid = Math.max(strike - stockPrice, 0) + 80;
          return { expiry, strike, right: "P" as const, bid: mid - 1, ask: mid + 1, bidSize: 20, askSize: 30 };
        }),
      ]),
    );
    const source: HedgePutQuoteSource = { listedExpiries: () => expiries, quotesOf: (asked) => quotesByExpiry.get(asked) ?? [] };
    const sharesHeld = () => ledger.legs.filter((leg) => leg.legType === "stock" && leg.exitAt === null && ledger.positions.find((position) => position.id === leg.positionId)!.status === "open").reduce((sum, leg) => sum + leg.quantity, 0);
    let actionCount = 0;
    const steps = new BaselineHedgeSteps({
      ledger,
      symbol: "NFLX",
      baseline: { ...defaultBacktestBaselineSettings, putsWhenNoCall: "reserve_ladder", ladderSharesPct: 60, ladderRungs: 2, maxSpreadPctOfMid: 50, hedgePutTenorDays: 360, ...values },
      todayIso: dateIso,
      lookTimeEt: `${String(lookTime[0]).padStart(2, "0")}:${String(lookTime[1]).padStart(2, "0")}`,
      at: at(dateIso, ...lookTime),
      stockPrice,
      priceToCycleScale: 1,
      sharesPerContractOnCycleScale: 100,
      spreadShareCharged: 0,
      quotes: source,
      heldSharesToday: sharesHeld,
      ladderShock: () => 0.7,
      noteHeldContract: () => {},
      splitBeforeNextSession: options.splitBeforeNextSession ?? false,
      riskFreeRate: 0.0,
      pastDailyCloses: options.pastDailyCloses ?? [],
      pastImpliedVolatilities: () => options.pastImpliedVolatilities ?? [],
      priceByLegId,
      nextActionId: () => `hedge-action-${(actionCount += 1)}`,
      actions,
      summaries,
    });
    return { steps, actions, summaries, priceByLegId };
  }

  it("buys a Covered Call entry's Puts after the sale steps, at the money, as many as its lots", () => {
    const ledger = newLedger();
    const look = lookOn(ledger, "2021-11-01", 686.95);
    expect(look.steps.beforeSales()).toBe(false);
    const entry = coveredCallEntry(ledger);
    look.steps.noteCoveredCallEntry(600, 687);
    look.steps.afterSales();
    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]).toMatchObject({ kind: "buy_hedge", quantity: 6, contract: { strategyKey: "hedge", expiry: "2022-09-16", strike: 690, right: "P" } });
    expect(look.actions[0]!.fillPrice).toBeCloseTo(83.05, 10);
    expect(look.actions[0]!.description).toBe("NFLX Buy $690 Put · 16 Sep (319DTE) · 6× @ 83.05 (hedge for Covered Call entry: 600 shares at 686.95)");
    expect(ledgerOpenHedgeLegs(ledger, "NFLX").map((leg) => [leg.quantity, leg.strikePrice])).toEqual([[6, 690]]);
    expect(entry.sharesBought).toBe(600);
  });

  it("buys half the lots over a cycle's entries with 50% of share level, rounded down on the running total", () => {
    // 3 lots → floor(1.5) = 1 Put; 3 more → floor(3) − 1 = 2 more.
    const ledger = newLedger();
    coveredCallEntry(ledger, 3);
    const first = lookOn(ledger, "2021-11-01", 686.95, { hedgePutCoveragePct: 50 });
    first.steps.noteCoveredCallEntry(300, 687);
    first.steps.afterSales();
    openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-12", strike: 700, contracts: 3, callFillPrice: 5, stockFillPrice: 680, at: at("2021-11-02"), actionId: null, splitFactorToday: 10 });
    const second = lookOn(ledger, "2021-11-02", 680, { hedgePutCoveragePct: 50 });
    second.steps.beforeSales();
    second.steps.noteCoveredCallEntry(300, 680);
    second.steps.afterSales();
    expect([...first.actions, ...second.actions].map((action) => action.quantity)).toEqual([1, 2]);
  });

  it("sells as many Puts as an assigned rung's contracts, oldest first, at the next look", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    const seller = lookOn(ledger, "2022-04-18", 336.34);
    seller.steps.beforeSales();
    const rung = openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2022-04-22", strike: 240, contracts: 3, fillPrice: 0.51, at: at("2022-04-18"), actionId: null, splitFactorToday: 10 });
    seller.steps.noteLadderPut(rung.legId);
    settleExpiry(ledger, { legId: rung.legId, expiryClose: 215.52 });
    const next = lookOn(ledger, "2022-04-25", 211.79);
    expect(next.steps.beforeSales()).toBe(false);
    expect(next.actions.map((action) => [action.kind, action.quantity])).toEqual([["sell_hedge", 3]]);
    // Mid (690 − 211.79) + 80 = 558.21; (558.21 − 83.3068) × 300 − 2.04 = 142,468.92.
    expect(next.actions[0]!.description).toBe("NFLX Sell $690 Put · 16 Sep (144DTE) · 3× @ 558.21 (hedge, rung assigned: 3 contract(s); bought at 83.31 with its commission, gain $142,469)");
    expect(ledgerOpenHedgeLegs(ledger, "NFLX").map((leg) => leg.quantity)).toEqual([3]);
  });

  it("buys an assigned Cash-Secured Put entry's Puts from the stock price, or from the strike paid", () => {
    for (const [strikeFrom, strike] of [["stock_price", 220], ["price_paid", 240]] as const) {
      const ledger = newLedger();
      const put = openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2022-04-22", strike: 240, contracts: 2, fillPrice: 3, at: at("2022-04-18"), actionId: null, splitFactorToday: 10 });
      settleExpiry(ledger, { legId: put.legId, expiryClose: 215.52 });
      const look = lookOn(ledger, "2022-04-25", 216, { hedgePutStrikeFrom: strikeFrom });
      look.steps.beforeSales();
      expect(look.actions.map((action) => [action.kind, action.quantity, action.contract?.strike])).toEqual([["buy_hedge", 2, strike]]);
    }
  });

  it("sells the Puts above what the shares still held get, and every one with none: the cycle then ends and the look opens nothing", () => {
    const ledger = newLedger();
    const entry = coveredCallEntry(ledger);
    buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 712 });
    const look = lookOn(ledger, "2021-11-08", 705);
    expect(look.steps.beforeSales()).toBe(true);
    expect(look.actions.map((action) => [action.kind, action.quantity])).toEqual([["sell_hedge", 6]]);
    expect(isSymbolFlat(ledger, "NFLX")).toBe(true);
  });

  it("rolls a Put near expiry, and buys the replacement at a later look when none is quoted at the roll's", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    // 7 days left on 2022-09-09: sold; this source only quotes 2022-09-16, which is too near to buy, so the replacement waits.
    const roll = lookOn(ledger, "2022-09-09", 233.17);
    roll.steps.beforeSales();
    expect(roll.actions.map((action) => [action.kind, action.quantity])).toEqual([["sell_hedge", 6]]);
    expect(ledgerOpenHedgeLegs(ledger, "NFLX")).toHaveLength(0);
    // A look that finds 2022-09-16 far enough again (a stand-in for a later look with a later expiry quoted) buys it.
    const later = lookOn(ledger, "2021-11-02", 233.17);
    later.steps.beforeSales();
    expect(later.actions.map((action) => [action.kind, action.quantity, action.contract?.strike])).toEqual([["buy_hedge", 6, 230]]);
  });

  it("counts the realized P&L of the cycle's Puts in the break-even with hedgeInBreakEven included", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const look = lookOn(ledger, "2021-11-01", 686.95, { hedgeInBreakEven: "included" });
    look.steps.noteCoveredCallEntry(600, 687);
    look.steps.afterSales();
    const [leg] = ledgerOpenHedgeLegs(ledger, "NFLX");
    sellHedgePut(ledger, { legId: leg!.id, contracts: 6, fillPrice: 100, at: at("2021-11-03"), actionId: null });
    const realized = ledgerRealizedPnl(ledger, leg!.positionId).total;
    const summary: OpenCycleSummary = { sharesHeld: 600, sharesAcquired: 600, acquisitionCost: 412_203, netPremium: 2_653.92, breakEvenPerShare: (412_203 - 2_653.92) / 600, disposalProceeds: 0, cashBreakEvenPerShare: (412_203 - 2_653.92) / 600, unavailableReason: null, openShortPuts: [], contributionsByPositionId: new Map() };
    expect(look.steps.breakEvenSummary(summary)!.breakEvenPerShare).toBeCloseTo((412_203 - 2_653.92 - realized) / 600, 10);
    expect(lookOn(ledger, "2021-11-03", 690).steps.breakEvenSummary(summary)).toBe(summary);
  });

  describe("with fewer purchases", () => {
    /** A Covered Call entry with its 6 Puts $690 bought at 83.30, then its call assigned at 712: the shares are gone. $1M, for later entries' shares and Puts. */
    function calledAway() {
      const ledger = createSimulatedLedger(1_000_000, easternInstant("2021-11-01", 9, 30));
      const entry = coveredCallEntry(ledger);
      const hedge = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
      settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 712 });
      return { ledger, hedge };
    }
    const keep = { hedgePutTurnover: "keep_for_next_entry" as const };

    it("keeps the Puts when the shares leave: out of the cycle at their mark, no trade, and the cycle ends", () => {
      const { ledger, hedge } = calledAway();
      const cashBefore = ledger.cash;
      const tradesBefore = ledger.trades.length;
      const look = lookOn(ledger, "2021-11-08", 705, keep, [10, 0], { priceByLegId: new Map([[hedge.legId, 70]]) });
      expect(look.steps.beforeSales()).toBe(true);
      expect(look.actions).toHaveLength(0);
      expect(ledger.cash).toBe(cashBefore);
      expect(ledger.trades).toHaveLength(tradesBefore);
      expect(isSymbolFlat(ledger, "NFLX")).toBe(true);
      expect(ledgerOpenHedgeLegs(ledger, "NFLX")).toHaveLength(0);
      const kept = ledgerKeptHedgeLegs(ledger, "NFLX");
      expect(kept.map(({ leg }) => [leg.quantity, leg.strikePrice, leg.entryPrice, leg.enteredBy])).toEqual([[6, 690, 70, "kept_between_cycles"]]);
      expect(look.priceByLegId.get(kept[0]!.leg.id)).toBe(70);
      // The cycle's Puts realize (70 − 83.3068) × 600 there; the kept position is in no cycle.
      expect(requirePosition(ledger, hedge.positionId)).toMatchObject({ status: "closed", closeReason: "moved_between_cycles" });
      expect(ledgerRealizedPnl(ledger, hedge.positionId).total).toBeCloseTo((70 - 83.3068) * 600, 6);
      const cycles = ledgerCycles(ledger, "NFLX", { dailyCloses: [{ date: "2021-11-08", close: 705 }] });
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.status).toBe("closed");
      expect(cycles[0]!.timeline.map((row) => row.label)).toContain("Put kept for the next entry @ 70.00");
    });

    it("lets the next entry take the kept Puts at the price they were kept at and buy only what's missing; the rest are sold after the days kept", () => {
      const { ledger, hedge } = calledAway();
      lookOn(ledger, "2021-11-08", 705, keep, [10, 0], { priceByLegId: new Map([[hedge.legId, 70]]) }).steps.beforeSales();
      // A new entry of 4 lots a week later takes 4 of the 6 kept Puts: nothing bought.
      const entryLook = lookOn(ledger, "2021-11-15", 700, keep);
      expect(entryLook.steps.beforeSales()).toBe(false);
      openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 710, contracts: 4, callFillPrice: 5, stockFillPrice: 700, at: at("2021-11-15"), actionId: null, splitFactorToday: 10 });
      entryLook.steps.noteCoveredCallEntry(400, 700);
      entryLook.steps.afterSales();
      expect(entryLook.actions).toHaveLength(0);
      expect(ledgerOpenHedgeLegs(ledger, "NFLX").map((leg) => [leg.quantity, leg.entryPrice, leg.enteredBy])).toEqual([[4, 70, "taken_from_kept"]]);
      expect(ledgerKeptHedgeLegs(ledger, "NFLX").map(({ leg }) => leg.quantity)).toEqual([2]);
      const [first, second] = ledgerCycles(ledger, "NFLX", { dailyCloses: [{ date: "2021-11-15", close: 700 }] });
      expect(first!.status).toBe("closed");
      expect(second!.timeline.map((row) => row.label)).toContain("Put from the kept ones @ 70.00");
      // An entry wanting more than is kept buys the rest.
      const more = lookOn(ledger, "2021-11-16", 690, keep);
      more.steps.beforeSales();
      openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-26", strike: 700, contracts: 4, callFillPrice: 5, stockFillPrice: 690, at: at("2021-11-16"), actionId: null, splitFactorToday: 10 });
      more.steps.noteCoveredCallEntry(400, 690);
      more.steps.afterSales();
      expect(more.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_hedge", 2]]);
      expect(ledgerKeptHedgeLegs(ledger, "NFLX")).toHaveLength(0);
    });

    it("sells kept Puts no entry has taken once the days kept have passed, as a sale in no cycle", () => {
      const { ledger, hedge } = calledAway();
      lookOn(ledger, "2021-11-08", 705, keep, [10, 0], { priceByLegId: new Map([[hedge.legId, 70]]) }).steps.beforeSales();
      const early = lookOn(ledger, "2021-12-07", 650, keep);
      early.steps.beforeSales();
      expect(early.actions).toHaveLength(0);
      const due = lookOn(ledger, "2021-12-08", 650, keep);
      expect(due.steps.beforeSales()).toBe(false);
      expect(due.actions.map((action) => [action.kind, action.quantity, action.chosenBecause])).toEqual([["sell_hedge", 6, "hedge: no entry took the kept Puts within 30 days"]]);
      // Mid (690 − 650) + 80 = 120: (120 − 70) × 600 − 4.08 realized in no cycle.
      const totals = summarizeHedge(ledger, due.actions, new Map());
      expect(totals).toMatchObject({ keptContracts: 6, keptContractsTaken: 0, keptContractsSold: 6 });
      expect(totals.keptRealizedPnlDollars).toBeCloseTo(50 * 600 - 4.08, 6);
      expect(totals.realizedPnlDollars).toBeCloseTo((70 - 83.3068) * 600 + 50 * 600 - 4.08, 6);
    });

    it("sells instead of taking kept Puts struck more than the far-below share under the new entry's price", () => {
      const { ledger, hedge } = calledAway();
      const farBelow = { hedgePutTurnover: "keep_unless_far_below" as const, hedgePutFarBelowPct: 10 };
      lookOn(ledger, "2021-11-08", 705, farBelow, [10, 0], { priceByLegId: new Map([[hedge.legId, 70]]) }).steps.beforeSales();
      // At 800, the floor is 720: the kept $690 Puts are sold and 6 at the money bought.
      const entryLook = lookOn(ledger, "2021-11-15", 800, farBelow);
      entryLook.steps.beforeSales();
      openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 810, contracts: 6, callFillPrice: 5, stockFillPrice: 800, at: at("2021-11-15"), actionId: null, splitFactorToday: 10 });
      entryLook.steps.noteCoveredCallEntry(600, 800);
      entryLook.steps.afterSales();
      expect(entryLook.actions.map((action) => [action.kind, action.quantity, action.contract?.strike])).toEqual([["sell_hedge", 6, 690], ["buy_hedge", 6, 800]]);
      expect(ledgerKeptHedgeLegs(ledger, "NFLX")).toHaveLength(0);
    });

    it("never keeps Puts across a split: sold instead of kept, and kept ones sold at the look before it", () => {
      const sold = calledAway();
      const look = lookOn(sold.ledger, "2021-11-08", 705, keep, [10, 0], { splitBeforeNextSession: true });
      expect(look.steps.beforeSales()).toBe(true);
      expect(look.actions.map((action) => [action.kind, action.quantity])).toEqual([["sell_hedge", 6]]);
      expect(ledgerKeptHedgeLegs(sold.ledger, "NFLX")).toHaveLength(0);

      const kept = calledAway();
      lookOn(kept.ledger, "2021-11-08", 705, keep).steps.beforeSales();
      const beforeSplit = lookOn(kept.ledger, "2021-11-10", 700, keep, [10, 0], { splitBeforeNextSession: true });
      beforeSplit.steps.beforeSales();
      expect(beforeSplit.actions.map((action) => [action.kind, action.quantity, action.chosenBecause])).toEqual([["sell_hedge", 6, "hedge: kept Puts are sold before a split"]]);
    });

    it("waits between purchases: an entry's Puts once the days have passed since the last, only for the shares still held", () => {
      const wait = { hedgePutTurnover: "wait_between_purchases" as const };
      const ledger = newLedger();
      const first = lookOn(ledger, "2021-11-01", 686.95, wait);
      first.steps.beforeSales();
      coveredCallEntry(ledger, 3);
      first.steps.noteCoveredCallEntry(300, 687);
      first.steps.afterSales();
      expect(first.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_hedge", 3]]);
      // 3 more lots 10 days later: no Puts yet.
      const second = lookOn(ledger, "2021-11-11", 680, wait);
      second.steps.beforeSales();
      openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 700, contracts: 3, callFillPrice: 5, stockFillPrice: 680, at: at("2021-11-11"), actionId: null, splitFactorToday: 10 });
      second.steps.noteCoveredCallEntry(300, 680);
      second.steps.afterSales();
      expect(second.actions).toHaveLength(0);
      // 30 days after the first purchase: bought for the 300 shares still waiting.
      const due = lookOn(ledger, "2021-12-01", 670, wait);
      due.steps.beforeSales();
      expect(due.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_hedge", 3]]);
    });

    it("waits between purchases: buys nothing for an entry whose shares are gone before the wait ends", () => {
      const wait = { hedgePutTurnover: "wait_between_purchases" as const };
      const ledger = newLedger();
      const entry = coveredCallEntry(ledger, 3);
      const first = lookOn(ledger, "2021-11-01", 686.95, wait);
      first.steps.noteCoveredCallEntry(300, 687);
      first.steps.afterSales();
      const second = lookOn(ledger, "2021-11-02", 680, wait);
      second.steps.beforeSales();
      const added = openCoveredCall(ledger, { symbol: "NFLX", expiryDate: "2021-11-05", strike: 690, contracts: 3, callFillPrice: 5, stockFillPrice: 680, at: at("2021-11-02"), actionId: null, splitFactorToday: 10 });
      second.steps.noteCoveredCallEntry(300, 680);
      second.steps.afterSales();
      // Both calls assigned on 5 Nov: every share gone, the cycle's 3 Puts sold at the next look, nothing more bought.
      settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 712 });
      settleExpiry(ledger, { legId: added.callLegId, expiryClose: 712 });
      const next = lookOn(ledger, "2021-11-08", 705, wait);
      expect(next.steps.beforeSales()).toBe(true);
      const later = lookOn(ledger, "2021-12-02", 700, wait);
      later.steps.beforeSales();
      expect([...next.actions, ...later.actions].map((action) => [action.kind, action.quantity])).toEqual([["sell_hedge", 3]]);
    });
  });

  describe("covering the whole position", () => {
    // NFLX on 2021-11-01 listed 81, 109, 137, 228, 319 and 445 days out. 360 days rolled at 90 left over 3 expiries: slots of
    // 90 days, bought nearest 360 (→ 319), 270 (→ 228) and 180 (→ 137) days.
    const listed = ["2022-01-21", "2022-02-18", "2022-03-18", "2022-06-17", "2022-09-16", "2023-01-20"];
    const position = { hedgePutCovers: "position" as const, hedgePutRollDaysLeft: 90, hedgePutStaggeredExpiries: 3 };
    const lookAt = (ledger: SimulatedLedger, dateIso: string, stockPrice: number, options: { splitBeforeNextSession?: boolean } = {}) => lookOn(ledger, dateIso, stockPrice, position, [10, 0], { ...options, expiries: listed });
    const newBigLedger = () => createSimulatedLedger(1_000_000, easternInstant("2021-11-01", 9, 30));
    const bought = (actions: BacktestAction[]) => actions.map((action) => [action.kind, action.quantity, action.contract?.expiry]);
    /** A Covered Call entry of 6 lots with the whole position's 6 Puts bought at its look: 2 on each staggered expiry. */
    function coveredPosition() {
      const ledger = newBigLedger();
      const entry = coveredCallEntry(ledger);
      const look = lookAt(ledger, "2021-11-01", 686.95);
      look.steps.noteCoveredCallEntry(600, 687);
      look.steps.afterSales();
      expect(bought(look.actions)).toEqual([["buy_hedge", 2, "2022-09-16"], ["buy_hedge", 2, "2022-06-17"], ["buy_hedge", 2, "2022-03-18"]]);
      return { ledger, entry };
    }

    it("covers a Cash-Secured Put entry as soon as it is sold, its Puts spread over the staggered expiries", () => {
      // 8 short Puts: 8 Puts wanted, owed 3, 3 and 2 by the slots.
      const ledger = newBigLedger();
      const look = lookAt(ledger, "2021-11-01", 686.95);
      expect(look.steps.beforeSales()).toBe(false);
      openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 680, contracts: 8, fillPrice: 10, at: at("2021-11-01"), actionId: null, splitFactorToday: 10 });
      look.steps.afterSales();
      expect(look.actions.map((action) => [action.kind, action.quantity, action.contract?.expiry, action.contract?.strike])).toEqual([
        ["buy_hedge", 3, "2022-09-16", 690],
        ["buy_hedge", 3, "2022-06-17", 690],
        ["buy_hedge", 2, "2022-03-18", 690],
      ]);
      expect(look.actions[0]!.description).toBe("NFLX Buy $690 Put · 16 Sep (319DTE) · 3× @ 83.05 (hedge for the position: 0 shares and 8 short Put(s) at 686.95)");
      expect(look.actions.map((action) => action.candidateScores?.targetDays)).toEqual([360, 270, 180]);
    });

    it("sells nothing when the entry Put or a rung is assigned, and tops up when a rung is sold", () => {
      const ledger = newBigLedger();
      const put = openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 680, contracts: 8, fillPrice: 10, at: at("2021-11-01"), actionId: null, splitFactorToday: 10 });
      lookAt(ledger, "2021-11-01", 686.95).steps.afterSales();
      settleExpiry(ledger, { legId: put.legId, expiryClose: 650 });
      const afterAssignment = lookAt(ledger, "2021-11-22", 650);
      expect(afterAssignment.steps.beforeSales()).toBe(false);
      expect(afterAssignment.actions).toEqual([]);
      // A rung of 4 sold at the same look: 12 wanted, 4 more bought.
      const rung = openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2021-12-03", strike: 600, contracts: 4, fillPrice: 5, at: at("2021-11-22"), actionId: null, splitFactorToday: 10 });
      afterAssignment.steps.noteLadderPut(rung.legId);
      afterAssignment.steps.afterSales();
      expect(afterAssignment.actions.every((action) => action.kind === "buy_hedge")).toBe(true);
      expect(afterAssignment.actions.reduce((sum, action) => sum + action.quantity!, 0)).toBe(4);
      // The rung assigned: 1,200 shares, still 12 Puts wanted, nothing sold.
      settleExpiry(ledger, { legId: rung.legId, expiryClose: 590 });
      const afterRung = lookAt(ledger, "2021-12-06", 585);
      expect(afterRung.steps.beforeSales()).toBe(false);
      expect(afterRung.actions).toEqual([]);
      expect(ledgerOpenHedgeLegs(ledger, "NFLX").reduce((sum, leg) => sum + leg.quantity, 0)).toBe(12);
    });

    it("keeps the Puts beyond the position after shares leave until their roll, then buys only what is missing", () => {
      const { ledger, entry } = coveredPosition();
      settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 645.72 });
      const sharesLeg = ledger.legs.find((leg) => leg.legType === "stock" && leg.exitAt === null)!;
      sellShares(ledger, { positionId: sharesLeg.positionId, shares: 300, fillPrice: 650, at: at("2021-11-08"), actionId: null });
      const afterSale = lookAt(ledger, "2021-11-09", 650);
      expect(afterSale.steps.beforeSales()).toBe(false);
      expect(afterSale.actions).toEqual([]);
      // 88 days left on 2022-03-18's 2 Puts: sold; 4 still held against 3 wanted, so none bought.
      const roll = lookAt(ledger, "2021-12-20", 640);
      expect(roll.steps.beforeSales()).toBe(false);
      expect(bought(roll.actions)).toEqual([["sell_hedge", 2, "2022-03-18"]]);
      expect(ledgerOpenHedgeLegs(ledger, "NFLX").map((leg) => [leg.quantity, leg.expiryDate])).toEqual([[2, "2022-09-16"], [2, "2022-06-17"]]);
    });

    it("ends the cycle when no share or short Put is left: the Puts are kept, no trade, and the next entry takes them", () => {
      const { ledger, entry } = coveredPosition();
      settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 712 });
      const cashBefore = ledger.cash;
      const tradesBefore = ledger.trades.length;
      const end = lookAt(ledger, "2021-11-08", 705);
      expect(end.steps.beforeSales()).toBe(true);
      expect(end.actions).toEqual([]);
      expect(ledger.cash).toBe(cashBefore);
      expect(ledger.trades).toHaveLength(tradesBefore);
      expect(isSymbolFlat(ledger, "NFLX")).toBe(true);
      expect(ledgerKeptHedgeLegs(ledger, "NFLX").map(({ leg }) => leg.quantity)).toEqual([2, 2, 2]);
      expect(end.summaries[0]).toMatch(/^NFLX: kept 2 × \$690 Put .* \(the position is gone: no shares or short Puts are held\)$/);
      // A Cash-Secured Put entry of 4 the next day takes 4 of them: nothing bought.
      const next = lookAt(ledger, "2021-11-09", 700);
      expect(next.steps.beforeSales()).toBe(false);
      openCashSecuredPut(ledger, { symbol: "NFLX", expiryDate: "2021-11-19", strike: 690, contracts: 4, fillPrice: 10, at: at("2021-11-09"), actionId: null, splitFactorToday: 10 });
      next.steps.afterSales();
      expect(next.actions).toEqual([]);
      expect(ledgerOpenHedgeLegs(ledger, "NFLX").reduce((sum, leg) => sum + leg.quantity, 0)).toBe(4);
      expect(ledgerKeptHedgeLegs(ledger, "NFLX").reduce((sum, { leg }) => sum + leg.quantity, 0)).toBe(2);
    });

    it("sells kept Puts at their roll, not after the days kept", () => {
      const { ledger, entry } = coveredPosition();
      settleExpiry(ledger, { legId: entry.callLegId, expiryClose: 712 });
      lookAt(ledger, "2021-11-08", 705).steps.beforeSales();
      // 37 days kept: still held (93 days left on the shortest).
      const later = lookAt(ledger, "2021-12-15", 700);
      later.steps.beforeSales();
      expect(later.actions).toEqual([]);
      const roll = lookAt(ledger, "2021-12-20", 700);
      roll.steps.beforeSales();
      expect(bought(roll.actions)).toEqual([["sell_hedge", 2, "2022-03-18"]]);
    });

    it("buys no Put while it is too dear, noting it once a day, and buys it once the rule allows", () => {
      // $690 Put at 83.05 with 319 days left on a 686.95 stock: 83.05 ÷ 686.95 × 365 ÷ 319 = 13.8% a year. The saw's typical
      // yearly fall is 50%: 0.2 × 50% = 10% blocks it, 0.3 × 50% = 15% doesn't.
      const saw = Array.from({ length: 1300 }, (_, index) => ({ close: 100 + 100 * (1 - Math.abs(((index % 126) - 63) / 63)) }));
      const gated = (dateIso: string, values: Partial<BacktestBaselineSettings>, history: { pastDailyCloses?: { close: number }[]; pastImpliedVolatilities?: number[] }, ledger: SimulatedLedger) =>
        lookOn(ledger, dateIso, 686.95, { ...position, hedgePutStaggeredExpiries: 1, ...values }, [10, 0], { expiries: ["2022-09-16"], ...history });
      const ledger = newBigLedger();
      coveredCallEntry(ledger);
      const blocked = gated("2021-11-01", { hedgePutPriceGate: "cost_vs_typical_fall", hedgePutCostFallShare: 0.2 }, { pastDailyCloses: saw }, ledger);
      blocked.steps.afterSales();
      blocked.steps.afterSales();
      expect(blocked.actions).toEqual([]);
      expect(blocked.summaries).toEqual(["NFLX: no hedge Put bought for the position: 600 shares and 0 short Put(s): its yearly cost 13.8% is above 0.2 × the typical yearly fall 50.0% = 10.0% (noted once a day)"]);
      const allowed = gated("2021-11-01", { hedgePutPriceGate: "cost_vs_typical_fall", hedgePutCostFallShare: 0.3 }, { pastDailyCloses: saw }, ledger);
      allowed.steps.afterSales();
      expect(allowed.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_hedge", 6]]);
      // The IV rules: flat closes have no realized volatility, so any IV is above it; the IV history rule against 500% and 1%.
      for (const [values, history, buys] of [
        [{ hedgePutPriceGate: "iv_vs_realized" as const }, { pastDailyCloses: Array.from({ length: 30 }, () => ({ close: 100 })) }, 0],
        [{ hedgePutPriceGate: "iv_vs_history" as const }, { pastImpliedVolatilities: Array<number>(200).fill(5) }, 1],
        [{ hedgePutPriceGate: "iv_vs_history" as const }, { pastImpliedVolatilities: Array<number>(200).fill(0.01) }, 0],
        [{ hedgePutPriceGate: "iv_vs_history" as const }, { pastImpliedVolatilities: Array<number>(100).fill(0.01) }, 1],
      ] as const) {
        const fresh = newBigLedger();
        coveredCallEntry(fresh);
        const look = gated("2021-11-01", values, history, fresh);
        look.steps.afterSales();
        expect(look.actions).toHaveLength(buys);
      }
    });

    it("sells every hedge Put at the look before a split and buys the position's again at the next session", () => {
      const { ledger } = coveredPosition();
      const beforeSplit = lookAt(ledger, "2021-11-02", 690, { splitBeforeNextSession: true });
      expect(beforeSplit.steps.beforeSales()).toBe(false);
      beforeSplit.steps.afterSales();
      expect(bought(beforeSplit.actions)).toEqual([["sell_hedge", 2, "2022-09-16"], ["sell_hedge", 2, "2022-06-17"], ["sell_hedge", 2, "2022-03-18"]]);
      const afterSplit = lookAt(ledger, "2021-11-03", 690);
      afterSplit.steps.beforeSales();
      expect(afterSplit.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_hedge", 2], ["buy_hedge", 2], ["buy_hedge", 2]]);
    });
  });

  it("totals the session's Puts from the book", () => {
    const ledger = newLedger();
    coveredCallEntry(ledger);
    const { legId } = buyHedgePut(ledger, { symbol: "NFLX", expiryDate: "2022-09-16", strike: 690, contracts: 6, fillPrice: 83.3, at: at("2021-11-01"), actionId: null });
    sellHedgePut(ledger, { legId, contracts: 3, fillPrice: 467.48, at: at("2022-04-25"), actionId: null });
    const totals = summarizeHedge(ledger, [], new Map([[legId, 400]]));
    expect(totals).toMatchObject({ purchases: 1, contractsBought: 6, sales: 1, contractsSold: 3, openContracts: 3 });
    expect(totals.costDollars).toBeCloseTo(49_980 + 4.08, 6);
    expect(totals.proceedsDollars).toBeCloseTo(140_244 - 2.04, 6);
    expect(totals.realizedPnlDollars).toBeCloseTo((467.48 - 83.3068) * 300 - 2.04, 6);
    expect(totals.openCostDollars).toBeCloseTo(83.3068 * 300, 6);
    expect(totals.openMarkDollars).toBeCloseTo(400 * 300, 6);
  });
});
