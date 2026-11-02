import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { PositionFigures } from "../lib/positionSelectors.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { addVolFarmerV3Shares, newVolFarmerV2SymbolState, removeVolFarmerV3Shares, runVolFarmerV2Steps, volFarmerV2BreakEven, type VolFarmerV2Market, type VolFarmerV2Position, type VolFarmerV3SharesOrder } from "../backtest/engine/volFarmerV2Steps.js";
import { plutoSafetyLimitsSettingsFixture, plutoVolFarmerV4SettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";
import {
  adoptVolFarmerV4Holdings,
  createVolFarmerV4LiveBook,
  pendingVolFarmerV4Order,
  replaceVolFarmerV4LegRef,
  settleVolFarmerV4Order,
  unfilledVolFarmerV4Outcome,
  volFarmerV4MemoryFromStored,
  volFarmerV4RulesOf,
  type VolFarmerV4LiveSnapshot,
  type VolFarmerV4PendingOrder,
} from "./volFarmerV4LiveBook.js";

const settings = { ...plutoSafetyLimitsSettingsFixture, ...plutoVolFarmerV4SettingsFixture } as unknown as PlutoSettings;
/** Half the pot in shares: the numbers the book's tests were first written on. */
const halfInShares = { ...settings, volFarmerV4FirstPositionPct: 50 };
/** Pluto's rules on halfInShares, selling the next expiry after today (these tests' quotes expire on 6 November). */
const rulesOnNextExpiry = () => {
  const rules = volFarmerV4RulesOf(halfInShares);
  return { ...rules, v3: { ...rules.v3, optionsExpiry: "next" as const } };
};
const optionCommissionDollars = (contracts: number) => 0.65 * contracts;
const stockCommissionDollars = (shares: number) => 0.005 * shares;

function snapshotOf(overrides: Partial<VolFarmerV4LiveSnapshot> = {}): VolFarmerV4LiveSnapshot {
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

describe("Vol Farmer v4's live rules", () => {
  it("are Pluto's v4 settings, at every look, the LEAPS cap a share of the ticker's pot", () => {
    const { farmer, v2, v3 } = volFarmerV4RulesOf({ ...settings, excessAllowancePct: 20 });
    expect(farmer).toEqual({ callMinAbsDelta: 0.05, callMaxAbsDelta: 0.5, maxSpreadPctOfMid: 50 });
    expect(v2).toEqual({ firstPositionPct: 80, putsStartCallYieldPct: 5, putMaxAbsDelta: 0.3, stepBelowFirstBreakEvenPct: 15, stepRule: "implied_move_at_put_sale", leapsMinDte: 180, leapsAbsDelta: 0.6, leapsMaxAccountPct: 10, leapsSpreadCostChargedPct: 0, looks: "every_look", tickerAllocationPct: {}, excessAllowancePct: 20 });
    expect(v3).toEqual({ rebalanceBandPct: 20, rebalances: "both_positions", firstPositionAfterCalledAway: "wait", optionsExpiry: "today", optionsMaxDaysToExpiry: 45, callStrikeFloor: "none", putsSold: "calls_yield_little", putStrikeCap: "first_break_even_less_step", trimsSell: "higher_break_even_first", topUpCapPctOfPot: 0, callsInTheMoneyAtLastLook: "assigned" });
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
    const adopted = adoptVolFarmerV4Holdings({ positions, cycleBreakEvenPerShare: 105.42, potDollars: 64_007 });
    if (!("state" in adopted)) throw new Error(adopted.waiting);
    expect(adopted.state.potDollars).toBe(64_007);
    expect(adopted.state.first).toEqual({ shares: 500, costPerShare: 105.42, premiums: [], calls: [{ legId: "c1", shares: 400 }, { legId: "c2", shares: 100 }], puts: [] });
    expect(volFarmerV2BreakEven(adopted.state.first!)).toBe(105.42);
    expect(adopted.state.second).toEqual({ shares: 0, costPerShare: 0, premiums: [], calls: [], puts: [{ legId: "p1", shares: 200 }] });
  });

  it("waits while the ticker holds only Puts, or its cycle's break-even is unknown", () => {
    const putsOnly = [{ strategyKey: "cash_secured_put", status: "open" as const, legs: [leg("p1", { optionType: "put", strikePrice: 225, quantity: 2 })] }];
    expect(adoptVolFarmerV4Holdings({ positions: putsOnly, cycleBreakEvenPerShare: null, potDollars: 64_007 })).toEqual({ waiting: expect.stringContaining("holds no shares yet") });
    const shares = [{ strategyKey: "unstructured", status: "open" as const, legs: [leg("s1", { legType: "stock", side: "long", quantity: 100, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1 })] }];
    expect(adoptVolFarmerV4Holdings({ positions: shares, cycleBreakEvenPerShare: null, potDollars: 64_007 })).toEqual({ waiting: expect.stringContaining("break-even cannot be worked out") });
  });
});

describe("the live book and its orders", () => {
  it("opens a cycle on a flat ticker with half its allocation, the shares bought with the first Call", () => {
    const state = newVolFarmerV2SymbolState();
    const { book, planned } = createVolFarmerV4LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2, v3 } = rulesOnNextExpiry();
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, v3, book });
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
    const first = createVolFarmerV4LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2, v3 } = rulesOnNextExpiry();
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, v3, book: first.book });
    const order = first.planned[0]!;
    const pending = pendingVolFarmerV4Order(state, order, "a1", optionCommissionDollars);
    replaceVolFarmerV4LegRef(state, order.ref, pending.ref);
    expect(pending).toMatchObject({ ref: "action:a1", kind: "covered_call", contracts: 3, startsCycle: true, contractsByPosition: { first: 3, second: 0 } });
    const plannedBreakEven = volFarmerV2BreakEven(state.first!)!;

    // The next look, the order still working: the ticker is not flat, the Call is open, nothing new is planned.
    const second = createVolFarmerV4LiveBook({ state, pending: [pending], snapshot: snapshotOf({ flat: true }) });
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, v3, book: second.book });
    expect(second.planned).toEqual([]);
    expect(state.first!.calls).toEqual([{ legId: "action:a1", shares: 300 }]);

    // Filled: 2 of 3 lots, the shares at 100.10 with commission, the Calls for $250 net.
    expect(settleVolFarmerV4Order(state, pending, { working: false, filledContracts: 2, optionLegIds: ["leg-c"], optionNetDollars: 250, sharesBought: 200, sharesCostDollars: 20_020, sharesSold: 0 })).toContain("2 of 3 filled");
    expect(state.first).toMatchObject({ shares: 200, costPerShare: 100.1, premiums: [{ legId: "leg-c", dollars: 250, shares: 200 }], calls: [{ legId: "leg-c", shares: 200 }] });
    expect(volFarmerV2BreakEven(state.first!)).toBeCloseTo(100.1 - 250 / 200, 10);
    expect(volFarmerV2BreakEven(state.first!)).not.toBeCloseTo(plannedBreakEven, 2);
  });

  it("undoes an opening order that never filled: no cycle", () => {
    const state = newVolFarmerV2SymbolState();
    const { book, planned } = createVolFarmerV4LiveBook({ state, pending: [], snapshot: snapshotOf() });
    const { farmer, v2, v3 } = rulesOnNextExpiry();
    runVolFarmerV2Steps({ state, market: marketOf(100), farmer, v2, v3, book });
    const pending = pendingVolFarmerV4Order(state, planned[0]!, "a1", optionCommissionDollars);
    replaceVolFarmerV4LegRef(state, planned[0]!.ref, pending.ref);
    expect(settleVolFarmerV4Order(state, pending, unfilledVolFarmerV4Outcome)).toContain("did not fill");
    expect(state.first).toBeNull();
    expect(state.potDollars).toBe(0);
  });

  it("takes an unfilled Put back out of the second position, its premium with it", () => {
    const order: VolFarmerV4PendingOrder = { ref: "action:p", actionId: "p", kind: "cash_secured_put", expiry: "2026-11-06", strike: 85, contracts: 5, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 296.75 }, leapsBeforeSale: null };
    const state = newVolFarmerV2SymbolState();
    state.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "leg-p0", dollars: 3.25, shares: 100 }, { legId: "action:p", dollars: 296.75, shares: 500 }], calls: [], puts: [{ legId: "action:p", shares: 500 }] };
    settleVolFarmerV4Order(state, order, unfilledVolFarmerV4Outcome);
    expect(state.second).toMatchObject({ puts: [], premiums: [{ legId: "leg-p0", dollars: 3.25, shares: 100 }] });

    // Saved before premiums were kept per option: the planned premium is in the total, which loses it.
    const saved = newVolFarmerV2SymbolState();
    saved.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "", dollars: 300, shares: 0 }], calls: [], puts: [{ legId: "action:p", shares: 500 }] };
    settleVolFarmerV4Order(saved, order, unfilledVolFarmerV4Outcome);
    expect(saved.second!.premiums).toEqual([{ legId: "", dollars: 3.25, shares: 0 }]);
  });

  it("reads a memory saved with a premium total as one premium counted in full", () => {
    const memory = { state: newVolFarmerV2SymbolState(), pending: [] };
    memory.state.first = { shares: 300, costPerShare: 50.01, premiumDollars: 328, calls: [], puts: [] } as unknown as VolFarmerV2Position;
    memory.state.second = { shares: 0, costPerShare: 0, premiumDollars: 0, calls: [], puts: [] } as unknown as VolFarmerV2Position;
    const read = volFarmerV4MemoryFromStored(memory);
    expect(read.state.first).toEqual({ shares: 300, costPerShare: 50.01, premiums: [{ legId: "", dollars: 328, shares: 0 }], calls: [], puts: [] });
    expect(read.state.second).toEqual({ shares: 0, costPerShare: 0, premiums: [], calls: [], puts: [] });
    expect(volFarmerV2BreakEven(read.state.first!)).toBeCloseTo(50.01 - 328 / 300, 10);
  });

  it("keeps a LEAPS partly bought for its top-up, forgets one not bought at all, and gives back one not sold whole", () => {
    const state = newVolFarmerV2SymbolState();
    state.leaps = { legIds: ["action:l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 };
    state.leapsBought = true;
    const buy: VolFarmerV4PendingOrder = { ref: "action:l", actionId: "l", kind: "buy_leaps", expiry: "2027-12-17", strike: 80, contracts: 4, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null };
    expect(settleVolFarmerV4Order(state, buy, { ...unfilledVolFarmerV4Outcome, filledContracts: 1, optionLegIds: ["leg-l"], optionNetDollars: 2_500 })).toContain("topped up");
    expect(state.leaps).toEqual({ legIds: ["leg-l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 });

    const unbought = newVolFarmerV2SymbolState();
    unbought.leaps = { legIds: ["action:l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 };
    unbought.leapsBought = true;
    settleVolFarmerV4Order(unbought, buy, unfilledVolFarmerV4Outcome);
    expect(unbought).toMatchObject({ leaps: null, leapsBought: false });

    const sold = newVolFarmerV2SymbolState();
    const sale: VolFarmerV4PendingOrder = { ...buy, ref: "action:s", actionId: "s", kind: "sell_leaps", leapsBeforeSale: { legIds: ["leg-l"], expiry: "2027-12-17", strike: 80, intendedContracts: 4 } };
    settleVolFarmerV4Order(sold, sale, { ...unfilledVolFarmerV4Outcome, filledContracts: 2 });
    expect(sold).toMatchObject({ leaps: { legIds: ["leg-l"] }, leapsToSell: true });
  });
});

describe("v4's share orders on the live book", () => {
  const sharesOrder = (position: "first" | "second", shares: number): VolFarmerV3SharesOrder => ({ position, shares, description: `${shares} shares`, chosenBecause: "test", candidateScores: {} });
  const stateHolding = (first: VolFarmerV2Position | null, second: VolFarmerV2Position | null = null) => ({ ...newVolFarmerV2SymbolState(), potDollars: 64_000, first, second });

  it("counts a purchase's cost at the look's price at once and a sale's proceeds only once filled, the look's sales as one order", () => {
    const state = stateHolding({ shares: 800, costPerShare: 90, premiums: [], calls: [], puts: [] }, { shares: 300, costPerShare: 120, premiums: [], calls: [], puts: [] });
    const { book, planned } = createVolFarmerV4LiveBook({ state, pending: [], snapshot: snapshotOf({ flat: false }) });
    book.buyShares!(sharesOrder("first", 200));
    expect(book.freeCash()).toBeCloseTo(200_000 - 200 * 100 - 1, 9);
    book.sellShares!(sharesOrder("second", 300));
    // The steps take the second's shares off after the call: the positions are kept as they were.
    removeVolFarmerV3Shares(state, "second", 300);
    book.sellShares!(sharesOrder("first", 100));
    expect(book.freeCash()).toBeCloseTo(200_000 - 20_001, 9);
    expect(planned.map((order) => order.kind)).toEqual(["buy_shares", "sell_shares"]);
    const sale = planned[1]!;
    if (sale.kind !== "sell_shares") throw new Error("not a sale");
    expect(sale.orders.map((part) => [part.position, part.shares])).toEqual([["second", 300], ["first", 100]]);
    expect(sale.positionsBeforeSale.second).toMatchObject({ shares: 300 });
    expect(pendingVolFarmerV4Order(state, sale, "s1", optionCommissionDollars)).toMatchObject({ kind: "sell_shares", shares: 400, saleParts: [{ position: "second", shares: 300 }, { position: "first", shares: 100 }], expiry: "", strike: 0, contracts: 0 });
  });

  it("settles a purchase at its fills: the shares bought at what they cost, none bought leaving the position as it was", () => {
    // 400 shares at $97.50 topped up by 100 planned at $80 ($8,001): the steps' (39,000 + 8,001) ÷ 500 = $94.002.
    const topUp = () => {
      const first: VolFarmerV2Position = { shares: 400, costPerShare: 97.5, premiums: [{ legId: "c0", dollars: 1_000, shares: 400 }], calls: [], puts: [] };
      addVolFarmerV3Shares(first, 100, 8_001);
      return stateHolding(first);
    };
    const order: VolFarmerV4PendingOrder = { ref: "action:b", actionId: "b", kind: "buy_shares", expiry: "", strike: 0, contracts: 0, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null, shares: 100, plannedSpentDollars: 8_001 };
    const filled = topUp();
    expect(settleVolFarmerV4Order(filled, order, { ...unfilledVolFarmerV4Outcome, sharesBought: 100, sharesCostDollars: 7_951 })).toBeNull();
    expect(filled.first!.shares).toBe(500);
    expect(filled.first!.costPerShare).toBeCloseTo((39_000 + 7_951) / 500, 9);
    const part = topUp();
    expect(settleVolFarmerV4Order(part, order, { ...unfilledVolFarmerV4Outcome, sharesBought: 40, sharesCostDollars: 3_180.2 })).toBe("the purchase of 100 shares, 40 filled");
    expect(part.first).toMatchObject({ shares: 440, premiums: [{ legId: "c0", dollars: 1_000, shares: 440 }] });
    expect(part.first!.costPerShare).toBeCloseTo((39_000 + 3_180.2) / 440, 9);
    const none = topUp();
    settleVolFarmerV4Order(none, order, unfilledVolFarmerV4Outcome);
    expect(none.first!.shares).toBe(400);
    expect(none.first!.costPerShare).toBeCloseTo(97.5, 9);
    expect(volFarmerV2BreakEven(none.first!)).toBeCloseTo(97.5 - 1_000 / 400, 9);

    // A new cycle's shares bought alone and not filled: no cycle.
    const opening = stateHolding({ shares: 500, costPerShare: 100.005, premiums: [], calls: [], puts: [] });
    expect(settleVolFarmerV4Order(opening, { ...order, startsCycle: true, shares: 500, plannedSpentDollars: 50_002.5 }, unfilledVolFarmerV4Outcome)).toBe("the purchase of 500 shares did not fill: no cycle");
    expect(opening).toMatchObject({ first: null, potDollars: 0 });
  });

  it("settles a sale at its fills: the shares not sold go back, a second position sold out only if all of its shares sold", () => {
    const before = { first: { shares: 800, costPerShare: 90, premiums: [{ legId: "c1", dollars: 800, shares: 800 }], calls: [], puts: [] }, second: { shares: 300, costPerShare: 120, premiums: [], calls: [], puts: [] }, leapsBought: true, leapsToSell: false, leapsTrigger: null };
    const sold = stateHolding(structuredClone(before.first), structuredClone(before.second));
    sold.leaps = { legIds: ["leg-l"], expiry: "2027-12-17", strike: 80, intendedContracts: 2 };
    sold.leapsBought = true;
    removeVolFarmerV3Shares(sold, "second", 300);
    removeVolFarmerV3Shares(sold, "first", 100);
    expect(sold).toMatchObject({ second: null, leapsToSell: true });
    const order: VolFarmerV4PendingOrder = { ref: "action:s", actionId: "s", kind: "sell_shares", expiry: "", strike: 0, contracts: 0, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null, shares: 400, saleParts: [{ position: "second", shares: 300 }, { position: "first", shares: 100 }], positionsBeforeSale: before };
    // 250 of 400 sold: the second's first 250, the first's none.
    expect(settleVolFarmerV4Order(sold, order, { ...unfilledVolFarmerV4Outcome, sharesSold: 250 })).toBe("the sale of 400 shares, 250 filled");
    expect(sold).toMatchObject({ first: { shares: 800, premiums: [{ dollars: 800, shares: 800 }] }, second: { shares: 50 }, leapsBought: true, leapsToSell: false });
    expect(settleVolFarmerV4Order(sold, order, { ...unfilledVolFarmerV4Outcome, sharesSold: 400 })).toBeNull();
  });
});
