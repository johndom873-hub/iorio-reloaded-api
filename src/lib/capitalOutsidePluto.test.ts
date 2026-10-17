import { describe, expect, it } from "vitest";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { sumCapitalInUseOutsidePluto, type WorkingOrderForCapital } from "./capitalOutsidePluto.js";

function putOpen(symbol: string, plutoActionId: string | null): WorkingOrderForCapital {
  // 2 contracts at the $50 strike for $1.00: (50 − 1) × 100 × 2 = $9,800.
  const payload = { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 1, strike: 50, expiry: "20261120", right: "P" }] } as OrderRequestPayload;
  return { request_type: "open_cash_secured_put", payload, pluto_action_id: plutoActionId };
}

describe("sumCapitalInUseOutsidePluto", () => {
  const plutoEnabledSymbols = new Set(["PLTO"]);

  it("counts every open position's EXP $ except Pluto's book: non-hedge positions on a ticker Pluto is enabled on", () => {
    const openPositions = [
      { symbol: "MANU", strategyKey: "cash_secured_put", capitalAtRisk: "10000" },
      { symbol: "MANU", strategyKey: "covered_call", capitalAtRisk: 4500.5 },
      { symbol: "PLTO", strategyKey: "covered_call", capitalAtRisk: "30000" },
      { symbol: "PLTO", strategyKey: "hedge", capitalAtRisk: "250" },
      { symbol: "MANU", strategyKey: "unstructured", capitalAtRisk: null },
    ];
    expect(sumCapitalInUseOutsidePluto(openPositions, [], plutoEnabledSymbols)).toBeCloseTo(10_000 + 4_500.5 + 250, 6);
  });

  it("counts working orders unless they are Pluto's or on a ticker Pluto is enabled on", () => {
    const workingOrders = [putOpen("MANU", null), putOpen("MANU", "pluto-action"), putOpen("PLTO", null)];
    expect(sumCapitalInUseOutsidePluto([], workingOrders, plutoEnabledSymbols)).toBe(9_800);
  });

  it("is zero for an empty book", () => {
    expect(sumCapitalInUseOutsidePluto([], [], new Set())).toBe(0);
  });
});
