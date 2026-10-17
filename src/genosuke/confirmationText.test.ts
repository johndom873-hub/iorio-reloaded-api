import { describe, expect, it } from "vitest";
import { annotateLegOpenState } from "./confirmationText.js";

// Mirrors the real staging AAOI position: the 110 call expired (leg closed), 100 shares still open.
const aaoi = {
  symbol: "AAOI",
  strategyKey: "unstructured",
  status: "open",
  legs: [
    { id: "call-leg", legType: "option", side: "short", quantity: 1, optionType: "call", strikePrice: 110, expiryDate: "2026-09-18", exitAt: "2026-09-19T02:32:37Z" },
    { id: "stock-leg", legType: "stock", side: "long", quantity: 100, optionType: null, strikePrice: null, expiryDate: null, exitAt: null },
  ],
};

describe("annotateLegOpenState", () => {
  it("marks each leg open or closed, in lists and single positions, and leaves other values alone", () => {
    const [annotated] = annotateLegOpenState([aaoi]);
    expect(annotated!.legs.map((leg) => (leg as { isOpen?: boolean }).isOpen)).toEqual([false, true]);
    expect(annotateLegOpenState(aaoi).legs.map((leg) => (leg as { isOpen?: boolean }).isOpen)).toEqual([false, true]);
    expect(annotateLegOpenState({ hello: 1 })).toEqual({ hello: 1 });
  });
});
