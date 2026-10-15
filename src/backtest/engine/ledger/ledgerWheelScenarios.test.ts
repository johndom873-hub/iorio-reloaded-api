import { describe, expect, it } from "vitest";
import { easternInstant } from "../../../lib/easternIsoDate.js";
import { checkCalledAway, commissionPerShare } from "../../../pluto/heldShareCalls.js";
import { buyBackCoveredCallKeepingShares, openCashSecuredPut, openCoveredCall, rollLeg, sellShares, settleExpiry } from "./ledgerEvents.js";
import { stockPurchaseFillPrice, stockSaleFillPrice } from "./ledgerFills.js";
import { ledgerBreakEvenForPosition, ledgerCycles, ledgerFreeShares, ledgerHeldSharesAverageCost, ledgerLatestShareAcquisitionPrice, ledgerOpenCycleSummary, ledgerTotalRealizedPnl } from "./ledgerSelectors.js";
import { createSimulatedLedger, type SimulatedLedger } from "./simulatedLedger.js";

// Whole wheels through the simulated ledger, worked by hand, read back through the live cycle engine (deriveCycles),
// the live break-even (summarizeOpenCycle) and Pluto's held-shares rule (checkCalledAway). In each, the cash the
// symbol moved equals the cycle's total, bucket by bucket, with no data flag. $0.68 per contract, $0.005 per share.

const startingCash = 100_000;
const decisionAt = (dateIso: string) => easternInstant(dateIso, 10, 0);
const newLedger = () => createSimulatedLedger(startingCash, easternInstant("2026-03-02", 9, 30));
const symbolCash = (ledger: SimulatedLedger, symbol: string) => ledger.cashJournal.filter((entry) => entry.symbol === symbol).reduce((sum, entry) => sum + entry.amount, 0);
// Pluto's minimum profit on shares: 1% of their cost, at least $50.
const profitFloorSettings = { unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50 };

describe("ledgerLatestShareAcquisitionPrice", () => {
  it("reads the latest purchase or assignment of the symbol's shares, not their average cost", () => {
    const ledger = newLedger();
    expect(ledgerLatestShareAcquisitionPrice(ledger, "WHL")).toBeNull();
    openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 52, contracts: 1, callFillPrice: 0.9, stockFillPrice: 50.01, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 50, contracts: 1, callFillPrice: 1.1, stockFillPrice: 47.01, at: decisionAt("2026-03-03"), actionId: "action-2", splitFactorToday: 1 });
    expect(ledgerLatestShareAcquisitionPrice(ledger, "WHL")).toBe(47.01);
    // Another symbol's purchase and an assignment of this one.
    openCoveredCall(ledger, { symbol: "OTH", expiryDate: "2026-03-06", strike: 20, contracts: 1, callFillPrice: 0.5, stockFillPrice: 19.01, at: decisionAt("2026-03-04"), actionId: "action-3", splitFactorToday: 1 });
    expect(ledgerLatestShareAcquisitionPrice(ledger, "WHL")).toBe(47.01);
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 45, contracts: 1, fillPrice: 1, at: decisionAt("2026-03-04"), actionId: "action-4", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 44 });
    expect(ledgerLatestShareAcquisitionPrice(ledger, "WHL")).toBe(45);
  });
});

