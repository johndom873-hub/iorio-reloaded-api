import { describe, expect, it } from "vitest";
import { defaultBacktestBaselineSettings } from "../backtest/backtestTypes.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { makeBaselineSelector, noteBaselineForwardAnchors, planBaselineSales, type BaselineCandidate, type BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import { nextLadderCycleMemory } from "./ladderCycleMemory.js";
import { ladderBaselineFromPlutoSettings } from "./ladderSettings.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import type { PositionFigures } from "../lib/positionSelectors.js";
import { createLadderLookBook, type LadderLookSnapshot, type LadderSale } from "./ladderLookBook.js";

// Flat commissions: $0.68 a contract, $0.005 a share.
const commissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const at = new Date("2026-10-20T15:00:00Z");
const tickerId = "ticker-1";

const candidate = (overrides: Partial<BaselineCandidate>): BaselineCandidate => ({ expiry: "2026-11-20", strike: 55, right: "C", bid: 1.0, ask: 1.1, fillPrice: 1.05, dte: 31, delta: 0.25, impliedVolatility: 0.5, timeValue: 1.05, premiumYield: 0.25, volumeCap: 50, volatilityEdge: null, edgeYield: null, ...overrides });

const heldShares = (shares: number, entryPrice: number): PositionFigures => ({
  strategyKey: "unstructured",
  status: "open",
  legs: [{ id: "held-stock", legType: "stock", side: "long", quantity: shares, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice, entryAt: new Date("2026-10-01T15:00:00Z"), exitPrice: null, exitAt: null }],
});

const snapshot = (overrides: Partial<LadderLookSnapshot> = {}): LadderLookSnapshot => ({
  tickerId,
  at,
  stockPrice: 50,
  positions: [],
  cycleRows: { optionRows: [], stockTradeRows: [], openStockShares: 0 },
  freeCash: 100_000,
  accountValue: 200_000,
  tickerWeight: 0.25,
  commissions,
  workingSales: [],
  ...overrides,
});

describe("createLadderLookBook", () => {
  it("a flat ticker: nothing held, the snapshot's cash, account and weight", () => {
    const { book } = createLadderLookBook(snapshot());
    expect([book.freeShares(), book.heldSharesToday(), book.openPutCollateral(), book.openPositionsCapitalAtRisk()]).toEqual([0, 0, 0, 0]);
    expect([book.freeCash(), book.accountValueToday(), book.netLiquidationValue(), book.tickerWeight()]).toEqual([100_000, 200_000, 200_000, 0.25]);
    expect(book.heldSharesAverageCost()).toBeNull();
    expect(book.openCycleSummary()).toBeNull();
    expect(book.hasOpenCashSecuredPut()).toBe(false);
  });

  it("a Covered Call entry: 200 shares bought at $50 under 2 Calls at $1.05, applied at once and collected for the order step", () => {
    const { book, planned } = createLadderLookBook(snapshot());
    book.sell("covered_call", candidate({}), 2, 7, "baseline: entry", null, false, { rank: 1 });
    // Cash: + 2 × 105 premium − 2 × 0.68 − 200 × 50 − 200 × 0.005 = −9,792.36.
    expect(book.freeCash()).toBeCloseTo(100_000 - 9_792.36, 6);
    expect([book.heldSharesToday(), book.freeShares()]).toEqual([200, 0]);
    expect(book.heldSharesAverageCost()).toBe(50);
    expect(book.latestShareAcquisitionPrice()).toBe(50);
    expect(book.isHeld({ expiry: "2026-11-20", strike: 55 })).toBe(true);
    // The platform's cycle (cycleBreakEven.ts): 200 shares at $50 plus the $1 commission, less the $210 premium (its net
    // premium counts closing commissions only) → (10,001 − 210) ÷ 200 = $48.955.
    expect(book.openCycleSummary()).toMatchObject({ sharesHeld: 200, sharesAcquired: 200, netPremium: 210 });
    expect(book.openCycleSummary()!.breakEvenPerShare).toBeCloseTo(48.955, 9);
    // Exposure: shares at cost (with the commission) less the Call premium.
    expect(book.openPositionsCapitalAtRisk()).toBeCloseTo(10_001 - 210, 6);
    expect(planned).toEqual([expect.objectContaining({ strategyKey: "covered_call", contracts: 2, sharesBought: 200, stockPrice: 50, optionPrice: 1.05, eligibleCount: 7, chosenBecause: "baseline: entry", scores: { rank: 1 } })]);
  });

  it("a Call on held shares takes the uncovered shares first and buys only the rest", () => {
    const { book, planned } = createLadderLookBook(snapshot({ positions: [heldShares(150, 48)], cycleRows: { optionRows: [], stockTradeRows: [{ tickerId, at: "2026-10-01T15:00:00Z", side: "buy", quantity: 150, price: 48, commission: 0.75 }], openStockShares: 150 } }));
    expect(book.freeShares()).toBe(150);
    book.sell("covered_call", candidate({}), 2, 3, "baseline: entry");
    expect(planned[0]!.sharesBought).toBe(50);
    expect([book.freeShares(), book.heldSharesToday()]).toEqual([0, 200]);
    // Running average: 150 at $48, then 50 at $50 → $48.50.
    expect(book.heldSharesAverageCost()).toBe(48.5);
  });

  it("a ladder Put locks its strike in cash and counts as collateral; the contract is held for the rest of the look", () => {
    const { book } = createLadderLookBook(snapshot());
    book.sell("cash_secured_put", candidate({ right: "P", strike: 40, fillPrice: 0.8, expiry: "2026-11-13" }), 3, 4, "baseline: ladder rung");
    // + 3 × 80 − 3 × 0.68 − 3 × 4,000.
    expect(book.freeCash()).toBeCloseTo(100_000 + 240 - 2.04 - 12_000, 6);
    expect(book.openPutCollateral()).toBe(12_000);
    expect(book.hasOpenCashSecuredPut()).toBe(true);
    expect(book.isHeld({ expiry: "2026-11-13", strike: 40 })).toBe(true);
    expect(book.isHeld({ expiry: "2026-11-13", strike: 41 })).toBe(false);
  });

  it("the ladder's orders still working count as filled before the look plans", () => {
    const working: LadderSale = { strategyKey: "cash_secured_put", expiry: "2026-11-13", strike: 40, right: "P", contracts: 2, optionPrice: 0.8, sharesBought: 0, stockPrice: 50 };
    const { book, planned } = createLadderLookBook(snapshot({ workingSales: [working] }));
    expect(book.openPutCollateral()).toBe(8_000);
    expect(book.isHeld({ expiry: "2026-11-13", strike: 40 })).toBe(true);
    expect(planned).toEqual([]);
  });
});

