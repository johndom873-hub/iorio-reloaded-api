import { describe, expect, it } from "vitest";
import { optionLimitPriceGivingUpOneCent, optionMidLimitPrice, roundOptionPriceToCent } from "./optionLimitPrice.js";

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

describe("optionLimitPriceGivingUpOneCent", () => {
  it("gives up one cent past the rounded mid", () => {
    expect(optionLimitPriceGivingUpOneCent(1.49, 1.52, "sell")).toBe(1.5);
    expect(optionLimitPriceGivingUpOneCent(1.49, 1.52, "buy")).toBe(1.51);
    expect(optionLimitPriceGivingUpOneCent(2.81, 3.15, "sell")).toBe(2.97);
    expect(optionLimitPriceGivingUpOneCent(2.81, 3.15, "buy")).toBe(2.99);
  });

  it("stops at the bid for a sell and at the ask for a buy", () => {
    expect(optionLimitPriceGivingUpOneCent(0.67, 0.68, "sell")).toBe(0.67);
    expect(optionLimitPriceGivingUpOneCent(1.49, 1.51, "sell")).toBe(1.49);
    expect(optionLimitPriceGivingUpOneCent(0.67, 0.68, "buy")).toBe(0.68);
    expect(optionLimitPriceGivingUpOneCent(1.0, 1.0, "sell")).toBe(1.0);
  });
});
