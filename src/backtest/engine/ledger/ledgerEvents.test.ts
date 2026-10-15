import { describe, expect, it } from "vitest";
import { easternInstant } from "../../../lib/easternIsoDate.js";
import { buyBackPut, closeCoveredCall, creditInterest, expirySettlementInstant, isAssignedAtExpiry, openCashSecuredPut, openCoveredCall, rollLeg, sellShares, settleExpiry } from "./ledgerEvents.js";
import { optionPurchaseFillPrice, optionSaleFillPrice } from "./ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerCapitalDeployed, ledgerCashLockedInCashSecuredPuts, ledgerCycles, ledgerFreeCash, ledgerFreeShares, ledgerRealizedPnl } from "./ledgerSelectors.js";
import { createSimulatedLedger, cycleGroupingWindowMs, cycleSplitFactorFor, isSymbolFlat, legsOfPosition, requireLeg, requirePosition, type SimulatedLedger } from "./simulatedLedger.js";

// One scenario per row of the lifecycle table (docs/backtesting/INVENTORY-WHEEL-ACCOUNTING.md §1.5): the rows each
// event leaves and the cash it moves. Commissions: $0.68 per option contract, $0.005 per share.

const startingCash = 100_000;
const decisionAt = (dateIso: string) => easternInstant(dateIso, 10, 0);
const newLedger = () => createSimulatedLedger(startingCash, easternInstant("2026-03-02", 9, 30));
const journalTotal = (ledger: SimulatedLedger) => ledger.cashJournal.reduce((sum, entry) => sum + entry.amount, 0);
const journalOfKind = (ledger: SimulatedLedger, kind: string) => ledger.cashJournal.filter((entry) => entry.kind === kind).map((entry) => entry.amount);
const tradesOfLeg = (ledger: SimulatedLedger, legId: string) => ledger.trades.filter((trade) => trade.legId === legId);
const openPositionsOf = (ledger: SimulatedLedger, symbol: string) => ledger.positions.filter((position) => position.symbol === symbol && position.status === "open");

function expectCashEqualsJournal(ledger: SimulatedLedger, expectedCash: number): void {
  expect(ledger.cash).toBeCloseTo(expectedCash, 6);
  expect(journalTotal(ledger)).toBeCloseTo(ledger.cash, 6);
}

/** A put sold on 2 March and settled at its 6 March expiry. */
function putSettledAt(ledger: SimulatedLedger, symbol: string, strike: number, contracts: number, fillPrice: number, expiryClose: number) {
  const put = openCashSecuredPut(ledger, { symbol, expiryDate: "2026-03-06", strike, contracts, fillPrice, at: decisionAt("2026-03-02"), actionId: "action-put", splitFactorToday: 1 });
  const outcome = settleExpiry(ledger, { legId: put.legId, expiryClose });
  return { ...put, outcome };
}

describe("fill prices", () => {
  it("sells an option under the mid and buys it back over the mid by the charged share of the half-spread", () => {
    // Bid 1.00, ask 1.20, half the half-spread charged: mid 1.10 ∓ 0.5 × 0.10.
    expect(optionSaleFillPrice(1, 1.2, 0.5)).toBeCloseTo(1.05, 10);
    expect(optionPurchaseFillPrice(1, 1.2, 0.5)).toBeCloseTo(1.15, 10);
  });
});

describe("the assignment rule at expiry", () => {
  it("assigns a put in the money by a cent or more and leaves anything less worthless", () => {
    expect(isAssignedAtExpiry("put", 50, 49.99)).toBe(true);
    expect(isAssignedAtExpiry("put", 39, 38.99)).toBe(true);
    expect(isAssignedAtExpiry("put", 50, 49.995)).toBe(false);
    expect(isAssignedAtExpiry("put", 50, 50)).toBe(false);
    expect(isAssignedAtExpiry("put", 50, 50.01)).toBe(false);
  });

  it("assigns a call in the money by a cent or more and leaves anything less worthless", () => {
    expect(isAssignedAtExpiry("call", 50, 50.01)).toBe(true);
    expect(isAssignedAtExpiry("call", 50, 50.005)).toBe(false);
    expect(isAssignedAtExpiry("call", 50, 50)).toBe(false);
    expect(isAssignedAtExpiry("call", 50, 49.99)).toBe(false);
  });

  it("stamps a settlement at 16:00 Eastern of the expiry date, winter and summer time", () => {
    expect(expirySettlementInstant("2026-03-06").toISOString()).toBe("2026-03-06T21:00:00.000Z");
    expect(expirySettlementInstant("2026-03-13").toISOString()).toBe("2026-03-13T20:00:00.000Z");
  });
});

