import { describe, expect, it } from "vitest";
import { splitSeenInHoldings } from "./ibkrGatewayFrozenTickers.js";
import { describeFrozenTickerAlert } from "../lib/frozenTickerAlert.js";

describe("splitSeenInHoldings", () => {
  it("reads shares × ratio with the cost ÷ ratio as a split, forward or reverse", () => {
    expect(splitSeenInHoldings({ shares: 300, averageCost: 100 }, { shares: 600, averageCost: 50.02 })).toBe(2);
    expect(splitSeenInHoldings({ shares: 1000, averageCost: 2 }, { shares: 100, averageCost: 20.1 })).toBe(0.1);
    expect(splitSeenInHoldings({ shares: 200, averageCost: 90 }, { shares: 300, averageCost: 60 })).toBe(1.5);
  });

  it("does not read a trade as a split", () => {
    expect(splitSeenInHoldings({ shares: 300, averageCost: 100 }, { shares: 600, averageCost: 75 })).toBeNull(); // 300 more bought at $50
    expect(splitSeenInHoldings({ shares: 300, averageCost: 100 }, { shares: 400, averageCost: 98 })).toBeNull();
    expect(splitSeenInHoldings({ shares: 300, averageCost: 100 }, { shares: 300, averageCost: 100 })).toBeNull();
  });
});

describe("describeFrozenTickerAlert", () => {
  it("names the split, the options about to expire and the prompt to paste, and tells production to hand the command over", () => {
    const text = describeFrozenTickerAlert({
      environment: "production",
      symbol: "SMCI",
      reason: "2-for-1 stock split effective 2026-12-01",
      split: { id: "abc", description: "2-for-1 stock split", effectiveDateIso: "2026-12-01" },
      expiringSoon: [{ optionType: "put", strike: 45, expiryDateIso: "2026-12-03", contracts: 6, daysToExpiry: 2 }],
    });
    expect(text).toContain("SMCI FROZEN: 2-for-1 stock split effective 2026-12-01");
    expect(text).toContain("• 6× SMCI $45 Put · 3 Dec (2DTE)");
    expect(text).toContain("npm run split:rewrite -- --env production --split abc");
    expect(text).toContain("--app iorio-reloaded-api");
    expect(text).toContain("hand me the command, don't run it yourself");
    expect(text).toContain("npm run ticker:unfreeze -- --env production --ticker SMCI");
  });
});
