import { describe, expect, it } from "vitest";
import { formatPositionExpiredMessage } from "./formatPositionExpiredMessage.js";

const legs = [
  { legType: "option" as const, side: "short" as const, quantity: 1, optionType: "call" as const, strikePrice: 105 },
  { legType: "stock" as const, side: "long" as const, quantity: 100, optionType: null, strikePrice: null },
];

describe("formatPositionExpiredMessage", () => {
  it("covered call assigned (desired outcome): a green or red dot by P&L sign, not a checkmark", () => {
    const gain = formatPositionExpiredMessage({ symbol: "BE", strategyKey: "covered_call", legs, realizedPnl: 543.87, realizedPnlPercent: 1.93, assigned: true });
    expect(gain.startsWith("🟢")).toBe(true);
    const loss = formatPositionExpiredMessage({ symbol: "BE", strategyKey: "covered_call", legs, realizedPnl: -10, realizedPnlPercent: -0.1, assigned: true });
    expect(loss.startsWith("🔴")).toBe(true);
  });

  it("covered call expired worthless (undesired outcome): a warning triangle regardless of P&L sign", () => {
    const message = formatPositionExpiredMessage({ symbol: "SPCX", strategyKey: "covered_call", legs, realizedPnl: 537.74, realizedPnlPercent: 1.76, assigned: false });
    expect(message.startsWith("⚠️")).toBe(true);
  });

  it("cash-secured put expired worthless (desired outcome): a dot, not a triangle", () => {
    const message = formatPositionExpiredMessage({ symbol: "DELL", strategyKey: "cash_secured_put", legs, realizedPnl: 1244.1, realizedPnlPercent: 2.22, assigned: false });
    expect(message.startsWith("🟢")).toBe(true);
  });

  it("cash-secured put assigned (undesired outcome): a warning triangle", () => {
    const message = formatPositionExpiredMessage({ symbol: "COHR", strategyKey: "cash_secured_put", legs, realizedPnl: 734.71, realizedPnlPercent: 2.31, assigned: true });
    expect(message.startsWith("⚠️")).toBe(true);
  });

  it("uncertain (marginal ITM/OTM) appends a manual-verification note", () => {
    const message = formatPositionExpiredMessage({ symbol: "BE", strategyKey: "covered_call", legs, realizedPnl: 543.87, realizedPnlPercent: 1.93, assigned: false, uncertain: true });
    expect(message).toContain("verify assignment manually");
  });

  it("omits the uncertainty note when not flagged", () => {
    const message = formatPositionExpiredMessage({ symbol: "BE", strategyKey: "covered_call", legs, realizedPnl: 543.87, realizedPnlPercent: 1.93, assigned: true });
    expect(message).not.toContain("verify assignment manually");
  });
});
