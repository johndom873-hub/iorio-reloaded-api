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
    expect(describeTradeContract({ legType: "option", quantity: 2, optionType: "call", strikePrice: 182.5, expiryDate: "20311017" })).toBe("2 call $182.5 exp 2031-10-17");
    expect(formatTradePrice(1)).toBe("1.00");
    expect(formatTradePrice(0.125)).toBe("0.13");
  });

  it("a stock line ignores option fields, and a null price reads 'price unknown'", () => {
    expect(describeTradeLine("sell", { legType: "stock", quantity: 100, optionType: null, strikePrice: null, expiryDate: null }, null)).toBe("• SELL 100 shares price unknown");
  });

  it("an option line with no expiry shows '?'", () => {
    expect(describeTradeLine("buy", { legType: "option", quantity: 1, optionType: "put", strikePrice: 50, expiryDate: null }, 0.4)).toBe("• BUY 1 put $50 exp ? at 0.40");
  });
});
