import { describe, expect, it } from "vitest";
import {
  annotateLegOpenState,
  buildCloseCard,
  buildRejectAlertCard,
  buildRiskLimitsCard,
  buildRollCard,
  toIsoExpiry,
  validateCloseLegs,
  validateRollCloseLeg,
  type PositionForCard,
} from "./confirmationText.js";

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

  it("accepts a close of exactly the open legs, and the card sells only the shares", () => {
    expect(validateCloseLegs(aaoi, [{ legId: "stock-leg" }])).toBeNull();
    expect(buildCloseCard(aaoi, [{ legId: "stock-leg", limitPrice: 105.17 }])).toBe(
      "Close AAOI (unstructured)\n• SELL 100 shares, limit 105.17\nOne combo order, sent to IBKR immediately when you tap Yes.",
    );
  });

  it("refuses to close an already-closed position", () => {
    expect(validateCloseLegs({ ...aaoi, status: "closed" }, [{ legId: "stock-leg" }])).toContain("already closed");
  });

  it("buys back a short option and sells a long stock leg in a covered-call close", () => {
    const coveredCall: PositionForCard = {
      symbol: "SPCX",
      strategyKey: "covered_call",
      status: "open",
      legs: [
        { id: "c", legType: "option", side: "short", quantity: 2, optionType: "call", strikePrice: 152.5, expiryDate: "2026-09-25", exitAt: null },
        { id: "s", legType: "stock", side: "long", quantity: 200, optionType: null, strikePrice: null, expiryDate: null, exitAt: null },
      ],
    };
    const card = buildCloseCard(coveredCall, [{ legId: "c", limitPrice: 0.5 }, { legId: "s", limitPrice: 151 }]);
    expect(card).toContain("• BUY BACK 2 call $152.5 exp 2026-09-25, limit 0.50");
    expect(card).toContain("• SELL 200 shares, limit 151.00");
  });
});

describe("roll", () => {
  it("rejects rolling a leg that is already closed", () => {
    expect(validateRollCloseLeg(aaoi, "call-leg")).toContain("not an open leg");
    expect(validateRollCloseLeg(aaoi, "nope")).toContain("not an open leg");
  });

  it("builds a readable roll card with a compact-format expiry converted to ISO", () => {
    const open: PositionForCard = {
      ...aaoi,
      legs: [{ id: "call-leg", legType: "option", side: "short", quantity: 1, optionType: "call", strikePrice: 110, expiryDate: "2026-09-18", exitAt: null }],
    };
    const card = buildRollCard(open, "call-leg", 0.3, { strikePrice: 115, expiryDate: "20260925", quantity: 1, limitPrice: 1.2 });
    expect(card).toContain("• BUY BACK 1 call $110 exp 2026-09-18, limit 0.30");
    expect(card).toContain("• SELL 1 call $115 exp 2026-09-25, limit 1.20");
  });
});

describe("other cards", () => {
  it("names the alert being rejected, falling back to the id when it can't be found", () => {
    expect(buildRejectAlertCard({ symbol: "MU", strategyKey: "cash_secured_put", alertType: "new_trade" }, "x")).toBe("Reject pending new-trade alert: MU (cash-secured put)");
    expect(buildRejectAlertCard(undefined, "abc")).toBe("Reject trade alert abc");
  });

  it("lists every risk setting instead of '5 other fields'", () => {
    const card = buildRiskLimitsCard({ strategyKey: "cash_secured_put", delta_target_min: 0.2, delta_target_max: 0.3, dte_target_min: 20, dte_target_max: 45, max_position_pct_of_portfolio: 10, max_aggregate_collateral_pct: 60, max_concentration_per_ticker_pct: 15, max_concentration_per_sector_pct: 30, min_cash_reserve_pct: 20 });
    expect(card).toContain("• Min cash reserve %: 20");
    expect(card.split("\n")).toHaveLength(10);
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
