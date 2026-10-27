import { describe, expect, it } from "vitest";
import {
  ledgerBreakEvenForPosition,
  ledgerCapitalAtRisk,
  ledgerCapitalDeployed,
  ledgerCashLockedInCashSecuredPuts,
  ledgerCommittedDollars,
  ledgerCycles,
  ledgerFreeCash,
  ledgerFreeShares,
  ledgerLegsDueForSettlement,
  ledgerNetLiquidationValue,
  ledgerOpenCycleSummary,
  ledgerTotalRealizedPnl,
  ledgerUnrealizedPnl,
} from "./ledgerSelectors.js";
import { buildFinishedLedgerFixture, fixtureCashBySymbol, fixtureDailyCloses, fixtureFinalCash, fixtureInterestDollars, fixtureStartingCash, fixtureSymbols } from "./testSupport/finishedLedgerFixture.js";

// The selectors over the six-symbol book of testSupport/finishedLedgerFixture.ts (its cash is worked out there). At
// the end three positions are open: the MIX covered call (200 sh at 30.063 under 2 calls $31 27 Mar sold at 0.40, entry
// 0.3932), the ROL puts (2 × $39 27 Mar sold at 1.40, entry 1.3932) and 100 uncovered FRE shares at 10. Marks on
// 20 March: MIX 30.60 and its calls 0.25, the ROL puts 1.00, FRE 9.80.

const fixture = buildFinishedLedgerFixture();
const { ledger, open, priceByLegId, optionMarkByLegId } = fixture;
const symbolCash = (symbol: string) => ledger.cashJournal.filter((entry) => entry.symbol === symbol).reduce((sum, entry) => sum + entry.amount, 0);

