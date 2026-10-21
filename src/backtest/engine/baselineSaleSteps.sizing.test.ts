import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { defaultBacktestBaselineSettings } from "../backtestTypes.js";
import { planBaselineSales, type BaselineCandidate, type BaselineLookBook, type BaselineSelect, type BaselineSizing } from "./baselineSaleSteps.js";

// The sale steps with the falling-knife guard's and Kelly's sizing (ladderSizing.ts), on a fake book: $100,000 account,
// no shares, a 50% shares' budget ($50,000), a Covered Call entry at $100.
const commissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const baseline = { ...defaultBacktestBaselineSettings, entry: "covered_call" as const, putsWhenNoCall: "reserve_ladder" as const, ladderSharesPct: 50, ladderRungs: 5, ladderPutDeltaRange: "none" as const };
const candidate = (overrides: Partial<BaselineCandidate>): BaselineCandidate => ({ expiry: "2024-04-19", strike: 105, right: "C", bid: 1.9, ask: 2.1, fillPrice: 2, dte: 30, delta: 0.25, impliedVolatility: 0.5, timeValue: 2, premiumYield: 0.5, volumeCap: 100, volatilityEdge: null, edgeYield: null, ...overrides });
const calls = [candidate({})];
const puts = [candidate({ right: "P", strike: 95, fillPrice: 1.5, premiumYield: 0.6, delta: -0.3 }), candidate({ right: "P", strike: 80, fillPrice: 0.5, premiumYield: 0.3, delta: -0.08 })];

interface Sale {
  strategyKey: "cash_secured_put" | "covered_call";
  strike: number;
  contracts: number;
  extraScores: Record<string, number | null>;
}

function run(sizing: BaselineSizing | null) {
  const sales: Sale[] = [];
  let shares = 0;
  let cash = 100_000;
  const putCollateral = () => sales.filter((sale) => sale.strategyKey === "cash_secured_put").reduce((sum, sale) => sum + sale.strike * 100 * sale.contracts, 0);
  const book: BaselineLookBook = {
    freeShares: () => 0,
    freeCash: () => cash - putCollateral(),
    heldSharesAverageCost: () => (shares > 0 ? 100 : null),
    heldSharesAverageCostToday: () => (shares > 0 ? 100 : null),
    heldSharesToday: () => shares,
    latestShareAcquisitionPrice: () => (shares > 0 ? 100 : null),
    openCycleSummary: () => null,
    openPutCollateral: putCollateral,
    accountValueToday: () => 100_000,
    tickerWeight: () => 1,
    netLiquidationValue: () => 100_000,
    openPositionsCapitalAtRisk: () => 0,
    hasOpenCashSecuredPut: () => putCollateral() > 0,
    isHeld: (contract) => sales.some((sale) => sale.strike === contract.strike),
    sell: (strategyKey, sold, contracts, _eligible, _why, _limit, _buyEvery, extraScores = {}) => {
      sales.push({ strategyKey, strike: sold.strike, contracts, extraScores });
      if (strategyKey === "covered_call") {
        shares += contracts * 100;
        cash -= (100 - sold.fillPrice) * 100 * contracts;
      }
    },
  };
  const select: BaselineSelect = (right, _minimumStrike, _forEntry, maximumStrike) => ({ candidates: (right === "C" ? calls : puts).filter((entry) => maximumStrike === null || maximumStrike === undefined || entry.strike <= maximumStrike), rejections: { outsideExpiryRange: 0, noUsableQuote: 0, spreadTooWide: 0, tooLittleVolume: 0, noImpliedVolatility: 0, outsideDeltaRange: 0, noTimeValue: 0, alreadyHeld: 0, belowCost: 0, aboveCeiling: 0, belowMinimumYield: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0 } });
  const notes: string[] = [];
  planBaselineSales({ symbol: "TEST", commissions, todayIso: "2024-03-20", atMs: Date.parse("2024-03-20T14:00:00Z"), stockPrice: 100, priceToCycleScale: 1, baseline, select, book, ladderState: { startedOn: null, accountValueAtStart: 100_000, shock: 0 }, notes, sizing });
  return { sales, notes };
}

const sizing = (overrides: Partial<BaselineSizing>): BaselineSizing => ({ buyingScale: 1, pool: true, deeperPutsDepth: null, detail: "Kelly ×test", scores: { buyingScale: overrides.buyingScale ?? 1 }, ...overrides });

describe("the sale steps with the guard's and Kelly's sizing", () => {
  it("buys the whole shares' budget without sizing: $50,000 at $100 is 5 lots", () => {
    const { sales } = run(null);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ strategyKey: "covered_call", contracts: 5 });
    expect(sales[0]!.extraScores).not.toHaveProperty("buyingScale");
  });

  it("buys m × the budget at a top, and the room held back secures Puts at or below price × (1 − depth)", () => {
    // m 0.4: $20,000 = 2 lots; the $30,000 held back goes to Puts at or below 100 × (1 − 0.18) = $82: 3 contracts of the $80 Put.
    const { sales, notes } = run(sizing({ buyingScale: 0.4, deeperPutsDepth: 0.18 }));
    expect(sales.map((sale) => [sale.strategyKey, sale.strike, sale.contracts])).toEqual([
      ["covered_call", 105, 2],
      ["cash_secured_put", 80, 3],
    ]);
    expect(sales[1]!.extraScores.deeperPutCap).toBeCloseTo(82, 9);
    expect(sales[0]!.extraScores.buyingScale).toBe(0.4);
    expect(notes[0]).toMatch(/new buying ×0\.40/);
  });

  it("leaves the held-back room in cash without deeper Puts, and buys nothing at m 0", () => {
    expect(run(sizing({ buyingScale: 0.4 })).sales.map((sale) => sale.contracts)).toEqual([2]);
    expect(run(sizing({ buyingScale: 0 })).sales).toHaveLength(0);
  });
});
