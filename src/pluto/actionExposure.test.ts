import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { computePlutoActionExposure } from "./actionExposure.js";

const cspPayload = { symbol: "HOOD", strategyKey: "cash_secured_put", legs: [{ role: "option", quantity: 2, strike: 24, unitPrice: 0.62 }] } as unknown as OrderRequestPayload;
const ccPayload = { symbol: "COHR", strategyKey: "covered_call", legs: [{ role: "stock", quantity: 500, unitPrice: 93 }, { role: "option", quantity: 5, strike: 95, unitPrice: 2.45 }] } as unknown as OrderRequestPayload;
const rollPayload = { symbol: "MU", strategyKey: "cash_secured_put", legs: [{ role: "option", quantity: 1, strike: 105, unitPrice: 1.9, positionLegId: "leg-1" }, { role: "option", quantity: 1, strike: 100, unitPrice: 0.85 }] } as unknown as OrderRequestPayload;

describe("computePlutoActionExposure", () => {
  it("is nothing for an action that never became an order", () => {
    expect(computePlutoActionExposure({ kind: "open_cash_secured_put", contract: { strike: 40 }, quantity: 3, limitPrice: 1.18, fillPrice: null }, null)).toBeNull();
  });

  it("opens add what the order gate counts: strike × 100 per put, the shares for a buy-write", () => {
    expect(computePlutoActionExposure({ kind: "open_cash_secured_put", contract: null, quantity: 2, limitPrice: 0.62, fillPrice: null }, { requestType: "open_cash_secured_put", payload: cspPayload })).toBe(4800);
    expect(computePlutoActionExposure({ kind: "open_covered_call", contract: null, quantity: 5, limitPrice: 2.45, fillPrice: null }, { requestType: "open_covered_call", payload: ccPayload })).toBe(46_500);
  });

  it("a roll down adds nothing; a roll up adds the strike difference", () => {
    expect(computePlutoActionExposure({ kind: "roll", contract: null, quantity: 1, limitPrice: 0.85, fillPrice: null }, { requestType: "roll_leg", payload: rollPayload })).toBe(0);
    const rollUp = { ...rollPayload, legs: [{ role: "option", quantity: 1, strike: 100, unitPrice: 1.9, positionLegId: "leg-1" }, { role: "option", quantity: 1, strike: 105, unitPrice: 0.85 }] } as unknown as OrderRequestPayload;
    expect(computePlutoActionExposure({ kind: "roll", contract: null, quantity: 1, limitPrice: 0.85, fillPrice: null }, { requestType: "roll_leg", payload: rollUp })).toBe(500);
  });

  it("closes release exposure: a put buyback frees the strike, selling shares frees their value, a call buyback frees nothing", () => {
    const closePayload = { symbol: "COIN", strategyKey: "cash_secured_put", legs: [] } as unknown as OrderRequestPayload;
    expect(computePlutoActionExposure({ kind: "close_leg", contract: { strike: 300, right: "P" }, quantity: 1, limitPrice: 0.35, fillPrice: 0.35 }, { requestType: "close_position", payload: closePayload })).toBe(-30_000);
    expect(computePlutoActionExposure({ kind: "close_leg", contract: { strike: 95, right: "C" }, quantity: 1, limitPrice: 0.35, fillPrice: null }, { requestType: "close_position", payload: closePayload })).toBe(0);
    expect(computePlutoActionExposure({ kind: "close_shares", contract: null, quantity: 100, limitPrice: 24.8, fillPrice: 24.82 }, { requestType: "close_position", payload: closePayload })).toBe(-2482);
  });
});
