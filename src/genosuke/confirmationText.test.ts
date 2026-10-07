import { describe, expect, it } from "vitest";
import {
  annotateLegOpenState,
  buildOrderCard,
  buildTradingHaltCard,
  buildRiskLimitsCard,
  validateCloseLegs,
  type PositionForCard,
} from "./confirmationText.js";
import { toIsoExpiry } from "../lib/tradeMessageFormatting.js";

// Mirrors the real staging AAOI position: the 110 call expired (leg closed), 100 shares still open.
const aaoi: PositionForCard = {
  symbol: "AAOI",
  strategyKey: "unstructured",
  status: "open",
  legs: [
    { id: "call-leg", legType: "option", side: "short", quantity: 1, optionType: "call", strikePrice: 110, expiryDate: "2026-09-18", exitAt: "2026-09-19T02:32:37Z" },
    { id: "stock-leg", legType: "stock", side: "long", quantity: 100, optionType: null, strikePrice: null, expiryDate: null, exitAt: null },
  ],
};

describe("close", () => {
  it("rejects a close that includes the already-expired leg and names the correct open legs", () => {
    const error = validateCloseLegs(aaoi, [{ legId: "call-leg" }, { legId: "stock-leg" }]);
    expect(error).toContain("call-leg");
    expect(error).toContain("stock-leg (long 100 shares)");
  });

  it("rejects a close that leaves out an open leg", () => {
    expect(validateCloseLegs(aaoi, [])).toContain("left out: stock-leg");
  });

  it("accepts a close of exactly the open legs", () => {
    expect(validateCloseLegs(aaoi, [{ legId: "stock-leg" }])).toBeNull();
  });

  it("refuses to close an already-closed position", () => {
    expect(validateCloseLegs({ ...aaoi, status: "closed" }, [{ legId: "stock-leg" }])).toContain("already closed");
  });
});