describe("open cash-secured put", () => {
  it("creates a cash-secured-put position with one short put at its fill net of the commission, and its opening trade", () => {
    // 3 puts $50 at 1.20: premium 1.20 × 300 = 360, commission 3 × 0.68 = 2.04, entry 1.20 − 0.0068 = 1.1932.
    const ledger = newLedger();
    const at = decisionAt("2026-03-02");
    const { positionId, legId } = openCashSecuredPut(ledger, { symbol: "AAA", expiryDate: "2026-03-06", strike: 50, contracts: 3, fillPrice: 1.2, at, actionId: "action-1", splitFactorToday: 2 });

    expect(requirePosition(ledger, positionId)).toEqual({ id: positionId, symbol: "AAA", strategyKey: "cash_secured_put", status: "open", openedAt: at, closedAt: null, closeReason: null, unstructuredReason: null });
    const leg = requireLeg(ledger, legId);
    expect(leg).toMatchObject({ positionId, legType: "option", side: "short", optionType: "put", quantity: 3, strikePrice: 50, expiryDate: "2026-03-06", multiplier: 100, entryAt: at, exitPrice: null, exitAt: null, parentLegId: null, settledAs: null });
    expect(leg.entryPrice).toBeCloseTo(1.1932, 10);
    expect(tradesOfLeg(ledger, legId)).toEqual([expect.objectContaining({ side: "sell", quantity: 3, price: 1.2, executedAt: at, isClosingTrade: false, actionId: "action-1" })]);
    expect(tradesOfLeg(ledger, legId)[0]!.commission).toBeCloseTo(2.04, 10);

    expect(journalOfKind(ledger, "premium")).toEqual([360]);
    expect(journalOfKind(ledger, "commission")[0]).toBeCloseTo(-2.04, 10);
    expectCashEqualsJournal(ledger, 100_357.96);
    // EXP $ (50 − 1.1932) × 300; the full strike is locked.
    expect(ledgerCapitalAtRisk(ledger, positionId)).toBeCloseTo(14_642.04, 6);
    expect(ledgerCashLockedInCashSecuredPuts(ledger)).toBe(15_000);
    expect(ledgerFreeCash(ledger)).toBeCloseTo(85_357.96, 6);
    expect(cycleSplitFactorFor(ledger, "AAA", 1)).toBe(2);
  });

  it("refuses a second position on a contract already held, put or call", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "AAA", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    const cashBefore = ledger.cash;
    expect(() => openCashSecuredPut(ledger, { symbol: "AAA", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.1, at: decisionAt("2026-03-03"), actionId: null, splitFactorToday: 1 })).toThrow(/one position per contract/);
    expect(() => openCoveredCall(ledger, { symbol: "AAA", expiryDate: "2026-03-06", strike: 50, contracts: 1, callFillPrice: 0.9, stockFillPrice: 49.5, at: decisionAt("2026-03-03"), actionId: null, splitFactorToday: 1 })).toThrow(/one position per contract/);
    const other = openCashSecuredPut(ledger, { symbol: "AAA", expiryDate: "2026-03-13", strike: 49, contracts: 1, fillPrice: 1.1, at: decisionAt("2026-03-03"), actionId: null, splitFactorToday: 1 });
    expect(() => rollLeg(ledger, { legId: put.legId, newExpiryDate: "2026-03-13", newStrike: 49, buybackFillPrice: 0.5, newFillPrice: 1, at: decisionAt("2026-03-04"), actionId: null })).toThrow(/one position per contract/);
    expect(ledger.positions.map((position) => position.id)).toEqual([put.positionId, other.positionId]);
    expectCashEqualsJournal(ledger, cashBefore + 110 - 0.68);
    // Another symbol's same strike and expiry is another contract.
    expect(() => openCashSecuredPut(ledger, { symbol: "BBB", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-03"), actionId: null, splitFactorToday: 1 })).not.toThrow();
  });

  it("takes the shares one contract covers on the cycle's scale", () => {
    // After a 2-for-1 split inside a cycle one contract covers 50 shares of the cycle's scale: premium 2.40 × 50 × 2, entry 2.40 − 0.68 ÷ 50.
    const ledger = newLedger();
    const { legId } = openCashSecuredPut(ledger, { symbol: "AAA", expiryDate: "2026-03-06", strike: 100, contracts: 2, fillPrice: 2.4, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1, sharesPerContract: 50 });
    expect(requireLeg(ledger, legId).multiplier).toBe(50);
    expect(requireLeg(ledger, legId).entryPrice).toBeCloseTo(2.3864, 10);
    expectCashEqualsJournal(ledger, 100_000 + 240 - 1.36);
    expect(ledgerCashLockedInCashSecuredPuts(ledger)).toBe(10_000);
  });
});

describe("open covered call as a buy-write", () => {
  it("creates a covered call holding the call and the shares bought for it, at their cost with the commission", () => {
    // 200 sh at 30.01 (stock 30.00 + 0.01) = 6,002 + 1.00 commission: entry 6,003 ÷ 200 = 30.015.
    // 2 calls $31 at 0.50: premium 100, commission 1.36, entry 0.4932.
    const ledger = newLedger();
    const at = decisionAt("2026-03-02");
    const result = openCoveredCall(ledger, { symbol: "BBB", expiryDate: "2026-03-06", strike: 31, contracts: 2, callFillPrice: 0.5, stockFillPrice: 30.01, at, actionId: "action-1", splitFactorToday: 1 });

    expect(result).toMatchObject({ sharesBought: 200, sharesFromHeld: 0, leftoverPositionId: null });
    expect(requirePosition(ledger, result.positionId)).toMatchObject({ strategyKey: "covered_call", status: "open", openedAt: at });
    const stockLeg = requireLeg(ledger, result.stockLegId);
    expect(stockLeg).toMatchObject({ legType: "stock", side: "long", quantity: 200, multiplier: 1, entryAt: at, exitAt: null });
    expect(stockLeg.entryPrice).toBeCloseTo(30.015, 10);
    expect(requireLeg(ledger, result.callLegId)).toMatchObject({ legType: "option", side: "short", optionType: "call", quantity: 2, strikePrice: 31, entryAt: at });
    expect(requireLeg(ledger, result.callLegId).entryPrice).toBeCloseTo(0.4932, 10);
    expect(tradesOfLeg(ledger, result.stockLegId)).toEqual([expect.objectContaining({ side: "buy", quantity: 200, isClosingTrade: false, executedAt: at, actionId: "action-1" })]);
    expect(tradesOfLeg(ledger, result.stockLegId)[0]!.price).toBeCloseTo(30.01, 10);
    expect(tradesOfLeg(ledger, result.stockLegId)[0]!.commission).toBeCloseTo(1, 10);
    expect(tradesOfLeg(ledger, result.callLegId)).toEqual([expect.objectContaining({ side: "sell", quantity: 2, price: 0.5, isClosingTrade: false, executedAt: at })]);

    expectCashEqualsJournal(ledger, 100_000 - 6002 - 1 + 100 - 1.36);
    // EXP $ = 30.015 × 200 − 0.4932 × 200.
    expect(ledgerCapitalAtRisk(ledger, result.positionId)).toBeCloseTo(5904.36, 6);
    expect(ledgerFreeShares(ledger, "BBB")).toBe(0);
    expect(ledger.shareSources).toEqual([]);
  });
});

describe("open covered call on held shares", () => {
  it("hands the uncovered shares to the new covered call at their entry and closes the unstructured position", () => {
    const ledger = newLedger();
    const put = putSettledAt(ledger, "CCC", 50, 1, 1.2, 48);
    const sharesPosition = openPositionsOf(ledger, "CCC")[0]!;
    const sharesLeg = legsOfPosition(ledger, sharesPosition.id)[0]!;
    const cashBefore = ledger.cash;
    const tradeCountBefore = ledger.trades.length;
    const at = decisionAt("2026-03-09");

    const result = openCoveredCall(ledger, { symbol: "CCC", expiryDate: "2026-03-13", strike: 51, contracts: 1, callFillPrice: 0.8, stockFillPrice: null, at, actionId: "action-call", splitFactorToday: 1 });

    expect(result).toMatchObject({ sharesBought: 0, sharesFromHeld: 100, leftoverPositionId: null });
    expect(sharesPosition).toMatchObject({ status: "closed", closedAt: at, closeReason: "stock_rolled_into_covered_call" });
    expect(sharesLeg).toMatchObject({ exitPrice: 50, exitAt: at, quantity: 100 });
    expect(requireLeg(ledger, result.stockLegId)).toMatchObject({ positionId: result.positionId, quantity: 100, entryPrice: 50, entryAt: at, exitAt: null });
    expect(ledger.shareSources).toEqual([{ positionId: sharesPosition.id, sourcePositionId: put.positionId }, { positionId: result.positionId, sourcePositionId: sharesPosition.id }]);
    // Only the call trades: no share changes hands in the market.
    expect(ledger.trades.length).toBe(tradeCountBefore + 1);
    expectCashEqualsJournal(ledger, cashBefore + 80 - 0.68);
    expect(ledgerRealizedPnl(ledger, sharesPosition.id).total).toBe(0);
    // EXP $ = 50 × 100 − 0.7932 × 100.
    expect(ledgerCapitalAtRisk(ledger, result.positionId)).toBeCloseTo(4920.68, 6);
  });

  it("leaves the shares the call does not need in a new unstructured position", () => {
    const ledger = newLedger();
    putSettledAt(ledger, "CCC", 50, 2, 1.2, 48);
    const sharesPosition = openPositionsOf(ledger, "CCC")[0]!;
    const at = decisionAt("2026-03-09");

    const result = openCoveredCall(ledger, { symbol: "CCC", expiryDate: "2026-03-13", strike: 51, contracts: 1, callFillPrice: 0.8, stockFillPrice: null, at, actionId: "action-call", splitFactorToday: 1 });

    expect(sharesPosition).toMatchObject({ status: "closed", closeReason: "stock_rolled_into_covered_call" });
    expect(legsOfPosition(ledger, sharesPosition.id)[0]).toMatchObject({ quantity: 200, exitPrice: 50, exitAt: at });
    expect(requireLeg(ledger, result.stockLegId)).toMatchObject({ quantity: 100, entryPrice: 50 });
    const leftoverPosition = requirePosition(ledger, result.leftoverPositionId!);
    expect(leftoverPosition).toMatchObject({ strategyKey: "unstructured", status: "open", openedAt: at, unstructuredReason: "unknown" });
    expect(legsOfPosition(ledger, leftoverPosition.id)).toEqual([expect.objectContaining({ legType: "stock", quantity: 100, entryPrice: 50, entryAt: at, exitAt: null })]);
    expect(ledger.shareSources).toContainEqual({ positionId: result.positionId, sourcePositionId: sharesPosition.id });
    expect(ledger.shareSources).toContainEqual({ positionId: leftoverPosition.id, sourcePositionId: sharesPosition.id });
    expect(ledgerFreeShares(ledger, "CCC")).toBe(100);
  });

  it("buys only the shares the uncovered ones do not supply, and averages their cost into the stock leg", () => {
    // 100 sh held at 50; 2 calls need 200: buy 100 at 52.01 + 0.50 commission. Entry (5,000 + 5,201.50) ÷ 200 = 51.0075.
    const ledger = newLedger();
    putSettledAt(ledger, "CCC", 50, 1, 1.2, 48);
    const cashBefore = ledger.cash;
    const at = decisionAt("2026-03-09");
    expect(() => openCoveredCall(ledger, { symbol: "CCC", expiryDate: "2026-03-13", strike: 53, contracts: 2, callFillPrice: 0.8, stockFillPrice: null, at, actionId: null, splitFactorToday: 1 })).toThrow(/100 more shares/);

    const result = openCoveredCall(ledger, { symbol: "CCC", expiryDate: "2026-03-13", strike: 53, contracts: 2, callFillPrice: 0.8, stockFillPrice: 52.01, at, actionId: "action-call", splitFactorToday: 1 });

    expect(result).toMatchObject({ sharesBought: 100, sharesFromHeld: 100, leftoverPositionId: null });
    expect(requireLeg(ledger, result.stockLegId).quantity).toBe(200);
    expect(requireLeg(ledger, result.stockLegId).entryPrice).toBeCloseTo(51.0075, 10);
    expect(tradesOfLeg(ledger, result.stockLegId)).toEqual([expect.objectContaining({ side: "buy", quantity: 100, isClosingTrade: false })]);
    expectCashEqualsJournal(ledger, cashBefore - 5201 - 0.5 + 160 - 1.36);
  });
});

describe("put expires out of the money", () => {
  it("closes the leg at 0 with no trade and the position as expired worthless", () => {
    const ledger = newLedger();
    const put = putSettledAt(ledger, "DDD", 50, 1, 1.2, 50);
    const settledAt = new Date("2026-03-06T21:00:00.000Z");

    expect(put.outcome).toBe("put_worthless");
    expect(requireLeg(ledger, put.legId)).toMatchObject({ exitPrice: 0, exitAt: settledAt, settledAs: "worthless", expiryClose: 50 });
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closedAt: settledAt, closeReason: "expired_worthless" });
    expect(tradesOfLeg(ledger, put.legId)).toHaveLength(1);
    expectCashEqualsJournal(ledger, 100_119.32);
    expect(ledgerRealizedPnl(ledger, put.positionId)).toMatchObject({ stock: 0 });
    expect(ledgerRealizedPnl(ledger, put.positionId).premium).toBeCloseTo(119.32, 6);
    expect(isSymbolFlat(ledger, "DDD")).toBe(true);
    expect(ledger.positions).toHaveLength(1);
  });
});