describe("ledgerHeldSharesAverageCost", () => {
  // Marcelo's worked example: hold 300 @ $50, buy 100 @ $40 → $47.50; 100 called away → 300 left, still $47.50; buy 100 @ $60
  // → (300 × 47.50 + 100 × 60) ÷ 400 = $50.625 (the cycle's cost per share acquired counts the 100 called away: $50.00).
  it("averages the shares held over their fills, unchanged by shares leaving, afresh once none are held", () => {
    const ledger = newLedger();
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeNull();
    openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 56, contracts: 3, callFillPrice: 0.9, stockFillPrice: 50, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    const second = openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 48, contracts: 1, callFillPrice: 1.1, stockFillPrice: 40, at: decisionAt("2026-03-03"), actionId: "action-2", splitFactorToday: 1 });
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeCloseTo(47.5, 10);
    // 6 Mar close 55: the $48 call takes its 100 shares away; the $56 call expires and its 300 shares wait uncovered.
    const firstCallLegId = ledger.legs.find((leg) => leg.legType === "option" && leg.strikePrice === 56)!.id;
    expect(settleExpiry(ledger, { legId: second.callLegId, expiryClose: 55 })).toBe("call_away");
    expect(settleExpiry(ledger, { legId: firstCallLegId, expiryClose: 55 })).toBe("call_worthless");
    expect(ledgerFreeShares(ledger, "WHL")).toBe(300);
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeCloseTo(47.5, 10);
    // A buy-write buying every share leaves the 300 uncovered ones where they are.
    const third = openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-13", strike: 62, contracts: 1, callFillPrice: 1, stockFillPrice: 60, at: decisionAt("2026-03-09"), actionId: "action-3", splitFactorToday: 1, buyEveryShare: true });
    expect(third).toMatchObject({ sharesBought: 100, sharesFromHeld: 0, leftoverPositionId: null });
    expect(ledgerFreeShares(ledger, "WHL")).toBe(300);
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeCloseTo(50.625, 10);
    const cycle = ledgerOpenCycleSummary(ledger, "WHL")!;
    expect(cycle.acquisitionCost / cycle.sharesAcquired).toBeCloseTo(50, 1);
    // Selling the 300 uncovered shares leaves the average; the last 100 called away clear it; the next purchase sets it.
    const pool = ledger.positions.find((position) => position.status === "open" && position.strategyKey === "unstructured")!;
    sellShares(ledger, { positionId: pool.id, shares: 300, fillPrice: 58, at: decisionAt("2026-03-10"), actionId: "action-4" });
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeCloseTo(50.625, 10);
    expect(settleExpiry(ledger, { legId: third.callLegId, expiryClose: 63 })).toBe("call_away");
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBeNull();
    openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-20", strike: 66, contracts: 2, callFillPrice: 1, stockFillPrice: 64, at: decisionAt("2026-03-16"), actionId: "action-5", splitFactorToday: 1 });
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBe(64);
    // Another symbol's shares never enter it.
    openCoveredCall(ledger, { symbol: "OTH", expiryDate: "2026-03-20", strike: 21, contracts: 1, callFillPrice: 0.5, stockFillPrice: 19, at: decisionAt("2026-03-16"), actionId: "action-6", splitFactorToday: 1 });
    expect(ledgerHeldSharesAverageCost(ledger, "WHL")).toBe(64);
  });
});

