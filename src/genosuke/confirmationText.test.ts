import { describe, expect, it } from "vitest";
import {
  annotateLegOpenState,
  buildCloseCard,
  buildRiskLimitsCard,
  toIsoExpiry,
  validateCloseLegs,
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

describe("other cards", () => {
  it("shows only the settings being changed, each as old to new", () => {
    const card = buildRiskLimitsCard({ minCashReservePct: 8, deltaTargetMax: 0.35 }, { minCashReservePct: 5, deltaTargetMax: 0.4, deltaTargetMin: 0.2 });
    expect(card.split("\n")).toEqual(["Update the trading limits", "• Min cash reserve %: 5 → 8", "• Delta band max: 0.4 → 0.35"]);
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