describe("put assigned", () => {
  it("closes the put as assigned and puts the shares in a new unstructured position at the strike, bought at the strike with no commission", () => {
    const ledger = newLedger();
    const put = putSettledAt(ledger, "EEE", 50, 1, 1.2, 49.99);
    const settledAt = new Date("2026-03-06T21:00:00.000Z");

    expect(put.outcome).toBe("put_assigned");
    expect(requireLeg(ledger, put.legId)).toMatchObject({ exitPrice: 0, exitAt: settledAt, settledAs: "assigned", expiryClose: 49.99 });
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closedAt: settledAt, closeReason: "assigned" });
    expect(tradesOfLeg(ledger, put.legId)).toHaveLength(1);

    const sharesPosition = openPositionsOf(ledger, "EEE")[0]!;
    expect(sharesPosition).toMatchObject({ strategyKey: "unstructured", openedAt: settledAt, unstructuredReason: "csp_assigned_stock" });
    const sharesLeg = legsOfPosition(ledger, sharesPosition.id)[0]!;
    expect(sharesLeg).toMatchObject({ legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: 50, entryAt: settledAt, exitAt: null });
    expect(tradesOfLeg(ledger, sharesLeg.id)).toEqual([expect.objectContaining({ side: "buy", quantity: 100, price: 50, commission: 0, executedAt: settledAt, isClosingTrade: false, actionId: null })]);
    expect(ledger.shareSources).toEqual([{ positionId: sharesPosition.id, sourcePositionId: put.positionId }]);

    expect(journalOfKind(ledger, "assignment")).toEqual([-5000]);
    expectCashEqualsJournal(ledger, 100_119.32 - 5000);
    expect(ledgerFreeShares(ledger, "EEE")).toBe(100);
    expect(ledgerCapitalAtRisk(ledger, sharesPosition.id)).toBe(5000);
    expect(isSymbolFlat(ledger, "EEE")).toBe(false);
  });

  it("adds a later assignment's shares to the symbol's unstructured position at the weighted average", () => {
    // 100 sh at 50, then 200 sh at 45: 300 sh at (5,000 + 9,000) ÷ 300 = 46.6667.
    const ledger = newLedger();
    const firstPut = putSettledAt(ledger, "EEE", 50, 1, 1.2, 48);
    const sharesPosition = openPositionsOf(ledger, "EEE")[0]!;
    const secondPut = openCashSecuredPut(ledger, { symbol: "EEE", expiryDate: "2026-03-13", strike: 45, contracts: 2, fillPrice: 0.7, at: decisionAt("2026-03-09"), actionId: null, splitFactorToday: 1 });
    settleExpiry(ledger, { legId: secondPut.legId, expiryClose: 44 });

    expect(openPositionsOf(ledger, "EEE")).toEqual([sharesPosition]);
    const sharesLeg = legsOfPosition(ledger, sharesPosition.id)[0]!;
    expect(sharesLeg).toMatchObject({ quantity: 300, entryAt: new Date("2026-03-06T21:00:00.000Z"), exitAt: null });
    expect(sharesLeg.entryPrice).toBeCloseTo(14_000 / 300, 10);
    expect(tradesOfLeg(ledger, sharesLeg.id).map((trade) => [trade.quantity, trade.price])).toEqual([[100, 50], [200, 45]]);
    expect(ledger.shareSources).toEqual([{ positionId: sharesPosition.id, sourcePositionId: firstPut.positionId }, { positionId: sharesPosition.id, sourcePositionId: secondPut.positionId }]);
    expect(ledgerFreeShares(ledger, "EEE")).toBe(300);
  });
});

