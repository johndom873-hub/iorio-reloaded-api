import { describe, expect, it } from "vitest";
import { describeTradeLine, toIsoExpiry } from "./tradeMessageFormatting.js";
import { formatSignedPercent } from "./formatSignedPercent.js";

describe("toIsoExpiry", () => {
  it("turns IBKR's YYYYMMDD and a full ISO timestamp into a date, and leaves a date alone", () => {
    expect(toIsoExpiry("20261017")).toBe("2026-10-17");
    expect(toIsoExpiry("2026-10-02T00:00:00.000Z")).toBe("2026-10-02");
    expect(toIsoExpiry("2026-10-17")).toBe("2026-10-17");
  });
});

describe("describeTradeLine", () => {
  it("describes an option or stock trade with a two-decimal price, or says the price is unknown", () => {
    expect(describeTradeLine("sell", { legType: "option", quantity: 1, optionType: "put", strikePrice: 42.5, expiryDate: "20261009" }, 0.6, "2026-10-07")).toBe("• Sell $42.5 Put · 9 Oct (2DTE) · 1× @ 0.60");
    expect(describeTradeLine("BUY", { legType: "stock", quantity: 100, optionType: null, strikePrice: null, expiryDate: null }, null, "2026-10-07")).toBe("• Buy 100 shares (price unknown)");
  });
});

describe("formatSignedPercent", () => {
  it("signs a percentage like formatSignedDollars, never a negative zero", () => {
    expect(formatSignedPercent(0.472, 2)).toBe("+0.47%");
    expect(formatSignedPercent(-1.25, 2)).toBe("−1.25%");
    expect(formatSignedPercent(-0.001, 2)).toBe("0.00%");
  });
});