describe("put assigned, a call expires, the next call takes the shares", () => {
  //  2 Mar  sell 1 put $50 6 Mar @ 1.20      cash +120 − 0.68 = +119.32      put-only break-even 50 − 1.1932 = 48.8068
  //  6 Mar  close 48.00: assigned            cash −5,000                      break-even (5,000 − 119.32) ÷ 100 = 48.8068
  //  9 Mar  sell 1 call $51 13 Mar @ 0.80    cash +80 − 0.68 = +79.32         break-even (5,000 − 198.64) ÷ 100 = 48.0136
  // 13 Mar  close 50.50: worthless
  // 16 Mar  sell 1 call $50 20 Mar @ 0.90    cash +90 − 0.68 = +89.32         break-even (5,000 − 287.96) ÷ 100 = 47.1204
  // 20 Mar  close 52.00: called away at 50   cash +5,000                      cycle total 119.32 + 79.32 + 89.32 = 287.96
  // Buckets, shares valued at the daily close when they change hands (48.00, 49.00, 50.50, 50.80):
  //   put            119.32 − (50 − 48.00) × 100                                   = −80.68
  //   shares alone   (49.00 − 48.00) × 100 + (50.80 − 50.50) × 100                 = 130.00
  //   covered calls  79.32 + (50.50 − 49.00) × 100 + 89.32 + (50 − 50.80) × 100    = 238.64
  const dailyCloses = [{ date: "2026-03-06", close: 48 }, { date: "2026-03-09", close: 49 }, { date: "2026-03-13", close: 50.5 }, { date: "2026-03-16", close: 50.8 }, { date: "2026-03-20", close: 52 }];
  const closesThrough = (dateIso: string) => dailyCloses.filter((bar) => bar.date <= dateIso);

  it("keeps cash, cycle and break-even in step at every stage", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    expect(ledgerOpenCycleSummary(ledger, "WHL")).toMatchObject({ sharesHeld: 0, breakEvenPerShare: null, unavailableReason: null, openShortPuts: [{ positionId: put.positionId, strike: 50, shares: 100 }] });
    expect(ledgerBreakEvenForPosition(ledger, put.positionId).breakEven).toBeCloseTo(48.8068, 6);

    expect(settleExpiry(ledger, { legId: put.legId, expiryClose: 48 })).toBe("put_assigned");
    let summary = ledgerOpenCycleSummary(ledger, "WHL")!;
    expect(summary).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, acquisitionCost: 5000, unavailableReason: null });
    expect(summary.netPremium).toBeCloseTo(119.32, 6);
    expect(summary.breakEvenPerShare).toBeCloseTo(48.8068, 6);
    let cycles = ledgerCycles(ledger, "WHL", { dailyCloses: closesThrough("2026-03-06") });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 100, dataFlags: [] });
    expect(cycles[0]!.breakEvenPerShare).toBeCloseTo(48.8068, 6);
    // Open cycle: the cash so far plus the shares at the last close, 119.32 − 5,000 + 100 × 48.
    expect(cycles[0]!.total).toBeCloseTo(-80.68, 6);
    expect(cycles[0]!.total).toBeCloseTo(symbolCash(ledger, "WHL") + 100 * 48, 6);
    expect(ledgerFreeShares(ledger, "WHL")).toBe(100);

    // Pluto's rule for a call on these shares: a $51 call at 0.80 leaves a break-even of 48.8068 − 0.7932 = 48.0136 and
    // (51 − 48.0136) × 100 = 298.64 if called away, over the floor of max(1% × 50 × 100, 50) = 50. A $48.50 call would leave 48.64.
    const firstCallCheck = checkCalledAway({ cycle: summary, strike: 51, contracts: 1, cashPerShareCovered: 0.8 - commissionPerShare(undefined), settings: profitFloorSettings });
    expect(firstCallCheck.check).toMatchObject({ floor: 50, passes: true });
    expect(firstCallCheck.check!.breakEvenAfter).toBeCloseTo(48.0136, 6);
    expect(firstCallCheck.check!.profitIfCalledAway).toBeCloseTo(298.64, 6);
    const tooLowCheck = checkCalledAway({ cycle: summary, strike: 48.5, contracts: 1, cashPerShareCovered: 0.8 - commissionPerShare(undefined), settings: profitFloorSettings });
    expect(tooLowCheck.check!.profitIfCalledAway).toBeCloseTo(48.64, 6);
    expect(tooLowCheck.check!.passes).toBe(false);

    const firstCall = openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-13", strike: 51, contracts: 1, callFillPrice: 0.8, stockFillPrice: null, at: decisionAt("2026-03-09"), actionId: "action-2", splitFactorToday: 1 });
    summary = ledgerOpenCycleSummary(ledger, "WHL")!;
    expect(summary.breakEvenPerShare).toBeCloseTo(firstCallCheck.check!.breakEvenAfter, 6);
    expect(ledgerBreakEvenForPosition(ledger, firstCall.positionId).breakEven).toBeCloseTo(48.0136, 6);
    expect(ledgerFreeShares(ledger, "WHL")).toBe(0);

    expect(settleExpiry(ledger, { legId: firstCall.callLegId, expiryClose: 50.5 })).toBe("call_worthless");
    summary = ledgerOpenCycleSummary(ledger, "WHL")!;
    expect(summary).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, acquisitionCost: 5000, unavailableReason: null });
    expect(summary.breakEvenPerShare).toBeCloseTo(48.0136, 6);
    expect(ledgerFreeShares(ledger, "WHL")).toBe(100);
    cycles = ledgerCycles(ledger, "WHL", { dailyCloses: closesThrough("2026-03-13") });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 100, dataFlags: [] });
    expect(cycles[0]!.total).toBeCloseTo(symbolCash(ledger, "WHL") + 100 * 50.5, 6);

    // The $50 call at 0.90: break-even 48.0136 − 0.8932 = 47.1204, (50 − 47.1204) × 100 = 287.96 if called away.
    const secondCallCheck = checkCalledAway({ cycle: summary, strike: 50, contracts: 1, cashPerShareCovered: 0.9 - commissionPerShare(undefined), settings: profitFloorSettings });
    expect(secondCallCheck.check!.breakEvenAfter).toBeCloseTo(47.1204, 6);
    expect(secondCallCheck.check!.profitIfCalledAway).toBeCloseTo(287.96, 6);
    expect(secondCallCheck.check!.passes).toBe(true);

    const secondCall = openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-20", strike: 50, contracts: 1, callFillPrice: 0.9, stockFillPrice: null, at: decisionAt("2026-03-16"), actionId: "action-3", splitFactorToday: 1 });
    expect(ledgerOpenCycleSummary(ledger, "WHL")!.breakEvenPerShare).toBeCloseTo(47.1204, 6);

    expect(settleExpiry(ledger, { legId: secondCall.callLegId, expiryClose: 52 })).toBe("call_away");
    expect(ledgerOpenCycleSummary(ledger, "WHL")).toBeNull();
    cycles = ledgerCycles(ledger, "WHL", { dailyCloses });
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle).toMatchObject({ status: "closed", startAt: decisionAt("2026-03-02"), endAt: new Date("2026-03-20T20:00:00.000Z"), sharesHeld: 0, dataFlags: [] });
    expect(cycle.buckets.csp.total).toBeCloseTo(-80.68, 6);
    expect(cycle.buckets.csp.capital).toBe(5000);
    expect(cycle.buckets.unstructured.total).toBeCloseTo(130, 6);
    expect(cycle.buckets.cc.total).toBeCloseTo(238.64, 6);
    expect(cycle.buckets.hedge.total).toBe(0);
    expect(cycle.total).toBeCloseTo(287.96, 6);
    // The cycle made what the rule said the call would leave if assigned, and it is the cash the symbol moved.
    expect(cycle.total).toBeCloseTo(secondCallCheck.check!.profitIfCalledAway, 6);
    expect(symbolCash(ledger, "WHL")).toBeCloseTo(287.96, 6);
    expect(ledger.cash).toBeCloseTo(100_287.96, 6);
    expect(ledgerTotalRealizedPnl(ledger)).toBeCloseTo(287.96, 6);
  });
});