describe("call expires out of the money", () => {
  it("closes the call at 0, hands the shares at their entry to a new unstructured position and closes the covered call as expired worthless", () => {
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "FFF", expiryDate: "2026-03-06", strike: 31, contracts: 2, callFillPrice: 0.5, stockFillPrice: 30.01, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    const cashBefore = ledger.cash;
    const tradeCountBefore = ledger.trades.length;
    const settledAt = new Date("2026-03-06T21:00:00.000Z");

    expect(settleExpiry(ledger, { legId: call.callLegId, expiryClose: 31 })).toBe("call_worthless");

    expect(requireLeg(ledger, call.callLegId)).toMatchObject({ exitPrice: 0, exitAt: settledAt, settledAs: "worthless", expiryClose: 31 });
    const handedLeg = requireLeg(ledger, call.stockLegId);
    expect(handedLeg.exitPrice).toBe(handedLeg.entryPrice);
    expect(handedLeg.exitAt).toEqual(settledAt);
    expect(requirePosition(ledger, call.positionId)).toMatchObject({ status: "closed", closedAt: settledAt, closeReason: "expired_worthless" });

    const sharesPosition = openPositionsOf(ledger, "FFF")[0]!;
    expect(sharesPosition).toMatchObject({ strategyKey: "unstructured", openedAt: settledAt, unstructuredReason: "cc_expired_leftover_stock" });
    expect(legsOfPosition(ledger, sharesPosition.id)).toEqual([expect.objectContaining({ legType: "stock", quantity: 200, entryPrice: handedLeg.entryPrice, entryAt: settledAt, exitAt: null })]);
    expect(ledger.shareSources).toEqual([{ positionId: sharesPosition.id, sourcePositionId: call.positionId }]);
    expect(ledger.trades.length).toBe(tradeCountBefore);
    expectCashEqualsJournal(ledger, cashBefore);
    expect(ledgerRealizedPnl(ledger, call.positionId).stock).toBe(0);
    expect(ledgerRealizedPnl(ledger, call.positionId).premium).toBeCloseTo(98.64, 6);
    expect(ledgerFreeShares(ledger, "FFF")).toBe(200);
  });

  it("adds the shares to the symbol's unstructured position when it already holds some", () => {
    // 200 sh at 50: 100 go under a call, 100 stay uncovered. A $45 put assigned on the call's expiry day adds 100 at 45
    // (200 at 47.50); the expired call's 100 at 50 then make 300 at (9,500 + 5,000) ÷ 300 = 48.3333.
    const ledger = newLedger();
    putSettledAt(ledger, "FFF", 50, 2, 1.2, 48);
    const firstSharesPosition = openPositionsOf(ledger, "FFF")[0]!;
    const call = openCoveredCall(ledger, { symbol: "FFF", expiryDate: "2026-03-13", strike: 51, contracts: 1, callFillPrice: 0.8, stockFillPrice: null, at: decisionAt("2026-03-09"), actionId: null, splitFactorToday: 1 });
    const leftoverPositionId = call.leftoverPositionId!;
    const secondPut = openCashSecuredPut(ledger, { symbol: "FFF", expiryDate: "2026-03-13", strike: 45, contracts: 1, fillPrice: 0.6, at: decisionAt("2026-03-09"), actionId: null, splitFactorToday: 1 });

    settleExpiry(ledger, { legId: secondPut.legId, expiryClose: 44 });
    expect(legsOfPosition(ledger, leftoverPositionId)).toEqual([expect.objectContaining({ quantity: 200, entryPrice: 47.5 })]);
    expect(requirePosition(ledger, leftoverPositionId).unstructuredReason).toBe("csp_assigned_stock");
    settleExpiry(ledger, { legId: call.callLegId, expiryClose: 44 });

    expect(openPositionsOf(ledger, "FFF").map((position) => position.id)).toEqual([leftoverPositionId]);
    const sharesLeg = legsOfPosition(ledger, leftoverPositionId)[0]!;
    expect(sharesLeg).toMatchObject({ quantity: 300, entryAt: decisionAt("2026-03-09"), exitAt: null });
    expect(sharesLeg.entryPrice).toBeCloseTo(14_500 / 300, 10);
    expect(ledger.shareSources).toContainEqual({ positionId: leftoverPositionId, sourcePositionId: firstSharesPosition.id });
    expect(ledger.shareSources).toContainEqual({ positionId: leftoverPositionId, sourcePositionId: secondPut.positionId });
    expect(ledger.shareSources).toContainEqual({ positionId: leftoverPositionId, sourcePositionId: call.positionId });
    // The whole symbol through the cycle engine: 300 shares held against 300 in the open stock leg, nothing flagged.
    const cycle = ledgerCycles(ledger, "FFF", { dailyCloses: [{ date: "2026-03-06", close: 48 }, { date: "2026-03-09", close: 49 }, { date: "2026-03-13", close: 44 }] })[0]!;
    expect(cycle).toMatchObject({ status: "open", sharesHeld: 300, dataFlags: [] });
    expect(cycle.total).toBeCloseTo(ledger.cash - startingCash + 300 * 44, 6);
  });
});

