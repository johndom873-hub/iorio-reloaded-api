import { describe, expect, it } from "vitest";
import { classifyRejectedSymbol } from "./screenerDelistings.js";

describe("classifyRejectedSymbol", () => {
  it("is delisted when the contract id still resolves to the stored symbol, on the VALUE exchange", () => {
    expect(classifyRejectedSymbol("WBD", { symbol: "WBD", primaryExchange: "VALUE" })).toEqual({ kind: "delisted" });
  });

  it("is a rename when the contract id resolves to another symbol, whatever the exchange", () => {
    expect(classifyRejectedSymbol("PSKY", { symbol: "SKYD", primaryExchange: "NYSE" })).toEqual({ kind: "renamed", newSymbol: "SKYD" });
    expect(classifyRejectedSymbol("OLD", { symbol: "NEW", primaryExchange: "VALUE" })).toEqual({ kind: "renamed", newSymbol: "NEW" });
  });

  it("is unexplained when the stored symbol is still on a real exchange (e.g. an ambiguous contract)", () => {
    expect(classifyRejectedSymbol("ABC", { symbol: "ABC", primaryExchange: "NYSE" })).toEqual({ kind: "unexplained" });
    expect(classifyRejectedSymbol("ABC", { symbol: "ABC", primaryExchange: null })).toEqual({ kind: "unexplained" });
  });

  it("is unexplained when IBKR has nothing for the contract id", () => {
    expect(classifyRejectedSymbol("ABC", null)).toEqual({ kind: "unexplained" });
  });
});