describe("put rolled, then expiring", () => {
  //  2 Mar  sell 2 puts $40 6 Mar @ 0.60                          cash +120 − 1.36 = +118.64    break-even 40 − 118.64 ÷ 200 = 39.4068
  //  5 Mar  buy them back @ 0.90, sell 2 puts $39 13 Mar @ 1.40   cash −180 − 1.36 + 280 − 1.36 = +97.28
  //         net premium 118.64 − 181.36 + 278.64 = 215.92         break-even 39 − 215.92 ÷ 200 = 37.9204
  // 13 Mar  close 39.00, at the strike: worthless                 cycle total 215.92, all in the put bucket, on 8,000 + 7,800 of capital
  it("stays one cycle through the roll and ends with the net premium of both puts", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "ROL", expiryDate: "2026-03-06", strike: 40, contracts: 2, fillPrice: 0.6, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    expect(ledgerBreakEvenForPosition(ledger, put.positionId).breakEven).toBeCloseTo(39.4068, 6);

    const rolled = rollLeg(ledger, { legId: put.legId, newExpiryDate: "2026-03-13", newStrike: 39, buybackFillPrice: 0.9, newFillPrice: 1.4, at: decisionAt("2026-03-05"), actionId: "action-2" });
    const summary = ledgerOpenCycleSummary(ledger, "ROL")!;
    expect(summary).toMatchObject({ sharesHeld: 0, sharesAcquired: 0, unavailableReason: null, openShortPuts: [{ positionId: rolled.positionId, strike: 39, shares: 200 }] });
    expect(summary.netPremium).toBeCloseTo(215.92, 6);
    expect(ledgerBreakEvenForPosition(ledger, rolled.positionId).breakEven).toBeCloseTo(37.9204, 6);
    let cycles = ledgerCycles(ledger, "ROL", { dailyCloses: [{ date: "2026-03-05", close: 39.5 }] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 0, dataFlags: [] });
    expect(cycles[0]!.total).toBeCloseTo(215.92, 6);

    expect(settleExpiry(ledger, { legId: rolled.legId, expiryClose: 39 })).toBe("put_worthless");
    expect(ledgerOpenCycleSummary(ledger, "ROL")).toBeNull();
    cycles = ledgerCycles(ledger, "ROL", { dailyCloses: [{ date: "2026-03-05", close: 39.5 }, { date: "2026-03-13", close: 39 }] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "closed", startAt: decisionAt("2026-03-02"), endAt: new Date("2026-03-13T20:00:00.000Z"), sharesHeld: 0, dataFlags: [] });
    expect(cycles[0]!.buckets.csp.total).toBeCloseTo(215.92, 6);
    expect(cycles[0]!.buckets.csp.capital).toBe(15_800);
    expect(cycles[0]!.total).toBeCloseTo(215.92, 6);
    expect(symbolCash(ledger, "ROL")).toBeCloseTo(215.92, 6);
    expect(ledger.cash).toBeCloseTo(100_215.92, 6);
    expect(ledgerTotalRealizedPnl(ledger)).toBeCloseTo(215.92, 6);
  });
});