describe("call-away", () => {
  it("closes the call at 0 and the shares at the strike with no stock trade, and the covered call as assigned", () => {
    // 200 sh bought at 30.015 called away at 31: +6,200 cash; stock P&L (31 − 30.015) × 200 = 197, premium 98.64.
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "GGG", expiryDate: "2026-03-06", strike: 31, contracts: 2, callFillPrice: 0.5, stockFillPrice: 30.01, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    const cashBefore = ledger.cash;
    const tradeCountBefore = ledger.trades.length;
    const settledAt = new Date("2026-03-06T21:00:00.000Z");

    expect(settleExpiry(ledger, { legId: call.callLegId, expiryClose: 33 })).toBe("call_away");

    expect(requireLeg(ledger, call.callLegId)).toMatchObject({ exitPrice: 0, exitAt: settledAt, settledAs: "assigned", expiryClose: 33 });
    expect(requireLeg(ledger, call.stockLegId)).toMatchObject({ exitPrice: 31, exitAt: settledAt });
    expect(requirePosition(ledger, call.positionId)).toMatchObject({ status: "closed", closedAt: settledAt, closeReason: "assigned" });
    expect(ledger.trades.length).toBe(tradeCountBefore);
    expect(journalOfKind(ledger, "call_away")).toEqual([6200]);
    expectCashEqualsJournal(ledger, cashBefore + 6200);
    expect(ledgerRealizedPnl(ledger, call.positionId).stock).toBeCloseTo(197, 6);
    expect(ledgerRealizedPnl(ledger, call.positionId).premium).toBeCloseTo(98.64, 6);
    expect(ledgerRealizedPnl(ledger, call.positionId).total).toBeCloseTo(ledger.cash - startingCash, 6);
    expect(isSymbolFlat(ledger, "GGG")).toBe(true);
  });
});

