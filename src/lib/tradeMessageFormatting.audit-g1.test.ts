import { describe, expect, it } from "vitest";
import { describeTradeContract, describeTradeLine, formatTradePrice, labelStrategy, toIsoExpiry } from "./tradeMessageFormatting.js";

// Audit (G1, 2026-10-07) of the shared trade-message pieces (pure).
describe("tradeMessageFormatting (audit)", () => {
  it("labels every strategy key and passes an unknown one through", () => {
    expect(["covered_call", "cash_secured_put", "hedge", "unstructured", "future_strategy"].map(labelStrategy)).toEqual([
      "covered call",
      "cash-secured put",
      "hedge",
      "unstructured",
      "future_strategy",
    ]);
  });

  it("toIsoExpiry keeps a plain date, converts YYYYMMDD and cuts a timestamp to its UTC date", () => {
    expect(toIsoExpiry("20311017")).toBe("2031-10-17");
    expect(toIsoExpiry("2031-10-17")).toBe("2031-10-17");
    expect(toIsoExpiry("2031-10-17T00:00:00.000Z")).toBe("2031-10-17");
    expect(toIsoExpiry("garbage")).toBe("garbage");
  });

  it("a fractional strike keeps its decimals; prices always have two", () => {
    expect(describeTradeContract({ legType: "option", quantity: 2, optionType: "call", strikePrice: 182.5, expiryDate: "20311017" }, "2031-10-07")).toBe("$182.5 Call · 17 Oct (10DTE) · 2×");
    expect(formatTradePrice(1)).toBe("1.00");
    expect(formatTradePrice(0.125)).toBe("0.13");
  });

  it("a stock line ignores option fields, and a null price reads 'price unknown'", () => {
    expect(describeTradeLine("sell", { legType: "stock", quantity: 100, optionType: null, strikePrice: null, expiryDate: null }, null, "2031-10-07")).toBe("• Sell 100 shares (price unknown)");
  });

  it("an expiry on today's date reads 0DTE; a passed expiry leaves the DTE out", () => {
    const contract = { legType: "option" as const, quantity: 1, optionType: "put" as const, strikePrice: 50, expiryDate: "2031-10-17" };
    expect(describeTradeContract(contract, "2031-10-17")).toBe("$50 Put · 17 Oct (0DTE) · 1×");
    expect(describeTradeContract(contract, "2031-10-18")).toBe("$50 Put · 17 Oct · 1×");
  });

  it("an option line with no expiry leaves the date out, and no strike shows '?'", () => {
    expect(describeTradeLine("buy", { legType: "option", quantity: 1, optionType: "put", strikePrice: 50, expiryDate: null }, 0.4, "2031-10-07")).toBe("• Buy $50 Put · 1× @ 0.40");
    expect(describeTradeLine("sell", { legType: "option", quantity: 1, optionType: "call", strikePrice: null, expiryDate: "2031-10-17" }, 0.4, "2031-10-07")).toBe("• Sell ? Call · 17 Oct · 1× @ 0.40");
  });
  it("an expiry that can't be read is shown as stored, never as NaN", () => {
    expect(describeTradeContract({ legType: "option", quantity: 1, optionType: "put", strikePrice: 5, expiryDate: "garbage" }, "2026-10-07")).toBe("$5 Put · garbage · 1×");
  });
});