describe("cash", () => {
  it("ends at the hand-worked balance, the journal summing to it and each symbol to its own cash", () => {
    expect(ledger.cash).toBeCloseTo(fixtureFinalCash, 6);
    expect(ledger.cashJournal.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(ledger.cash, 6);
    for (const symbol of fixtureSymbols) expect(symbolCash(symbol), symbol).toBeCloseTo(fixtureCashBySymbol[symbol], 6);
  });

  it("locks the open puts' full strike and frees the rest", () => {
    // 2 ROL puts at $39.
    expect(ledgerCashLockedInCashSecuredPuts(ledger)).toBe(7800);
    expect(ledgerFreeCash(ledger)).toBeCloseTo(236_494.89, 6);
  });
});

describe("position figures", () => {
  it("reads EXP $ and the P&L base of the open positions", () => {
    // Covered call: 200 × 30.063 − 0.3932 × 200. Puts: (39 − 1.3932) × 200. Shares: 100 × 10.
    expect(ledgerCapitalAtRisk(ledger, open.mixCoveredCallPositionId)).toBeCloseTo(5933.96, 6);
    expect(ledgerCapitalDeployed(ledger, open.mixCoveredCallPositionId)).toBeCloseTo(5933.96, 6);
    expect(ledgerCapitalAtRisk(ledger, open.rolPutPositionId)).toBeCloseTo(7521.36, 6);
    expect(ledgerCapitalAtRisk(ledger, open.freSharesPositionId)).toBe(1000);
    expect(ledgerCommittedDollars(ledger)).toBeCloseTo(14_455.32, 6);
  });

  it("counts only uncovered shares as free", () => {
    expect(ledgerFreeShares(ledger, "FRE")).toBe(100);
    expect(ledgerFreeShares(ledger, "MIX")).toBe(0);
    expect(ledgerFreeShares(ledger, "WHL")).toBe(0);
  });

  it("marks the open legs: unrealized P&L and the account value", () => {
    // MIX: shares (30.60 − 30.063) × 200 = 107.40, calls (0.3932 − 0.25) × 200 = 28.64. ROL: (1.3932 − 1.00) × 200 = 78.64. FRE: (9.80 − 10) × 100 = −20.
    const unrealized = ledgerUnrealizedPnl(ledger, priceByLegId);
    expect(unrealized.unrealizedByPositionId[open.mixCoveredCallPositionId]).toBeCloseTo(136.04, 6);
    expect(unrealized.premiumByPositionId[open.mixCoveredCallPositionId]).toBeCloseTo(28.64, 6);
    expect(unrealized.stockByPositionId[open.mixCoveredCallPositionId]).toBeCloseTo(107.4, 6);
    expect(unrealized.stockMarketValueByPositionId[open.mixCoveredCallPositionId]).toBeCloseTo(6120, 6);
    expect(unrealized.unrealizedByPositionId[open.rolPutPositionId]).toBeCloseTo(78.64, 6);
    expect(unrealized.unrealizedByPositionId[open.freSharesPositionId]).toBeCloseTo(-20, 6);
    expect(Object.keys(unrealized.unrealizedByPositionId)).toHaveLength(3);
    const withoutTheCallMark = new Map(priceByLegId);
    withoutTheCallMark.delete(open.mixCallLegId);
    expect(ledgerUnrealizedPnl(ledger, withoutTheCallMark).unrealizedByPositionId[open.mixCoveredCallPositionId]).toBeNull();

    // Account value: 244,294.89 + 6,120 − 50 − 200 + 980.
    const netLiquidationValue = ledgerNetLiquidationValue(ledger, priceByLegId);
    expect(netLiquidationValue).toBeCloseTo(251_144.89, 6);
    // What the book made, interest aside, is what its positions realized plus what the open ones are up.
    const unrealizedTotal = Object.values(unrealized.unrealizedByPositionId).reduce((sum: number, value) => sum + (value ?? 0), 0);
    expect(ledgerTotalRealizedPnl(ledger)).toBeCloseTo(929.66, 6);
    expect(netLiquidationValue - fixtureStartingCash - fixtureInterestDollars).toBeCloseTo(ledgerTotalRealizedPnl(ledger) + unrealizedTotal, 6);
  });
});

describe("cycles", () => {
  const cyclesOf = (symbol: (typeof fixtureSymbols)[number], withMarks = true) => ledgerCycles(ledger, symbol, { dailyCloses: fixtureDailyCloses[symbol], ...(withMarks ? { optionMarkByLegId } : {}) });

  it("derives every symbol's cycles with no data flag, each closed cycle totalling the cash it moved", () => {
    expect(cyclesOf("WHL").map((cycle) => [cycle.status, cycle.total.toFixed(2)])).toEqual([["closed", "287.96"]]);
    expect(cyclesOf("BWR").map((cycle) => [cycle.status, cycle.total.toFixed(2)])).toEqual([["closed", "295.64"], ["closed", "23.64"], ["closed", "70.64"]]);
    expect(cyclesOf("SLD").map((cycle) => [cycle.status, cycle.total.toFixed(2)])).toEqual([["closed", "137.82"]]);
    for (const symbol of fixtureSymbols) for (const cycle of cyclesOf(symbol)) expect(cycle.dataFlags, symbol).toEqual([]);
    for (const symbol of ["WHL", "BWR", "SLD"] as const) expect(cyclesOf(symbol).reduce((sum, cycle) => sum + cycle.total, 0), symbol).toBeCloseTo(fixtureCashBySymbol[symbol], 6);
  });

  it("values an open cycle at the cash it moved plus what it still holds at the marks", () => {
    // MIX: −5,771.60 + 200 × 30.60 − 0.25 × 200 = 298.40. ROL: 215.92 − 1.00 × 200 = 15.92. FRE: −985.68 + 100 × 9.80 = −5.68.
    expect(cyclesOf("MIX").map((cycle) => [cycle.status, cycle.sharesHeld, cycle.total.toFixed(2)])).toEqual([["open", 200, "298.40"]]);
    expect(cyclesOf("ROL").map((cycle) => [cycle.status, cycle.sharesHeld, cycle.total.toFixed(2)])).toEqual([["open", 0, "15.92"]]);
    expect(cyclesOf("FRE").map((cycle) => [cycle.status, cycle.sharesHeld, cycle.total.toFixed(2)])).toEqual([["open", 100, "-5.68"]]);
    // Without option marks the open shorts stay at their credit: 348.40 and 215.92.
    expect(cyclesOf("MIX", false)[0]!.total).toBeCloseTo(348.4, 6);
    expect(cyclesOf("ROL", false)[0]!.total).toBeCloseTo(215.92, 6);
  });

  it("attributes the two-lot MIX cycle to its buckets as the cycle engine does", () => {
    // Put: 98.64 − (30 − 29.00) × 200 = −101.36.
    // Shares alone: 100 handed to the first call at 29.80 (+80), 40 more at 30.50 after the sale (+60), all 200 handed to
    //   the second call at the 30.315 the top-up cost (+90.40) = 230.40.
    // Covered calls: 44.32 + 40 sold at 30.485 from 29.80 (+27.40) + 100 back at 30.20 from 30.08 (+12) + 78.64
    //   + 200 marked at 30.60 from 30.315 (+57) = 219.36 at credit.
    const cycle = cyclesOf("MIX", false)[0]!;
    expect(cycle.buckets.csp.total).toBeCloseTo(-101.36, 6);
    expect(cycle.buckets.unstructured.total).toBeCloseTo(230.4, 6);
    expect(cycle.buckets.cc.total).toBeCloseTo(219.36, 6);
    // Break-even: (6,000 + 1,212.60 − 221.60) ÷ 240 shares acquired.
    expect(cycle.breakEvenPerShare).toBeCloseTo(6991 / 240, 6);
  });

  it("summarizes the open cycles for the break-even and reports the flat symbols as having none", () => {
    const mix = ledgerOpenCycleSummary(ledger, "MIX")!;
    expect(mix).toMatchObject({ sharesHeld: 200, sharesAcquired: 240, unavailableReason: null, openShortPuts: [] });
    expect(mix.acquisitionCost).toBeCloseTo(7212.6, 6);
    expect(mix.netPremium).toBeCloseTo(221.6, 6);
    expect(mix.breakEvenPerShare).toBeCloseTo(6991 / 240, 6);
    expect(ledgerBreakEvenForPosition(ledger, open.mixCoveredCallPositionId).breakEven).toBeCloseTo(6991 / 240, 6);

    // ROL has no shares: its put's own strike less the cycle's premium per share, 39 − 215.92 ÷ 200.
    expect(ledgerOpenCycleSummary(ledger, "ROL")).toMatchObject({ sharesHeld: 0, breakEvenPerShare: null, unavailableReason: null, openShortPuts: [{ positionId: open.rolPutPositionId, strike: 39, shares: 200 }] });
    expect(ledgerBreakEvenForPosition(ledger, open.rolPutPositionId).breakEven).toBeCloseTo(37.9204, 6);

    // FRE: (1,000 − 14.32) ÷ 100.
    expect(ledgerOpenCycleSummary(ledger, "FRE")!.breakEvenPerShare).toBeCloseTo(9.8568, 6);
    for (const symbol of ["WHL", "BWR", "SLD"]) expect(ledgerOpenCycleSummary(ledger, symbol), symbol).toBeNull();
  });
});

describe("settlement", () => {
  it("lists the legs a day's settlement is due on", () => {
    expect(ledgerLegsDueForSettlement(ledger, "2026-03-26")).toEqual([]);
    expect(ledgerLegsDueForSettlement(ledger, "2026-03-27").map((leg) => leg.id).sort()).toEqual([open.mixCallLegId, open.rolPutLegId].sort());
  });
});