describe("roll", () => {
  it("closes the put at its buyback fill and opens the new contract as a new position, all at one instant", () => {
    // 2 puts $40 sold at 0.60 (+118.64), bought back at 0.90 (−180 − 1.36), 2 puts $39 sold at 1.40 (+280 − 1.36).
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "HHH", expiryDate: "2026-03-06", strike: 40, contracts: 2, fillPrice: 0.6, at: decisionAt("2026-03-02"), actionId: "action-open", splitFactorToday: 1 });
    const at = decisionAt("2026-03-05");

    const rolled = rollLeg(ledger, { legId: put.legId, newExpiryDate: "2026-03-13", newStrike: 39, buybackFillPrice: 0.9, newFillPrice: 1.4, at, actionId: "action-roll" });

    expect(rolled.closedPositionId).toBe(put.positionId);
    expect(rolled.stockLegId).toBeNull();
    expect(requireLeg(ledger, put.legId)).toMatchObject({ exitPrice: 0.9, exitAt: at, settledAs: null });
    expect(tradesOfLeg(ledger, put.legId)[1]).toMatchObject({ side: "buy", quantity: 2, price: 0.9, executedAt: at, isClosingTrade: true, actionId: "action-roll" });
    expect(tradesOfLeg(ledger, put.legId)[1]!.commission).toBeCloseTo(1.36, 10);
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closedAt: at, closeReason: "closed_via_app" });
    expect(requirePosition(ledger, rolled.positionId)).toMatchObject({ strategyKey: "cash_secured_put", status: "open", openedAt: at });
    expect(requireLeg(ledger, rolled.legId)).toMatchObject({ positionId: rolled.positionId, side: "short", optionType: "put", quantity: 2, strikePrice: 39, expiryDate: "2026-03-13", entryAt: at, exitAt: null });
    expect(requireLeg(ledger, rolled.legId).entryPrice).toBeCloseTo(1.3932, 10);
    expect(tradesOfLeg(ledger, rolled.legId)).toEqual([expect.objectContaining({ side: "sell", quantity: 2, price: 1.4, executedAt: at, isClosingTrade: false, actionId: "action-roll" })]);

    expectCashEqualsJournal(ledger, 100_000 + 118.64 - 181.36 + 278.64);
    expect(journalOfKind(ledger, "buyback")).toEqual([-180]);
    // The old put: (0.90 − 0.5932) × 200 lost, less the 1.36 closing commission.
    expect(ledgerRealizedPnl(ledger, put.positionId).total).toBeCloseTo(-62.72, 6);
    expect(ledgerCashLockedInCashSecuredPuts(ledger)).toBe(7800);
    expect(ledgerCapitalAtRisk(ledger, rolled.positionId)).toBeCloseTo(7521.36, 6);
    expect(ledger.shareSources).toEqual([]);
  });

  it("hands a covered call's shares at their entry to the new position", () => {
    // 100 sh at 30.015 under a $31 call sold at 0.50; rolled to $32: buyback 0.20 (−20 − 0.68), new call 0.70 (+70 − 0.68).
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "HHH", expiryDate: "2026-03-06", strike: 31, contracts: 1, callFillPrice: 0.5, stockFillPrice: 30.01, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    const cashBefore = ledger.cash;
    const stockTradeCountBefore = tradesOfLeg(ledger, call.stockLegId).length;
    const at = decisionAt("2026-03-05");

    const rolled = rollLeg(ledger, { legId: call.callLegId, newExpiryDate: "2026-03-13", newStrike: 32, buybackFillPrice: 0.2, newFillPrice: 0.7, at, actionId: "action-roll" });

    const oldStockLeg = requireLeg(ledger, call.stockLegId);
    expect(oldStockLeg.exitPrice).toBe(oldStockLeg.entryPrice);
    expect(oldStockLeg.exitAt).toEqual(at);
    expect(requireLeg(ledger, call.callLegId)).toMatchObject({ exitPrice: 0.2, exitAt: at });
    expect(requirePosition(ledger, call.positionId)).toMatchObject({ status: "closed", closedAt: at, closeReason: "closed_via_app" });
    expect(requirePosition(ledger, rolled.positionId)).toMatchObject({ strategyKey: "covered_call", status: "open", openedAt: at });
    expect(requireLeg(ledger, rolled.stockLegId!)).toMatchObject({ positionId: rolled.positionId, quantity: 100, entryPrice: oldStockLeg.entryPrice, entryAt: at, exitAt: null });
    expect(requireLeg(ledger, rolled.legId)).toMatchObject({ optionType: "call", strikePrice: 32, expiryDate: "2026-03-13", quantity: 1 });
    expect(requireLeg(ledger, rolled.legId).entryPrice).toBeCloseTo(0.6932, 10);
    expect(ledger.shareSources).toEqual([{ positionId: rolled.positionId, sourcePositionId: call.positionId }]);
    expect(tradesOfLeg(ledger, call.stockLegId)).toHaveLength(stockTradeCountBefore);
    expect(tradesOfLeg(ledger, rolled.stockLegId!)).toHaveLength(0);
    expectCashEqualsJournal(ledger, cashBefore - 20 - 0.68 + 70 - 0.68);
    expect(ledgerFreeShares(ledger, "HHH")).toBe(0);
  });
});

describe("buyback of a put", () => {
  it("closes the leg at the fill with the commission on the closing trade, and the position as closed via app", () => {
    // Sold at 1.20 (entry 1.1932), bought back at 0.30: (1.1932 − 0.30) × 100 − 0.68 = 88.64.
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "III", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: "action-open", splitFactorToday: 3 });
    const at = decisionAt("2026-03-04");

    buyBackPut(ledger, { legId: put.legId, fillPrice: 0.3, at, actionId: "action-close" });

    expect(requireLeg(ledger, put.legId)).toMatchObject({ exitPrice: 0.3, exitAt: at, settledAs: null });
    expect(tradesOfLeg(ledger, put.legId)[1]).toMatchObject({ side: "buy", quantity: 1, price: 0.3, commission: 0.68, executedAt: at, isClosingTrade: true, actionId: "action-close" });
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closedAt: at, closeReason: "closed_via_app" });
    expectCashEqualsJournal(ledger, 100_119.32 - 30 - 0.68);
    expect(ledgerRealizedPnl(ledger, put.positionId).total).toBeCloseTo(88.64, 6);
    expect(ledgerCashLockedInCashSecuredPuts(ledger)).toBe(0);
    expect(isSymbolFlat(ledger, "III")).toBe(true);
  });

  it("refuses to buy back only the call of a covered call", () => {
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "III", expiryDate: "2026-03-06", strike: 31, contracts: 1, callFillPrice: 0.5, stockFillPrice: 30.01, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    expect(() => buyBackPut(ledger, { legId: call.callLegId, fillPrice: 0.1, at: decisionAt("2026-03-04"), actionId: null })).toThrow(/only a put/);
  });
});

describe("whole covered-call close", () => {
  it("exits both legs at their fills, each commission on its closing trade", () => {
    // 100 sh at 31.01 + 0.50 (entry 31.015), a $32 call at 0.55 (entry 0.5432). Closed: call bought at 0.30, shares sold at 31.49.
    // Call (0.5432 − 0.30) × 100 − 0.68 = 23.64; shares (31.49 − 31.015) × 100 − 0.50 = 47.00; cash +70.64 over the whole trade.
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "JJJ", expiryDate: "2026-03-27", strike: 32, contracts: 1, callFillPrice: 0.55, stockFillPrice: 31.01, at: decisionAt("2026-03-16"), actionId: "action-open", splitFactorToday: 1 });
    const at = decisionAt("2026-03-18");

    closeCoveredCall(ledger, { positionId: call.positionId, callFillPrice: 0.3, stockFillPrice: 31.49, at, actionId: "action-close" });

    expect(requireLeg(ledger, call.callLegId)).toMatchObject({ exitPrice: 0.3, exitAt: at, settledAs: null });
    expect(requireLeg(ledger, call.stockLegId).exitPrice).toBeCloseTo(31.49, 10);
    expect(requireLeg(ledger, call.stockLegId).exitAt).toEqual(at);
    expect(tradesOfLeg(ledger, call.callLegId)[1]).toMatchObject({ side: "buy", quantity: 1, price: 0.3, commission: 0.68, isClosingTrade: true, executedAt: at, actionId: "action-close" });
    expect(tradesOfLeg(ledger, call.stockLegId)[1]).toMatchObject({ side: "sell", quantity: 100, commission: 0.5, isClosingTrade: true, executedAt: at, actionId: "action-close" });
    expect(requirePosition(ledger, call.positionId)).toMatchObject({ status: "closed", closedAt: at, closeReason: "closed_via_app" });
    expectCashEqualsJournal(ledger, 100_070.64);
    const realized = ledgerRealizedPnl(ledger, call.positionId);
    expect(realized.premium).toBeCloseTo(23.64, 6);
    expect(realized.stock).toBeCloseTo(47, 6);
    expect(isSymbolFlat(ledger, "JJJ")).toBe(true);
  });
});

