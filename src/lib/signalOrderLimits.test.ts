import { describe, expect, it } from "vitest";
import { computeSignalOrderNotional } from "./signalOrderLimits.js";

// Formula 3g's OrderNotional, plus the Roll Signals rule (2026-09-24): a roll re-uses the
// closed leg's notional, so only a cash-secured put moving UP in strike adds anything.
describe("computeSignalOrderNotional", () => {
  it("open orders: a CSP reserves strike × 100 × qty; a covered call only the share shortfall at spot", () => {
    expect(computeSignalOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2 }, 100, 0)).toBe(18_000);
    expect(computeSignalOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2 }, 100, 0)).toBe(20_000);
    expect(computeSignalOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2 }, 100, 150)).toBe(5_000);
    expect(computeSignalOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2 }, 100, 300)).toBe(0);
  });

  it("rolls: a covered-call roll adds nothing; a CSP roll adds the strike increase × 100 × qty, never a negative", () => {
    expect(computeSignalOrderNotional({ strategyKey: "covered_call", strike: 105, quantity: 3, rollFromStrike: 110 }, 100, 0)).toBe(0);
    expect(computeSignalOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, rollFromStrike: 90 }, 100, 0)).toBe(1_000);
    expect(computeSignalOrderNotional({ strategyKey: "cash_secured_put", strike: 85, quantity: 2, rollFromStrike: 90 }, 100, 0)).toBe(0);
    expect(computeSignalOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2, rollFromStrike: 90 }, 100, 0)).toBe(0);
  });
});