describe("the shared sale steps on the live book", () => {
  // A quote priced by Black-76 at 50% volatility on the spot forward, 4% wide; the stock at $50 on 20 Oct.
  const todayIso = "2026-10-20";
  const riskFreeRate = 0.04;
  const quote = (expiry: string, strike: number, right: "C" | "P"): SymbolFileQuote => {
    const years = yearsBetweenIsoDates(todayIso, expiry);
    const mid = blackScholesPriceOnForward(50 * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, 0.5, right === "C");
    return { expiry, strike, right, bid: Math.round(mid * 0.98 * 100) / 100, ask: Math.round(mid * 1.02 * 100) / 100, bidSize: 10, askSize: 10 };
  };
  const quotes = [50, 52.5, 55, 57.5, 60, 62.5].flatMap((strike) => [quote("2026-11-20", strike, "C"), quote("2026-11-20", 100 - strike, "P")]);

  it("on a flat ticker, buys its share budget under Calls, as the backtest's look does", () => {
    const baseline = { ...defaultBacktestBaselineSettings, ...ladderBaselineFromPlutoSettings(plutoLadderSettingsFixture as unknown as PlutoSettings) };
    const { book, planned } = createLadderLookBook(snapshot());
    const memory = nextLadderCycleMemory(null, { cycleOpen: false, sharesHeld: false, accountValue: 200_000, todayIso, shockPctIfStartingToday: 70 });
    const forwardAnchors = new Map<string, BaselineForwardAnchor>();
    noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose: 1 / 8760, stockPrice: 50, riskFreeRate });
    // Tuesday 20 October to Friday 20 November: 24 sessions.
    const select = makeBaselineSelector({ quotes, forwardAnchors, commissions, todayIso, yearsToTodaysClose: 1 / 8760, stockPrice: 50, riskFreeRate, previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])), baseline, spreadShareCharged: 0.5, isHeld: book.isHeld, earningsDatesIso: undefined, model: null, tradingSessionsThrough: () => 24 });
    const notes: string[] = [];
    const ladderState = { startedOn: memory.startedOn, accountValueAtStart: memory.accountValueAtStart, shock: memory.shock ?? 0 };
    planBaselineSales({ symbol: "LADR", commissions, todayIso, atMs: at.getTime(), stockPrice: 50, priceToCycleScale: 1, baseline, select, book, ladderState, notes });
    // The pot: 25% of the $200,000 account = $50,000; half of it for shares = $25,000 = 5 lots at $50.
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((sale) => sale.strategyKey === "covered_call" && sale.right === "C")).toBe(true);
    expect(planned.reduce((sum, sale) => sum + sale.sharesBought, 0)).toBe(500);
    expect(book.heldSharesToday()).toBe(500);
    // Every Call inside the ladder's 0.05–0.30 |delta| range.
    expect(planned.every((sale) => Math.abs(sale.candidate.delta) >= 0.05 && Math.abs(sale.candidate.delta) <= 0.3)).toBe(true);
  });
});