describe("a buy-write opened and closed at the same look", () => {
  it("leaves the cycle's shares as the book holds them: the cycle derivation takes the shares in before it sells them", () => {
    // 500 shares under a call since 16 March; on the 18th one look opens a 24-contract buy-write and, in its next pass,
    // closes it whole: the purchase and the sale carry the same instant (HOOD 2024-09-30 11:00 in the step-5 session).
    const ledger = createSimulatedLedger(1_000_000, easternInstant("2026-03-02", 9, 30));
    openCoveredCall(ledger, { symbol: "SMI", expiryDate: "2026-03-27", strike: 24, contracts: 5, callFillPrice: 0.4, stockFillPrice: 23.01, at: decisionAt("2026-03-16"), actionId: "action-held", splitFactorToday: 1 });
    const at = easternInstant("2026-03-18", 11, 0);
    const buyWrite = openCoveredCall(ledger, { symbol: "SMI", expiryDate: "2026-03-20", strike: 24, contracts: 24, callFillPrice: 0.34, stockFillPrice: 23.32, at, actionId: "action-open", splitFactorToday: 1 });
    closeCoveredCall(ledger, { positionId: buyWrite.positionId, callFillPrice: 0.35, stockFillPrice: 23.3, at, actionId: "action-close" });

    expect(ledgerFreeShares(ledger, "SMI")).toBe(0);
    const [cycle] = ledgerCycles(ledger, "SMI", { dailyCloses: [{ date: "2026-03-17", close: 23.2 }, { date: "2026-03-18", close: 23.4 }] });
    expect(cycle!.dataFlags).toEqual([]);
    expect(cycle!.sharesHeld).toBe(500);
  });

  it("refuses to sell more shares than a position holds, and a call assigned on shares its position does not hold", () => {
    const ledger = newLedger();
    putSettledAt(ledger, "SMJ", 20, 1, 0.4, 19.5);
    const sharesPosition = openPositionsOf(ledger, "SMJ")[0]!;
    expect(() => sellShares(ledger, { positionId: sharesPosition.id, shares: 200, fillPrice: 20, at: decisionAt("2026-03-10"), actionId: null })).toThrow("holds 100 shares; cannot sell 200");
    const call = openCoveredCall(ledger, { symbol: "SMK", expiryDate: "2026-03-13", strike: 50, contracts: 2, callFillPrice: 0.5, stockFillPrice: 49, at: decisionAt("2026-03-09"), actionId: null, splitFactorToday: 1 });
    requireLeg(ledger, call.stockLegId).quantity = 100;
    expect(() => settleExpiry(ledger, { legId: call.callLegId, expiryClose: 52 })).toThrow(`Covered call ${call.positionId} is assigned on 200 shares but holds 100.`);
  });
});

describe("stock sale", () => {
  it("closes the stock leg at the fill and the position as closed via app when every share is sold", () => {
    // 100 sh assigned at 20 sold at 20.99: (20.99 − 20) × 100 − 0.50 = 98.50.
    const ledger = newLedger();
    putSettledAt(ledger, "KKK", 20, 1, 0.4, 19.5);
    const sharesPosition = openPositionsOf(ledger, "KKK")[0]!;
    const sharesLeg = legsOfPosition(ledger, sharesPosition.id)[0]!;
    const cashBefore = ledger.cash;
    const at = decisionAt("2026-03-10");

    const sale = sellShares(ledger, { positionId: sharesPosition.id, shares: 100, fillPrice: 20.99, at, actionId: "action-sell" });

    expect(sale).toEqual({ soldLegId: sharesLeg.id, positionClosed: true });
    expect(sharesLeg.exitPrice).toBeCloseTo(20.99, 10);
    expect(sharesLeg).toMatchObject({ exitAt: at, quantity: 100, parentLegId: null });
    expect(tradesOfLeg(ledger, sharesLeg.id)[1]).toMatchObject({ side: "sell", quantity: 100, commission: 0.5, isClosingTrade: true, executedAt: at, actionId: "action-sell" });
    expect(sharesPosition).toMatchObject({ status: "closed", closedAt: at, closeReason: "closed_via_app" });
    expectCashEqualsJournal(ledger, cashBefore + 2099 - 0.5);
    expect(ledgerRealizedPnl(ledger, sharesPosition.id).stock).toBeCloseTo(98.5, 6);
    expect(isSymbolFlat(ledger, "KKK")).toBe(true);
  });

  it("carves a partial sale into its own closed leg, which takes the closing trade, and keeps the rest open", () => {
    // 200 sh at 30, 40 sold at 30.49: (30.49 − 30) × 40 − 0.20 = 19.40. EXP $ 160 × 30; the P&L base keeps all 200.
    const ledger = newLedger();
    putSettledAt(ledger, "KKK", 30, 2, 0.5, 29);
    const sharesPosition = openPositionsOf(ledger, "KKK")[0]!;
    const sharesLeg = legsOfPosition(ledger, sharesPosition.id)[0]!;
    const cashBefore = ledger.cash;
    const at = decisionAt("2026-03-10");
    expect(() => sellShares(ledger, { positionId: sharesPosition.id, shares: 201, fillPrice: 30, at, actionId: null })).toThrow(/holds 200 shares/);

    const sale = sellShares(ledger, { positionId: sharesPosition.id, shares: 40, fillPrice: 30.49, at, actionId: "action-sell" });

    expect(sale.positionClosed).toBe(false);
    expect(sale.soldLegId).not.toBe(sharesLeg.id);
    const soldLeg = requireLeg(ledger, sale.soldLegId);
    expect(soldLeg).toMatchObject({ positionId: sharesPosition.id, parentLegId: sharesLeg.id, legType: "stock", quantity: 40, entryPrice: 30, entryAt: sharesLeg.entryAt, exitAt: at });
    expect(soldLeg.exitPrice).toBeCloseTo(30.49, 10);
    expect(sharesLeg).toMatchObject({ quantity: 160, exitPrice: null, exitAt: null });
    expect(tradesOfLeg(ledger, soldLeg.id)).toEqual([expect.objectContaining({ side: "sell", quantity: 40, isClosingTrade: true, executedAt: at })]);
    expect(tradesOfLeg(ledger, sharesLeg.id).filter((trade) => trade.isClosingTrade)).toHaveLength(0);
    expect(sharesPosition.status).toBe("open");
    expectCashEqualsJournal(ledger, cashBefore + 1219.6 - 0.2);
    expect(ledgerRealizedPnl(ledger, sharesPosition.id).stock).toBeCloseTo(19.4, 6);
    expect(ledgerFreeShares(ledger, "KKK")).toBe(160);
    expect(ledgerCapitalAtRisk(ledger, sharesPosition.id)).toBe(4800);
    expect(ledgerCapitalDeployed(ledger, sharesPosition.id)).toBe(6000);
  });
});