describe("buy-write called away", () => {
  //  2 Mar  buy 200 sh @ 30.01 (stock 30.00), sell 2 calls $31 6 Mar @ 0.50    cash −6,002 − 1.00 + 100 − 1.36 = −5,904.36
  //         shares cost 6,003 (30.015 each); break-even (6,003 − 98.64) ÷ 200 = 29.5218
  //  6 Mar  close 31.01, a cent in the money: called away at 31                cash +6,200
  //         cycle total 98.64 + (31 − 30.015) × 200 = 295.64, all in the covered-call bucket, on 6,003 of capital
  it("books the premium and the shares' gain to the covered-call bucket", () => {
    const ledger = newLedger();
    const call = openCoveredCall(ledger, { symbol: "BWR", expiryDate: "2026-03-06", strike: 31, contracts: 2, callFillPrice: 0.5, stockFillPrice: stockPurchaseFillPrice(30), at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    const summary = ledgerOpenCycleSummary(ledger, "BWR")!;
    expect(summary).toMatchObject({ sharesHeld: 200, sharesAcquired: 200, unavailableReason: null });
    expect(summary.acquisitionCost).toBeCloseTo(6003, 6);
    expect(summary.netPremium).toBeCloseTo(98.64, 6);
    expect(summary.breakEvenPerShare).toBeCloseTo(29.5218, 6);
    let cycles = ledgerCycles(ledger, "BWR", { dailyCloses: [{ date: "2026-03-02", close: 30 }] });
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 200, dataFlags: [] });
    expect(cycles[0]!.breakEvenPerShare).toBeCloseTo(29.5218, 6);
    // The cash so far plus 200 shares at the 30.00 close: −5,904.36 + 6,000.
    expect(cycles[0]!.total).toBeCloseTo(95.64, 6);

    expect(settleExpiry(ledger, { legId: call.callLegId, expiryClose: 31.01 })).toBe("call_away");
    expect(ledgerOpenCycleSummary(ledger, "BWR")).toBeNull();
    cycles = ledgerCycles(ledger, "BWR", { dailyCloses: [{ date: "2026-03-02", close: 30 }, { date: "2026-03-06", close: 31.01 }] });
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle).toMatchObject({ status: "closed", sharesHeld: 0, dataFlags: [] });
    expect(cycle.buckets.cc.premium).toBeCloseTo(98.64, 6);
    expect(cycle.buckets.cc.stock).toBeCloseTo(197, 6);
    expect(cycle.buckets.cc.capital).toBeCloseTo(6003, 6);
    expect(cycle.buckets.csp.total).toBe(0);
    expect(cycle.buckets.unstructured.total).toBe(0);
    expect(cycle.total).toBeCloseTo(295.64, 6);
    // Called away at the strike, the shares leave (31 − break-even) each.
    expect(cycle.total).toBeCloseTo((31 - summary.breakEvenPerShare!) * 200, 6);
    expect(symbolCash(ledger, "BWR")).toBeCloseTo(295.64, 6);
    expect(ledger.cash).toBeCloseTo(100_295.64, 6);
    expect(ledgerTotalRealizedPnl(ledger)).toBeCloseTo(295.64, 6);
  });
});

