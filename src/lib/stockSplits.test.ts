import { describe, expect, it } from "vitest";
import { splitSuggestedByPrice } from "./stockSplits.js";

describe("splitSuggestedByPrice", () => {
  it("names the split a price move matches within 5%: about ½ for a 2-for-1, ×10 for a 1-for-10 reverse", () => {
    expect(splitSuggestedByPrice(50.4, 100)).toBe(2);
    expect(splitSuggestedByPrice(33.5, 100)).toBe(3);
    expect(splitSuggestedByPrice(66.9, 100)).toBe(1.5);
    expect(splitSuggestedByPrice(1_000, 100)).toBeCloseTo(0.1, 12);
    expect(splitSuggestedByPrice(205, 100)).toBe(0.5);
  });

  it("ignores ordinary moves, a 20–25% day included, and missing prices", () => {
    expect(splitSuggestedByPrice(92, 100)).toBeNull();
    expect(splitSuggestedByPrice(78, 100)).toBeNull();
    expect(splitSuggestedByPrice(56, 100)).toBeNull();
    expect(splitSuggestedByPrice(0, 100)).toBeNull();
    expect(splitSuggestedByPrice(50, 0)).toBeNull();
  });
});
