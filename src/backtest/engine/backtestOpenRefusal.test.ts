import { describe, expect, it } from "vitest";
import { evaluateOrderLimitFigures } from "../../lib/orderLimits.js";
import type { TradingSettings } from "../../lib/tradingSettingsStore.js";
import type { SizingRoom } from "../../pluto/postModelGates.js";
import { classifyOpenRefusal, orderLimitBreachesOf, type OpenRefusalInput } from "./backtestOpenRefusal.js";
import { fixtureBacktestSettings } from "./testSupport/syntheticBacktestData.js";

// One contract commits $9,500 here; the book's room is $50,000 everywhere unless a test narrows one limit.
const dollarsPerContract = 9_500;
const roomyBook: SizingRoom = { budgetRoom: 50_000, orderCap: 50_000, tickerRoom: 50_000, sectorRoom: Number.POSITIVE_INFINITY, cashRoom: 50_000 };
const refusal = (gates: string[], overrides: Partial<OpenRefusalInput> = {}) => classifyOpenRefusal({ failedGates: gates.map((gate) => ({ gate })), sizing: { room: roomyBook, dollarsPerContract }, orderLimitBreaches: null, ...overrides });
const sizedBy = (room: Partial<SizingRoom>) => refusal(["sizing"], { sizing: { room: { ...roomyBook, ...room }, dollarsPerContract } });

describe("what a refused open stops", () => {
  it("is only the contract when the refusal is about the contract", () => {
    for (const gate of ["candidate_fresh", "candidate_present", "edge_drift", "same_contract", "break_even", "limit_price", "order_build"]) expect(refusal([gate]), gate).toEqual({ scope: "candidate", reason: null });
  });

  it("is every open on the book at the open-positions cap", () => {
    expect(refusal(["open_positions_cap"])).toEqual({ scope: "book", reason: "the open-positions cap is reached" });
  });

  it("is every open on the ticker while it cools down or has an order working", () => {
    expect(refusal(["ticker_cooldown"])).toEqual({ scope: "ticker", reason: "the ticker is cooling down after a fill" });
    expect(refusal(["working_order"])).toEqual({ scope: "ticker", reason: "an order on the ticker is working" });
  });

  it("reads a sizing refusal from what left no room for one contract", () => {
    // The account's limits: no ticker has room.
    expect(sizedBy({ budgetRoom: 9_499 })).toEqual({ scope: "book", reason: "no capital budget left" });
    expect(sizedBy({ budgetRoom: -20_000 })).toEqual({ scope: "book", reason: "no capital budget left" });
    expect(sizedBy({ cashRoom: 5_000 })).toEqual({ scope: "book", reason: "no cash above the reserve" });
    // The ticker's.
    expect(sizedBy({ tickerRoom: 9_000 })).toEqual({ scope: "ticker", reason: "no ticker room" });
    expect(sizedBy({ sectorRoom: 0 })).toEqual({ scope: "ticker", reason: "no sector room" });
    // One contract larger than the order size is about the contract: a lower strike on the same ticker may fit.
    expect(sizedBy({ orderCap: 9_000 })).toEqual({ scope: "candidate", reason: null });
    // The account's limit wins over the ticker's when both are short.
    expect(sizedBy({ tickerRoom: 0, cashRoom: 0 })).toEqual({ scope: "book", reason: "no cash above the reserve" });
    // Room for one contract everywhere: its own stress, Kelly or volume cap sized it to zero.
    expect(sizedBy({ budgetRoom: 9_500 })).toEqual({ scope: "candidate", reason: null });
    // A call on shares already held uses no room.
    expect(refusal(["sizing"], { sizing: null })).toEqual({ scope: "candidate", reason: null });
  });

  it("reads an order-gate refusal from the limit it broke", () => {
    const breaches = { maxPositionSize: false, tickerConcentration: false, cashReserve: false };
    expect(refusal(["order_limits"], { orderLimitBreaches: { ...breaches, maxPositionSize: true } })).toEqual({ scope: "candidate", reason: null });
    expect(refusal(["order_limits"], { orderLimitBreaches: { ...breaches, tickerConcentration: true } })).toEqual({ scope: "ticker", reason: "the order gate's ticker concentration limit" });
    expect(refusal(["order_limits"], { orderLimitBreaches: { ...breaches, maxPositionSize: true, tickerConcentration: true, cashReserve: true } })).toEqual({ scope: "book", reason: "the order gate's cash reserve" });
  });

  it("takes the widest reach when several gates refused", () => {
    expect(refusal(["edge_drift", "ticker_cooldown"])).toMatchObject({ scope: "ticker" });
    expect(refusal(["ticker_cooldown", "open_positions_cap", "same_contract"])).toMatchObject({ scope: "book" });
    expect(refusal([])).toEqual({ scope: "candidate", reason: null });
  });

  it("refuses to guess for a gate it has no rule for", () => {
    expect(() => refusal(["a_new_gate"])).toThrow('The gate "a_new_gate" refused an open and has no rule for what the refusal stops.');
  });
});

describe("the order gate's broken limits", () => {
  // A $1,000,000 account, all cash: max order 10%, max per ticker 20%, cash reserve 5%.
  const settings = fixtureBacktestSettings().trading as TradingSettings;
  const figures = (orderNotional: number, existingTickerExposure: number, totalCashValue: number) => evaluateOrderLimitFigures({ symbol: "SYN", orderNotional, totalPortfolioValue: 1_000_000, totalCashValue, cashLockedInCsps: 0, existingTickerExposure, inFlight: { totalNotional: 0, tickerNotional: 0 }, settings });

  it("are read from the figures the gate reports", () => {
    expect(orderLimitBreachesOf(figures(50_000, 0, 1_000_000))).toEqual({ maxPositionSize: false, tickerConcentration: false, cashReserve: false });
    expect(orderLimitBreachesOf(figures(120_000, 0, 1_000_000))).toEqual({ maxPositionSize: true, tickerConcentration: false, cashReserve: false });
    expect(orderLimitBreachesOf(figures(50_000, 180_000, 1_000_000))).toEqual({ maxPositionSize: false, tickerConcentration: true, cashReserve: false });
    expect(orderLimitBreachesOf(figures(50_000, 0, 90_000))).toEqual({ maxPositionSize: false, tickerConcentration: false, cashReserve: true });
    const all = figures(150_000, 100_000, 160_000);
    expect(all.reasons).toHaveLength(3);
    expect(orderLimitBreachesOf(all)).toEqual({ maxPositionSize: true, tickerConcentration: true, cashReserve: true });
  });
});
