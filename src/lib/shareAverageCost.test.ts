import { describe, expect, it } from "vitest";
import { runningAverageShareCost } from "./shareAverageCost.js";

describe("runningAverageShareCost", () => {
  it("blends acquisitions, ignores shares leaving, and starts afresh once none are held", () => {
    expect(runningAverageShareCost([])).toBeNull();
    expect(runningAverageShareCost([{ shares: 100, price: 50 }, { shares: 100, price: 40 }])).toBe(45);
    expect(runningAverageShareCost([{ shares: 100, price: 50 }, { shares: 100, price: 40 }, { shares: -100, price: 60 }])).toBe(45);
    expect(runningAverageShareCost([{ shares: 100, price: 50 }, { shares: 100, price: 40 }, { shares: -100, price: 60 }, { shares: 200, price: 30 }])).toBe(35);
    expect(runningAverageShareCost([{ shares: 100, price: 50 }, { shares: -100, price: 55 }])).toBeNull();
    expect(runningAverageShareCost([{ shares: 100, price: 50 }, { shares: -100, price: 55 }, { shares: 100, price: 20 }])).toBe(20);
  });
});