describe("buildOrderCard (from the order the server built)", () => {
  it("an opening put: one limit order with the option leg and its limit", () => {
    expect(
      buildOrderCard({
        requestType: "open_cash_secured_put",
        payload: { symbol: "AAOI", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", quantity: 2, unitPrice: 1.35, strike: 50, expiry: "20261016", right: "P" }] },
      }),
    ).toBe("Place order for AAOI (cash-secured put)\n• SELL 2 put $50 exp 2026-10-16, limit 1.35\nOne limit order, sent to IBKR immediately when you tap Yes.");
  });

  it("a buy-write lists BOTH legs, including a stock leg the server added, as one combo", () => {
    const card = buildOrderCard({
      requestType: "open_covered_call",
      payload: {
        symbol: "AAOI",
        strategyKey: "covered_call",
        legs: [
          { role: "stock", action: "BUY", quantity: 200, unitPrice: 48.2 },
          { role: "option", action: "SELL", quantity: 2, unitPrice: 1.1, strike: 55, expiry: "20261016", right: "C" },
        ],
      },
    });
    expect(card.split("\n")).toEqual([
      "Place order for AAOI (covered call)",
      "• BUY 200 shares, limit 48.20",
      "• SELL 2 call $55 exp 2026-10-16, limit 1.10",
      "One combo order, sent to IBKR immediately when you tap Yes.",
    ]);
  });

  it("a close buys back a short option and sells the long shares", () => {
    const card = buildOrderCard({
      requestType: "close_position",
      payload: {
        symbol: "SPCX",
        strategyKey: "covered_call",
        legs: [
          { role: "option", action: "BUY", quantity: 2, unitPrice: 0.5, strike: 152.5, expiry: "20260925", right: "C", positionLegId: "c" },
          { role: "stock", action: "SELL", quantity: 200, unitPrice: 151, positionLegId: "s" },
        ],
      },
    });
    expect(card.split("\n")[0]).toBe("Close SPCX (covered call)");
    expect(card).toContain("• BUY BACK 2 call $152.5 exp 2026-09-25, limit 0.50");
    expect(card).toContain("• SELL 200 shares, limit 151.00");
    expect(card).toContain("One combo order");
  });

  it("a roll is headed Roll, and a BUY of an option that closes nothing stays a plain BUY", () => {
    const card = buildOrderCard({
      requestType: "roll_leg",
      payload: {
        symbol: "DRAM",
        strategyKey: "cash_secured_put",
        legs: [
          { role: "option", action: "BUY", quantity: 1, unitPrice: 0.4, strike: 60, expiry: "20261016", right: "P", positionLegId: "old" },
          { role: "option", action: "SELL", quantity: 1, unitPrice: 0.9, strike: 61.5, expiry: "20261113", right: "P" },
        ],
      },
    });
    expect(card.split("\n")[0]).toBe("Roll DRAM (cash-secured put)");
    expect(card).toContain("• BUY BACK 1 put $60 exp 2026-10-16, limit 0.40");
    expect(card).toContain("• SELL 1 put $61.5 exp 2026-11-13, limit 0.90");
    const plainBuy = buildOrderCard({ requestType: "open_cash_secured_put", payload: { symbol: "X", legs: [{ role: "option", action: "BUY", quantity: 1, unitPrice: 1, strike: 10, expiry: "20261016", right: "P" }] } });
    expect(plainBuy).toContain("• BUY 1 put $10");
    expect(plainBuy.split("\n")[0]).toBe("Place order for X");
  });
});

describe("buildTradingHaltCard", () => {
  it("halts with the reason, resumes with or without one", () => {
    expect(buildTradingHaltCard(true, "stop")).toBe("HALT ALL TRADING: no order from any origin reaches IBKR until it is resumed (cancels still work). Reason: stop");
    expect(buildTradingHaltCard(false, undefined)).toBe("RESUME TRADING: orders reach IBKR again from every origin.");
    expect(buildTradingHaltCard(false, "  ")).toBe("RESUME TRADING: orders reach IBKR again from every origin.");
  });
});

describe("other cards", () => {
  it("shows only the settings being changed, each as old to new", () => {
    const card = buildRiskLimitsCard({ minCashReservePct: 8, deltaTargetMax: 0.35 }, { minCashReservePct: 5, deltaTargetMax: 0.4, deltaTargetMin: 0.2 });
    expect(card.split("\n")).toEqual(["Update the trading limits", "• Min cash reserve %: 5 → 8", "• Delta band max: 0.4 → 0.35"]);
  });

  it("labels the limit-price check settings", () => {
    expect(buildRiskLimitsCard({ priceCheckMaxDeviationPct: 15, priceCheckMinToleranceDollars: 0.1 }, { priceCheckMaxDeviationPct: 10, priceCheckMinToleranceDollars: 0.05 }).split("\n")).toEqual([
      "Update the trading limits",
      "• Limit-price check: max % off the live mid: 10 → 15",
      "• Limit-price check: minimum allowance $: 0.05 → 0.1",
    ]);
  });

  it("shows a bare value when the current one is unknown or unchanged", () => {
    expect(buildRiskLimitsCard({ minCashReservePct: 8 })).toContain("• Min cash reserve %: 8");
    expect(buildRiskLimitsCard({ minCashReservePct: 8 }, { minCashReservePct: 8 })).toContain("• Min cash reserve %: 8");
  });
});

describe("helpers", () => {
  it("converts YYYYMMDD and leaves ISO dates alone", () => {
    expect(toIsoExpiry("20260925")).toBe("2026-09-25");
    expect(toIsoExpiry("2026-09-25")).toBe("2026-09-25");
  });

  it("marks each leg open or closed, in lists and single positions, and leaves other values alone", () => {
    const [annotated] = annotateLegOpenState([aaoi]);
    expect(annotated.legs.map((leg) => (leg as { isOpen?: boolean }).isOpen)).toEqual([false, true]);
    expect(annotateLegOpenState({ hello: 1 })).toEqual({ hello: 1 });
  });
});
