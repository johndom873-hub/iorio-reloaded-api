import { describe, expect, it } from "vitest";
import { optionMidLimitPrice, roundOptionPriceToCent } from "./optionLimitPrice.js";

describe("roundOptionPriceToCent", () => {
  it("rounds a sell up and a buy down to the cent, so neither gives up anything past the mid", () => {
    expect(roundOptionPriceToCent(0.425, "sell")).toBe(0.43);
    expect(roundOptionPriceToCent(0.425, "buy")).toBe(0.42);
    // At or above $3.00 too: any cent, no $0.05 step.
    expect(roundOptionPriceToCent(3.215, "sell")).toBe(3.22);
    expect(roundOptionPriceToCent(3.215, "buy")).toBe(3.21);
  });

  it("keeps a price already on the cent", () => {
    expect(roundOptionPriceToCent(1.15, "sell")).toBe(1.15);
    expect(roundOptionPriceToCent(1.15, "buy")).toBe(1.15);
    expect(roundOptionPriceToCent(3.02, "sell")).toBe(3.02);
  });
});

describe("optionMidLimitPrice", () => {
  it("keeps the rounded mid inside the bid and ask", () => {
    expect(optionMidLimitPrice(1.2, 1.25, "sell")).toBe(1.23);
    expect(optionMidLimitPrice(1.2, 1.25, "buy")).toBe(1.22);
    expect(optionMidLimitPrice(3.2, 3.23, "sell")).toBe(3.22);
    expect(optionMidLimitPrice(1.1, 1.2, "sell")).toBe(1.15);
    expect(optionMidLimitPrice(0.01, 0.02, "buy")).toBe(0.01);
  });
});
