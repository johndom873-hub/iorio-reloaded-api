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
      rollFromStrike: undefined,
      excludeOrderRequestId: "o1",
    });
  });

  it("reads a roll's new leg and the strike it closes", () => {
    expect(limitsInputFromOrderRequest({ id: "o2", request_type: "roll_leg", payload: putRoll })).toMatchObject({ strike: 95, rollFromStrike: 90, quantity: 2 });
  });

  it("does not limit-check a close, or an order without a strategy or option leg", () => {
    expect(limitsInputFromOrderRequest({ id: "o3", request_type: "close_position", payload: putOpen })).toBeNull();
    expect(limitsInputFromOrderRequest({ id: "o4", request_type: "open_cash_secured_put", payload: { ...putOpen, strategyKey: undefined } as unknown as OrderRequestPayload })).toBeNull();
    expect(limitsInputFromOrderRequest({ id: "o5", request_type: "open_covered_call", payload: { symbol: "AAA", strategyKey: "covered_call", legs: [] } as unknown as OrderRequestPayload })).toBeNull();
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