describe("put assigned, shares sold at a profit", () => {
  //  2 Mar  sell 1 put $20 6 Mar @ 0.40           cash +40 − 0.68 = +39.32
  //  6 Mar  close 19.50: assigned                 cash −2,000         break-even (2,000 − 39.32) ÷ 100 = 19.6068
  // 10 Mar  sell 100 sh @ 20.99 (stock 21.00)     cash +2,099 − 0.50  cycle total 39.32 + 2,098.50 − 2,000 = 137.82
  // Buckets: put 39.32 − (20 − 19.50) × 100 = −10.68; shares alone (20.985 − 19.50) × 100 = 148.50.
  it("splits the result between the put and the shares at the assignment day's close", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "SLD", expiryDate: "2026-03-06", strike: 20, contracts: 1, fillPrice: 0.4, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 19.5 });
    const sharesPosition = ledger.positions.find((position) => position.symbol === "SLD" && position.status === "open")!;
    expect(ledgerBreakEvenForPosition(ledger, sharesPosition.id).breakEven).toBeCloseTo(19.6068, 6);

    sellShares(ledger, { positionId: sharesPosition.id, shares: 100, fillPrice: stockSaleFillPrice(21), at: decisionAt("2026-03-10"), actionId: "action-2" });
    expect(ledgerOpenCycleSummary(ledger, "SLD")).toBeNull();
    const cycles = ledgerCycles(ledger, "SLD", { dailyCloses: [{ date: "2026-03-06", close: 19.5 }, { date: "2026-03-10", close: 21 }] });
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle).toMatchObject({ status: "closed", startAt: decisionAt("2026-03-02"), endAt: decisionAt("2026-03-10"), sharesHeld: 0, dataFlags: [] });
    expect(cycle.buckets.csp.total).toBeCloseTo(-10.68, 6);
    expect(cycle.buckets.unstructured.total).toBeCloseTo(148.5, 6);
    expect(cycle.buckets.cc.total).toBe(0);
    expect(cycle.total).toBeCloseTo(137.82, 6);
    expect(symbolCash(ledger, "SLD")).toBeCloseTo(137.82, 6);
    expect(ledger.cash).toBeCloseTo(100_137.82, 6);
    expect(ledgerTotalRealizedPnl(ledger)).toBeCloseTo(137.82, 6);
  });
});

