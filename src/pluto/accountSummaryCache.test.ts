import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "../ibkr/fetchAccountSummary.js";
import { accountSummaryCacheMs, fetchPlutoAccountSummary, resetPlutoAccountSummaryCacheForTests } from "./accountSummaryCache.js";

const summary = (netLiquidationValue: number): AccountSummary => ({ netLiquidationValue, buyingPower: null, totalCashValue: 700_000, grossPositionValue: null, excessLiquidity: null });

beforeEach(() => {
  resetPlutoAccountSummaryCacheForTests();
});

describe("fetchPlutoAccountSummary", () => {
  it("asks IBKR once per minute, and once for concurrent callers", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(summary(1_000_000)).mockResolvedValueOnce(summary(1_010_000));
    const now = Date.now();
    const [first, second] = await Promise.all([fetchPlutoAccountSummary(now, fetch), fetchPlutoAccountSummary(now, fetch)]);
    expect(first.netLiquidationValue).toBe(1_000_000);
    expect(second.netLiquidationValue).toBe(1_000_000);
    expect((await fetchPlutoAccountSummary(now + accountSummaryCacheMs - 1_000, fetch)).netLiquidationValue).toBe(1_000_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await fetchPlutoAccountSummary(now + accountSummaryCacheMs + 1_000, fetch)).netLiquidationValue).toBe(1_010_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Account summary timeout.")).mockResolvedValueOnce(summary(1_000_000));
    await expect(fetchPlutoAccountSummary(Date.now(), fetch)).rejects.toThrow("timeout");
    expect((await fetchPlutoAccountSummary(Date.now(), fetch)).netLiquidationValue).toBe(1_000_000);
  });
});
