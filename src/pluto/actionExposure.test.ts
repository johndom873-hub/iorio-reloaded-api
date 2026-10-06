import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { computePlutoActionExposure, type PlutoActionExposureInput, type PlutoActionOrderRequest } from "./actionExposure.js";

const cspPayload = { symbol: "HOOD", strategyKey: "cash_secured_put", legs: [{ role: "option", quantity: 2, strike: 24, unitPrice: 0.62 }] } as unknown as OrderRequestPayload;
const ccPayload = { symbol: "COHR", strategyKey: "covered_call", legs: [{ role: "stock", quantity: 500, unitPrice: 93 }, { role: "option", quantity: 5, strike: 95, unitPrice: 2.45 }] } as unknown as OrderRequestPayload;
const rollPayload = { symbol: "MU", strategyKey: "cash_secured_put", legs: [{ role: "option", quantity: 1, strike: 105, unitPrice: 1.9, positionLegId: "leg-1" }, { role: "option", quantity: 1, strike: 100, unitPrice: 0.85 }] } as unknown as OrderRequestPayload;
const closePayload = { symbol: "COIN", strategyKey: "cash_secured_put", legs: [] } as unknown as OrderRequestPayload;

const action = (overrides: Partial<PlutoActionExposureInput>): PlutoActionExposureInput => ({ kind: "open_cash_secured_put", outcome: "filled", contract: null, quantity: 2, limitPrice: 0.62, fillPrice: null, ...overrides });
const order = (requestType: string, payload: OrderRequestPayload, filledQuantity: number | null = null): PlutoActionOrderRequest => ({ requestType, payload, filledQuantity });

describe("computePlutoActionExposure", () => {
  it("is nothing for an action that never became an order, or whose order never filled", () => {
    expect(computePlutoActionExposure(action({ outcome: "blocked", quantity: 3 }), null)).toBeNull();
    for (const outcome of ["cancelled", "rejected", "error", "blocked", "validated"]) {
      expect(computePlutoActionExposure(action({ outcome }), order("open_cash_secured_put", cspPayload))).toBeNull();
    }
  });

  it("opens add what the order gate counts: strike × 100 per put, the shares for a buy-write; a working order counts its ordered quantity", () => {
    expect(computePlutoActionExposure(action({ outcome: "confirmed" }), order("open_cash_secured_put", cspPayload))).toBe(4800);
    expect(computePlutoActionExposure(action({ kind: "open_covered_call", quantity: 5, limitPrice: 2.45 }), order("open_covered_call", ccPayload, 5))).toBe(46_500);
  });

  it("a partial fill scales the order's figure by the filled share", () => {
    expect(computePlutoActionExposure(action({ outcome: "cancelled_partially_filled", quantity: 3 }), order("open_cash_secured_put", { ...cspPayload, legs: [{ role: "option", quantity: 3, strike: 88, unitPrice: 2.1 }] } as unknown as OrderRequestPayload, 2))).toBe(17_600);
    expect(computePlutoActionExposure(action({ kind: "open_covered_call", outcome: "partially_filled", quantity: 5 }), order("open_covered_call", ccPayload, 2))).toBe(18_600);
  });

  it("a roll down adds nothing; a roll up adds the strike difference", () => {
    expect(computePlutoActionExposure(action({ kind: "roll", quantity: 1, limitPrice: 0.85 }), order("roll_leg", rollPayload, 1))).toBe(0);
    const rollUp = { ...rollPayload, legs: [{ role: "option", quantity: 1, strike: 100, unitPrice: 1.9, positionLegId: "leg-1" }, { role: "option", quantity: 1, strike: 105, unitPrice: 0.85 }] } as unknown as OrderRequestPayload;
    expect(computePlutoActionExposure(action({ kind: "roll", quantity: 1, limitPrice: 0.85 }), order("roll_leg", rollUp, 1))).toBe(500);
  });

  it("closes release exposure: a put buyback frees the strike, selling shares frees their value (filled shares), a call buyback frees nothing", () => {
    expect(computePlutoActionExposure(action({ kind: "close_leg", contract: { strike: 300, right: "P" }, quantity: 1, limitPrice: 0.35, fillPrice: 0.35 }), order("close_position", closePayload, 1))).toBe(-30_000);
    expect(computePlutoActionExposure(action({ kind: "close_leg", contract: { strike: 95, right: "C" }, quantity: 1, limitPrice: 0.35 }), order("close_position", closePayload, 1))).toBe(0);
    expect(computePlutoActionExposure(action({ kind: "close_shares", quantity: 100, limitPrice: 24.8, fillPrice: 24.82 }), order("close_position", closePayload, 100))).toBe(-2482);
    expect(computePlutoActionExposure(action({ kind: "close_shares", outcome: "cancelled_partially_filled", quantity: 100, limitPrice: 24.8, fillPrice: 24.82 }), order("close_position", closePayload, 40))).toBeCloseTo(-992.8, 6);
  });
});