describe("a finish two cents in the money", () => {
  //  2 Mar  sell 1 put $50 6 Mar @ 1.20     cash +119.32
  //  6 Mar  close 49.98: in the money by 0.02, assigned by the book's rule (live would call it unclear under 0.05)
  //         break-even (5,000 − 119.32) ÷ 100 = 48.8068; put bucket 119.32 − (50 − 49.98) × 100 = 117.32
  it("is an assignment the cycle engine takes from the ledger, with no flag and a break-even", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "PIN", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    expect(settleExpiry(ledger, { legId: put.legId, expiryClose: 49.98 })).toBe("put_assigned");

    const summary = ledgerOpenCycleSummary(ledger, "PIN")!;
    expect(summary).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, acquisitionCost: 5000, unavailableReason: null });
    expect(summary.breakEvenPerShare).toBeCloseTo(48.8068, 6);
    const cycles = ledgerCycles(ledger, "PIN", { dailyCloses: [{ date: "2026-03-06", close: 49.98 }] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 100, dataFlags: [] });
    expect(cycles[0]!.buckets.csp.total).toBeCloseTo(117.32, 6);
    expect(cycles[0]!.breakEvenPerShare).toBeCloseTo(48.8068, 6);
    expect(cycles[0]!.total).toBeCloseTo(symbolCash(ledger, "PIN") + 100 * 49.98, 6);
  });
});

describe("a covered call's call bought back alone (the baseline wheel's profit-taking)", () => {
  //  2 Mar  sell 1 put $50 6 Mar @ 1.20      cash +120 − 0.68 = +119.32
  //  6 Mar  close 48.00: assigned            cash −5,000
  //  9 Mar  sell 1 call $51 20 Mar @ 0.80    cash +80 − 0.68 = +79.32
  // 11 Mar  buy the call back @ 0.20         cash −20 − 0.68 = −20.68; the 100 shares stay, free for the next call
  it("keeps the shares in the open cycle, free for a new call, with the cash in step", () => {
    const ledger = newLedger();
    const put = openCashSecuredPut(ledger, { symbol: "WHL", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: "action-1", splitFactorToday: 1 });
    settleExpiry(ledger, { legId: put.legId, expiryClose: 48 });
    const call = openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-20", strike: 51, contracts: 1, callFillPrice: 0.8, stockFillPrice: stockPurchaseFillPrice(49), at: decisionAt("2026-03-09"), actionId: "action-2", splitFactorToday: 1 });
    expect(ledgerFreeShares(ledger, "WHL")).toBe(0);
    buyBackCoveredCallKeepingShares(ledger, { positionId: call.positionId, callFillPrice: 0.2, at: decisionAt("2026-03-11"), actionId: "action-3" });
    expect(ledgerFreeShares(ledger, "WHL")).toBe(100);
    expect(symbolCash(ledger, "WHL")).toBeCloseTo(119.32 - 5000 + 79.32 - 20.68, 6);
    const summary = ledgerOpenCycleSummary(ledger, "WHL")!;
    expect(summary).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, acquisitionCost: 5000 });
    expect(summary.netPremium).toBeCloseTo(119.32 + 79.32 - 20.68, 6);
    const cycles = ledgerCycles(ledger, "WHL", { dailyCloses: [{ date: "2026-03-06", close: 48 }, { date: "2026-03-09", close: 49 }, { date: "2026-03-11", close: 49.5 }] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", sharesHeld: 100, dataFlags: [] });
    // A second call can be written on the same shares.
    openCoveredCall(ledger, { symbol: "WHL", expiryDate: "2026-03-27", strike: 51, contracts: 1, callFillPrice: 0.7, stockFillPrice: stockPurchaseFillPrice(49.5), at: decisionAt("2026-03-12"), actionId: "action-4", splitFactorToday: 1 });
    expect(ledgerFreeShares(ledger, "WHL")).toBe(0);
    expect(() => buyBackCoveredCallKeepingShares(ledger, { positionId: put.positionId, callFillPrice: 0.1, at: decisionAt("2026-03-13"), actionId: "action-5" })).toThrow(/not an open covered call/);
  });
});