describe("cycle closes", () => {
  it("ends the cycle when the symbol is flat, and the next one takes the split scale of its own first day", () => {
    const ledger = newLedger();
    const firstPut = openCashSecuredPut(ledger, { symbol: "LLL", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 4 });
    // A second put opened after a split still belongs to the cycle that began on the factor-4 scale.
    const secondPut = openCashSecuredPut(ledger, { symbol: "LLL", expiryDate: "2026-03-06", strike: 48, contracts: 1, fillPrice: 0.9, at: decisionAt("2026-03-04"), actionId: null, splitFactorToday: 2 });
    expect(cycleSplitFactorFor(ledger, "LLL", 2)).toBe(4);

    settleExpiry(ledger, { legId: firstPut.legId, expiryClose: 52 });
    expect(cycleSplitFactorFor(ledger, "LLL", 2)).toBe(4);
    settleExpiry(ledger, { legId: secondPut.legId, expiryClose: 52 });
    expect(isSymbolFlat(ledger, "LLL")).toBe(true);
    expect(cycleSplitFactorFor(ledger, "LLL", 2)).toBe(2);

    const cycles = ledgerCycles(ledger, "LLL", { dailyCloses: [{ date: "2026-03-06", close: 52 }] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "closed", startAt: decisionAt("2026-03-02"), endAt: new Date("2026-03-06T21:00:00.000Z"), sharesHeld: 0, dataFlags: [] });
    // 1.20 × 100 − 0.68 + 0.90 × 100 − 0.68.
    expect(cycles[0]!.total).toBeCloseTo(208.64, 6);

    openCashSecuredPut(ledger, { symbol: "LLL", expiryDate: "2026-03-13", strike: 25, contracts: 1, fillPrice: 0.5, at: decisionAt("2026-03-09"), actionId: null, splitFactorToday: 2 });
    expect(cycleSplitFactorFor(ledger, "LLL", 1)).toBe(2);
    expect(ledgerCycles(ledger, "LLL", { dailyCloses: [{ date: "2026-03-06", close: 52 }] }).map((cycle) => cycle.status)).toEqual(["closed", "open"]);
  });
});

describe("a symbol flat and reopened", () => {
  // The platform's cycle derivation groups events within 120 seconds into one step: a symbol closed and reopened inside
  // that window never ends its cycle. The ledger keeps the cycle's price scale over the same window.
  it("stays in the same cycle, on its scale, when the reopening is within the grouping window", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "MMM", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 4 });
    // Bought back on 4 March, after a 2-for-1 split (today's factor 2).
    const at = decisionAt("2026-03-04");
    buyBackPut(ledger, { legId: put.legId, fillPrice: 0.4, at, actionId: null });
    expect(isSymbolFlat(ledger, "MMM")).toBe(true);
    // Asked without an instant, or later than the window: the next cycle's scale. Inside the window: the closed cycle's.
    expect(cycleSplitFactorFor(ledger, "MMM", 2)).toBe(2);
    expect(cycleSplitFactorFor(ledger, "MMM", 2, at)).toBe(4);
    expect(cycleSplitFactorFor(ledger, "MMM", 2, new Date(at.getTime() + cycleGroupingWindowMs))).toBe(4);
    expect(cycleSplitFactorFor(ledger, "MMM", 2, new Date(at.getTime() + cycleGroupingWindowMs + 1))).toBe(2);

    // A put sold in a later pass of the same look: $24 as traded today is $48 on the cycle's scale, 50 of its shares a contract.
    const reopened = openCashSecuredPut(ledger, { symbol: "MMM", expiryDate: "2026-03-13", strike: 48, contracts: 1, fillPrice: 0.9, at, actionId: null, splitFactorToday: 2, sharesPerContract: 50 });
    expect(cycleSplitFactorFor(ledger, "MMM", 2)).toBe(4);
    expect(requireLeg(ledger, reopened.legId)).toMatchObject({ strikePrice: 48, multiplier: 50 });
    const cycles = ledgerCycles(ledger, "MMM", { dailyCloses: [] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", startAt: decisionAt("2026-03-02"), endAt: null });
  });

  it("starts a new cycle on that day's scale when the reopening is later than the grouping window", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "NNN", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 4 });
    const at = decisionAt("2026-03-04");
    buyBackPut(ledger, { legId: put.legId, fillPrice: 0.4, at, actionId: null });
    openCashSecuredPut(ledger, { symbol: "NNN", expiryDate: "2026-03-13", strike: 24, contracts: 1, fillPrice: 0.45, at: new Date(at.getTime() + cycleGroupingWindowMs + 1), actionId: null, splitFactorToday: 2 });
    expect(cycleSplitFactorFor(ledger, "NNN", 2)).toBe(2);
    expect(ledgerCycles(ledger, "NNN", { dailyCloses: [] }).map((cycle) => cycle.status)).toEqual(["closed", "open"]);
  });
});

describe("interest and the cash journal", () => {
  it("credits interest to cash with no symbol, and the journal always sums to the cash", () => {
    const ledger = newLedger();
    creditInterest(ledger, decisionAt("2026-03-03"), 12.5);
    expect(ledger.cashJournal).toEqual([
      expect.objectContaining({ kind: "deposit", amount: 100_000, symbol: null }),
      expect.objectContaining({ kind: "interest", amount: 12.5, symbol: null, positionId: null, legId: null }),
    ]);
    expectCashEqualsJournal(ledger, 100_012.5);
  });
});
