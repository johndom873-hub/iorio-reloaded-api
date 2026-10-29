import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { PositionFigures } from "../lib/positionSelectors.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { newVolFarmerV2SymbolState, runVolFarmerV2Steps, volFarmerV2BreakEven, type VolFarmerV2Market, type VolFarmerV2Position } from "../backtest/engine/volFarmerV2Steps.js";
import { plutoLadderSettingsFixture, plutoVolFarmerV2SettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";
import {
  adoptVolFarmerV2Holdings,
  createVolFarmerV2LiveBook,
  pendingVolFarmerV2Order,
  replaceVolFarmerV2LegRef,
  settleVolFarmerV2Order,
  unfilledVolFarmerV2Outcome,
  volFarmerV2MemoryFromStored,
  volFarmerV2RulesOf,
  type VolFarmerV2LiveSnapshot,
  type VolFarmerV2PendingOrder,
} from "./volFarmerV2LiveBook.js";

const settings = { ...plutoLadderSettingsFixture, ...plutoVolFarmerV2SettingsFixture } as unknown as PlutoSettings;
const optionCommissionDollars = (contracts: number) => 0.65 * contracts;
const stockCommissionDollars = (shares: number) => 0.005 * shares;

function snapshotOf(overrides: Partial<VolFarmerV2LiveSnapshot> = {}): VolFarmerV2LiveSnapshot {
  return { legStatusById: new Map(), openOptionContracts: [], flat: true, freeCash: 200_000, potDollars: 64_000, stockPrice: 100, optionCommissionDollars, stockCommissionDollars, ...overrides };
}

const leg = (id: string, fields: Partial<PositionFigures["legs"][number]>): PositionFigures["legs"][number] => ({ id, legType: "option", side: "short", quantity: 1, optionType: "call", strikePrice: 110, expiryDate: "2026-11-06", multiplier: 100, entryPrice: 1, entryAt: new Date("2026-10-20T14:00:00Z"), exitPrice: null, exitAt: null, ...fields });

/** Black-Scholes quotes at IV 50%, 2% either side of the mid, on `todayIso` with the stock at `stockPrice`. */
function quotesAt(stockPrice: number, expiry: string, years: number, right: "C" | "P"): SymbolFileQuote[] {
  return Array.from({ length: 101 }, (_, index) => 40 + index).map((strike) => {
    const mid = blackScholesPriceOnForward(stockPrice * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
    return { expiry, strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: null, askSize: null };
  });
}

function marketOf(stockPrice: number): VolFarmerV2Market {
  const quotes = [...quotesAt(stockPrice, "2026-11-06", 10 / 365, "C"), ...quotesAt(stockPrice, "2026-11-06", 10 / 365, "P")];
  return {
    symbol: "VFT",
    todayIso: "2026-10-27",
    stockPrice,
    riskFreeRate: 0.04,
    quotes,
    forwardAnchors: new Map(),
    previousSessionVolumeByContract: new Map(quotes.map((quote) => [contractKey(quote), 1_000])),
    yearsToTodaysClose: 5 / 8760,
    yearsToExpiry: () => 1,
    leapsCallQuotes: undefined,
    stepImpliedVolatility: () => null,
    // Tuesday 27 October to Friday 6 November: 9 sessions.
    tradingSessionsThrough: () => 9,
    priceToCycleScale: 1,
    optionContractsRepresentable: true,
    spreadShareCharged: 0,
    commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator },
    optionCommissionDollars,
    stockCommissionDollars,
    leapsCapBaseLabel: "the ticker's allocation",
    capsLeapsAtAskSize: false,
  };
}

describe("Vol Farmer v2's live rules", () => {
  it("are Pluto's v2 settings, at every look, the LEAPS cap a share of the ticker's pot", () => {
    const { farmer, v2 } = volFarmerV2RulesOf({ ...settings, excessAllowancePct: 20 });
    expect(farmer).toEqual({ callMinAbsDelta: 0.05, callMaxAbsDelta: 0.3, maxSpreadPctOfMid: 50 });
    expect(v2).toEqual({ putsStartCallYieldPct: 5, putMaxAbsDelta: 0.3, stepBelowFirstBreakEvenPct: 15, stepRule: "implied_move_at_put_sale", leapsMinDte: 365, leapsAbsDelta: 0.7, leapsMaxAccountPct: 10, leapsSpreadCostChargedPct: 0, looks: "every_look", tickerAllocationPct: {}, excessAllowancePct: 20 });
  });
});

describe("adopting a ticker's holdings", () => {
  const position = (legs: PositionFigures["legs"]): PositionFigures => ({ strategyKey: "covered_call", status: "open", legs });

  it("takes every share as the first position at the cycle's break-even, its Calls the first's and its Puts the second's", () => {
    // INTC on staging: 400 + 100 shares, two Calls, and a ladder Put still open.
    const positions = [
      position([leg("s1", { legType: "stock", side: "long", quantity: 400, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 113.68 }), leg("c1", { quantity: 4, strikePrice: 114, expiryDate: "2026-10-30" })]),
      position([leg("s2", { legType: "stock", side: "long", quantity: 100, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 88 }), leg("c2", { quantity: 1, strikePrice: 108 })]),
      { strategyKey: "cash_secured_put", status: "open" as const, legs: [leg("p1", { optionType: "put", strikePrice: 95, quantity: 2 })] },
    ];
    const adopted = adoptVolFarmerV2Holdings({ positions, cycleBreakEvenPerShare: 105.42, potDollars: 64_007 });
    if (!("state" in adopted)) throw new Error(adopted.waiting);
    expect(adopted.state.potDollars).toBe(64_007);
    expect(adopted.state.first).toEqual({ shares: 500, costPerShare: 105.42, premiums: [], calls: [{ legId: "c1", shares: 400 }, { legId: "c2", shares: 100 }], puts: [] });
    expect(volFarmerV2BreakEven(adopted.state.first!)).toBe(105.42);
    expect(adopted.state.second).toEqual({ shares: 0, costPerShare: 0, premiums: [], calls: [], puts: [{ legId: "p1", shares: 200 }] });
  });

  it("waits while the ticker holds only Puts, or its cycle's break-even is unknown", () => {
    const putsOnly = [{ strategyKey: "cash_secured_put", status: "open" as const, legs: [leg("p1", { optionType: "put", strikePrice: 225, quantity: 2 })] }];
    expect(adoptVolFarmerV2Holdings({ positions: putsOnly, cycleBreakEvenPerShare: null, potDollars: 64_007 })).toEqual({ waiting: expect.stringContaining("holds no shares yet") });
    const shares = [{ strategyKey: "unstructured", status: "open" as const, legs: [leg("s1", { legType: "stock", side: "long", quantity: 100, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1 })] }];
    expect(adoptVolFarmerV2Holdings({ positions: shares, cycleBreakEvenPerShare: null, potDollars: 64_007 })).toEqual({ waiting: expect.stringContaining("break-even cannot be worked out") });
  });
});

describe("the live book and its orders", () => {
  it("opens a cycle on a flat ticker with half its allocation, the shares bought with the first Call", () => {
    const state = newVolFarmerV2SymbolState();
    const { book, planned } = createVolFarmerV2LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2 } = volFarmerV2RulesOf(settings);
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, book });
    // P = the allocation, $64,000: floor(32,000 ÷ 10,000.50) = 3 lots.
    expect(state.potDollars).toBe(64_000);
    expect(planned.map((order) => order.kind)).toEqual(["covered_call"]);
    const order = planned[0]!;
    if (order.kind !== "covered_call") throw new Error("not a Call");
    expect(order.sale).toMatchObject({ contracts: 3, startsCycle: true });
    expect(state.first).toMatchObject({ shares: 300, calls: [{ legId: order.ref, shares: 300 }] });
    // The free cash moved as a fill would move it: the shares and their commission out, the premium net of its commission in.
    expect(book.freeCash()).toBeCloseTo(200_000 - 30_000 - 1.5 + order.sale.candidate.fillPrice * 300 - 1.95, 6);
    expect(book.isFlat()).toBe(false);
  });

  it("counts an order still working as planned, and settles a filled one at its fills", () => {
    const state = newVolFarmerV2SymbolState();
    const first = createVolFarmerV2LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2 } = volFarmerV2RulesOf(settings);
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, book: first.book });
    const order = first.planned[0]!;
    const pending = pendingVolFarmerV2Order(state, order, "a1", optionCommissionDollars);
    replaceVolFarmerV2LegRef(state, order.ref, pending.ref);
    expect(pending).toMatchObject({ ref: "action:a1", kind: "covered_call", contracts: 3, startsCycle: true, contractsByPosition: { first: 3, second: 0 } });
    const plannedBreakEven = volFarmerV2BreakEven(state.first!)!;

    // The next look, the order still working: the ticker is not flat, the Call is open, nothing new is planned.
    const second = createVolFarmerV2LiveBook({ state, pending: [pending], snapshot: snapshotOf({ flat: true }) });
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, book: second.book });
    expect(second.planned).toEqual([]);
    expect(state.first!.calls).toEqual([{ legId: "action:a1", shares: 300 }]);

    // Filled: 2 of 3 lots, the shares at 100.10 with commission, the Calls for $250 net.
    expect(settleVolFarmerV2Order(state, pending, { working: false, filledContracts: 2, optionLegIds: ["leg-c"], optionNetDollars: 250, sharesBought: 200, sharesCostDollars: 20_020 })).toContain("2 of 3 filled");
    expect(state.first).toMatchObject({ shares: 200, costPerShare: 100.1, premiums: [{ legId: "leg-c", dollars: 250, shares: 200 }], calls: [{ legId: "leg-c", shares: 200 }] });
    expect(volFarmerV2BreakEven(state.first!)).toBeCloseTo(100.1 - 250 / 200, 10);
    expect(volFarmerV2BreakEven(state.first!)).not.toBeCloseTo(plannedBreakEven, 2);
  });

  it("undoes an opening order that never filled: no cycle", () => {
    const state = newVolFarmerV2SymbolState();
    const { book, planned } = createVolFarmerV2LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2 } = volFarmerV2RulesOf(settings);
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, book });
    const pending = pendingVolFarmerV2Order(state, planned[0]!, "a1", optionCommissionDollars);
    replaceVolFarmerV2LegRef(state, planned[0]!.ref, pending.ref);
    expect(settleVolFarmerV2Order(state, pending, unfilledVolFarmerV2Outcome)).toContain("did not fill");
    expect(state.first).toBeNull();
    expect(state.potDollars).toBe(0);
  });

  it("takes an unfilled Put back out of the second position, its premium with it", () => {
    const order: VolFarmerV2PendingOrder = { ref: "action:p", actionId: "p", kind: "cash_secured_put", expiry: "2026-11-06", strike: 85, contracts: 5, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 296.75 }, leapsBeforeSale: null };
    const state = newVolFarmerV2SymbolState();
    state.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "leg-p0", dollars: 3.25, shares: 100 }, { legId: "action:p", dollars: 296.75, shares: 500 }], calls: [], puts: [{ legId: "action:p", shares: 500 }] };
    settleVolFarmerV2Order(state, order, unfilledVolFarmerV2Outcome);
    expect(state.second).toMatchObject({ puts: [], premiums: [{ legId: "leg-p0", dollars: 3.25, shares: 100 }] });

    // Saved before premiums were kept per option: the planned premium is in the total, which loses it.
    const saved = newVolFarmerV2SymbolState();
    saved.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "", dollars: 300, shares: 0 }], calls: [], puts: [{ legId: "action:p", shares: 500 }] };
    settleVolFarmerV2Order(saved, order, unfilledVolFarmerV2Outcome);
    expect(saved.second!.premiums).toEqual([{ legId: "", dollars: 3.25, shares: 0 }]);
  });

  it("reads a memory saved with a premium total as one premium counted in full", () => {
    const memory = { state: newVolFarmerV2SymbolState(), pending: [] };
    memory.state.first = { shares: 300, costPerShare: 50.01, premiumDollars: 328, calls: [], puts: [] } as unknown as VolFarmerV2Position;
    memory.state.second = { shares: 0, costPerShare: 0, premiumDollars: 0, calls: [], puts: [] } as unknown as VolFarmerV2Position;
    const read = volFarmerV2MemoryFromStored(memory);
    expect(read.state.first).toEqual({ shares: 300, costPerShare: 50.01, premiums: [{ legId: "", dollars: 328, shares: 0 }], calls: [], puts: [] });
    expect(read.state.second).toEqual({ shares: 0, costPerShare: 0, premiums: [], calls: [], puts: [] });
    expect(volFarmerV2BreakEven(read.state.first!)).toBeCloseTo(50.01 - 328 / 300, 10);
  });

  it("keeps a LEAPS partly bought for its top-up, forgets one not bought at all, and gives back one not sold whole", () => {
    const state = newVolFarmerV2SymbolState();
    state.leaps = { legIds: ["action:l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 };
    state.leapsBought = true;
    const buy: VolFarmerV2PendingOrder = { ref: "action:l", actionId: "l", kind: "buy_leaps", expiry: "2027-12-17", strike: 80, contracts: 4, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null };
    expect(settleVolFarmerV2Order(state, buy, { ...unfilledVolFarmerV2Outcome, filledContracts: 1, optionLegIds: ["leg-l"], optionNetDollars: 2_500 })).toContain("topped up");
    expect(state.leaps).toEqual({ legIds: ["leg-l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 });

    const unbought = newVolFarmerV2SymbolState();
    unbought.leaps = { legIds: ["action:l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 };
    unbought.leapsBought = true;
    settleVolFarmerV2Order(unbought, buy, unfilledVolFarmerV2Outcome);
    expect(unbought).toMatchObject({ leaps: null, leapsBought: false });

    const sold = newVolFarmerV2SymbolState();
    const sale: VolFarmerV2PendingOrder = { ...buy, ref: "action:s", actionId: "s", kind: "sell_leaps", leapsBeforeSale: { legIds: ["leg-l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 } };
    settleVolFarmerV2Order(sold, sale, { ...unfilledVolFarmerV2Outcome, filledContracts: 2 });
    expect(sold).toMatchObject({ leaps: { legIds: ["leg-l"] }, leapsToSell: true });
  });
});
