import { describe, expect, it } from "vitest";
import { computeInFlightOrderNotional, computeOrderNotional } from "./orderLimits.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// Formula 3g's OrderNotional, plus the Roll Signals rule (2026-09-24): a roll re-uses the
// closed leg's notional, so only a cash-secured put moving UP in strike adds anything. Net of the
// premium since 2026-10-12 (Marcelo): the exposure Positions shows.
describe("computeOrderNotional", () => {
  it("open orders: a CSP reserves (strike − premium) × 100 × qty; a covered call only the share shortfall at spot less the premium", () => {
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2, premium: 1.5 }, 100, 0)).toBe(17_700);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 0)).toBe(19_800);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 150)).toBe(4_950);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 300)).toBe(0);
  });

  it("rolls: a covered-call roll adds nothing; a CSP roll adds the strike increase less the net credit × 100 × qty, never a negative", () => {
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 105, quantity: 3, premium: 2, rollFromStrike: 110, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 2, rollFromStrike: 90, rollFromPremium: 1.5 }, 100, 0)).toBe(900);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 7, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 85, quantity: 2, premium: 1, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2, premium: 1, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(() => computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 1, rollFromStrike: 90 }, 100, 0)).toThrow("rollFromPremium");
  });
});

const putOpen: OrderRequestPayload = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261016", right: "P" }] } as OrderRequestPayload;

describe("computeInFlightOrderNotional", () => {
  it("reserves (strike − limit price) x 100 x contracts for a put open", () => {
    expect(computeInFlightOrderNotional("open_cash_secured_put", putOpen)).toBe(17_700);
  });

  it("counts a Covered Call entry's stock leg at shares x (limit price − call premium), and nothing when it is written against held shares", () => {
    const coveredCallEntry = { symbol: "AAA", strategyKey: "covered_call", legs: [
      { role: "stock", action: "BUY", symbol: "AAA", quantity: 200, unitPrice: 50 },
      { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1, strike: 55, expiry: "20261016", right: "C" },
    ] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("open_covered_call", coveredCallEntry)).toBe(9_800);
    const heldShares = { ...coveredCallEntry, legs: [coveredCallEntry.legs[1]!] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("open_covered_call", heldShares)).toBe(0);
  });

  it("adds only the upward strike difference less the net credit for a put roll, never for a call roll", () => {
    const putRoll = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [
      { role: "option", action: "BUY", symbol: "AAA", quantity: 2, unitPrice: 1, strike: 90, expiry: "20261009", right: "P", positionLegId: "leg-1" },
      { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 2, strike: 95, expiry: "20261016", right: "P" },
    ] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("roll_leg", putRoll)).toBe(800); // (95 − 90 − (2 − 1)) × 100 × 2
    expect(computeInFlightOrderNotional("roll_leg", { ...putRoll, strategyKey: "covered_call" } as OrderRequestPayload)).toBe(0);
  });

  it("ignores closes and orders with no strategy", () => {
    expect(computeInFlightOrderNotional("close_position", putOpen)).toBe(0);
    expect(computeInFlightOrderNotional("open_covered_call", { ...putOpen, strategyKey: undefined } as unknown as OrderRequestPayload)).toBe(0);
  });
});
