import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { combineOrderGateVerdicts, describeCalendarWarnings, limitsInputFromOrderRequest } from "./orderGates.js";

const putOpen = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261016", right: "P" }] } as OrderRequestPayload;
const putRoll = {
  symbol: "AAA",
  strategyKey: "cash_secured_put",
  legs: [
    { role: "option", action: "BUY", symbol: "AAA", quantity: 2, unitPrice: 1, strike: 90, expiry: "20261009", right: "P", positionLegId: "leg-1" },
    { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 2, strike: 95, expiry: "20261016", right: "P" },
  ],
} as OrderRequestPayload;

describe("limitsInputFromOrderRequest", () => {
  it("limit-checks an open from any origin, excluding the order itself from the in-flight totals", () => {
    expect(limitsInputFromOrderRequest({ id: "o1", request_type: "open_cash_secured_put", payload: putOpen })).toEqual({
      strategyKey: "cash_secured_put",
      symbol: "AAA",
      quantity: 2,
      strike: 90,
      premium: 1.5,
      rollFromStrike: undefined,
      rollFromPremium: undefined,
      excludeOrderRequestId: "o1",
    });
  });

  it("reads a roll's new leg and the strike it closes, with both limit prices", () => {
    expect(limitsInputFromOrderRequest({ id: "o2", request_type: "roll_leg", payload: putRoll })).toMatchObject({ strike: 95, premium: 2, rollFromStrike: 90, rollFromPremium: 1, quantity: 2 });
  });

  it("does not limit-check a close, or an order without a strategy or option leg", () => {
    expect(limitsInputFromOrderRequest({ id: "o3", request_type: "close_position", payload: putOpen })).toBeNull();
    expect(limitsInputFromOrderRequest({ id: "o4", request_type: "open_cash_secured_put", payload: { ...putOpen, strategyKey: undefined } as unknown as OrderRequestPayload })).toBeNull();
    expect(limitsInputFromOrderRequest({ id: "o5", request_type: "open_covered_call", payload: { symbol: "AAA", strategyKey: "covered_call", legs: [] } as unknown as OrderRequestPayload })).toBeNull();
  });
});

describe("limitsInputFromOrderRequest for a CC + Put Ladder order", () => {
  it("carries the pot and the shares the Covered Call entry buys (every share, uncovered ones held or not)", () => {
    const coveredCallEntry = { symbol: "AAA", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY", symbol: "AAA", quantity: 200, unitPrice: 50 }, { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1.1, strike: 55, expiry: "20261120", right: "C" }] } as OrderRequestPayload;
    expect(limitsInputFromOrderRequest({ id: "o6", request_type: "open_covered_call", payload: coveredCallEntry }, { potFraction: 0.25, book: { symbols: ["AAA", "BBB"], budgetFraction: 0.5 } })).toMatchObject({ strategyKey: "covered_call", quantity: 2, strike: 55, ladder: { potFraction: 0.25, stockSharesBought: 200, book: { symbols: ["AAA", "BBB"], budgetFraction: 0.5 } } });
    expect(limitsInputFromOrderRequest({ id: "o7", request_type: "open_cash_secured_put", payload: putOpen }, { potFraction: 0.1, book: { symbols: ["AAA"], budgetFraction: 0.5 } })).toMatchObject({ ladder: { potFraction: 0.1, stockSharesBought: 0 } });
    // Outside the ladder too, a covered call's stock leg is counted as bought; with no stock leg the shortfall is worked out at check time.
    expect(limitsInputFromOrderRequest({ id: "o8", request_type: "open_covered_call", payload: coveredCallEntry })).toMatchObject({ stockSharesBought: 200 });
    const callOnHeldShares = { ...coveredCallEntry, legs: coveredCallEntry.legs.filter((leg) => leg.role === "option") } as OrderRequestPayload;
    expect(limitsInputFromOrderRequest({ id: "o9", request_type: "open_covered_call", payload: callOnHeldShares })).not.toHaveProperty("stockSharesBought");
    expect(limitsInputFromOrderRequest({ id: "o8", request_type: "open_cash_secured_put", payload: putOpen })).not.toHaveProperty("ladder");
  });
});

describe("describeCalendarWarnings", () => {
  it("lists the events before expiry in one line", () => {
    expect(describeCalendarWarnings({ calendar_warning_events: [{ title: "FOMC Rate Decision", eventDate: "2026-10-07" }, { title: "CPI", eventDate: "2026-10-14" }] })).toEqual([
      "2 economic events before expiry: 2026-10-07 FOMC Rate Decision; 2026-10-14 CPI.",
    ]);
  });

  it("falls back to the stored warning text, and says nothing without either", () => {
    expect(describeCalendarWarnings({ calendar_warning: "Earnings on 2026-10-20.", calendar_warning_events: [] })).toEqual(["Earnings on 2026-10-20."]);
    expect(describeCalendarWarnings({})).toEqual([]);
  });
});

describe("combineOrderGateVerdicts", () => {
  const clear = { tradingBlockedReason: null, limits: null, deltaBand: null, closeGate: null, warnings: [] };

  it("has no blocks when every gate passes, and keeps the warnings", () => {
    expect(combineOrderGateVerdicts({ ...clear, limits: { blocked: false, reasons: [] }, deltaBand: { compliant: true, reason: null }, warnings: ["w"] })).toEqual({ blocks: [], warnings: ["w"] });
  });

  it("collects every block in a fixed order: trading, limits, delta band, close gate", () => {
    const combined = combineOrderGateVerdicts({
      tradingBlockedReason: "Trading is blocked: x",
      limits: { blocked: true, reasons: ["too big", "too concentrated"] },
      deltaBand: { compliant: false, reason: "Delta is out of band." },
      closeGate: { blocked: true, reason: "Market closed.", cycleTotal: null },
      warnings: [],
    });
    expect(combined.blocks).toEqual(["Trading is blocked: x", "too big", "too concentrated", "Delta is out of band.", "Market closed."]);
  });

  it("blocks an unreadable delta band even without a reason text", () => {
    expect(combineOrderGateVerdicts({ ...clear, deltaBand: { compliant: false, reason: null } }).blocks).toEqual(["The delta band could not be verified."]);
    expect(combineOrderGateVerdicts({ ...clear, priceCheck: { blocked: true, reasons: ["price a", "price b"], legs: [] } }).blocks).toEqual(["price a", "price b"]);
    expect(combineOrderGateVerdicts({ ...clear, priceCheck: { blocked: false, reasons: [], legs: [] } }).blocks).toEqual([]);
  });
});
