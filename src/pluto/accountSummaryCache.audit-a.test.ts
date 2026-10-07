import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "../ibkr/fetchAccountSummary.js";
import { accountSummaryCacheMs, fetchPlutoAccountSummary, resetPlutoAccountSummaryCacheForTests } from "./accountSummaryCache.js";

// Audit (area A, 2026-10-07): the 60 s account-summary cache.

const summary = (netLiquidationValue: number | null): AccountSummary => ({ netLiquidationValue, buyingPower: null, totalCashValue: 700_000, grossPositionValue: null, excessLiquidity: null });

beforeEach(() => {
  resetPlutoAccountSummaryCacheForTests();
});

describe("fetchPlutoAccountSummary (audit A)", () => {
  it("concurrent callers share one failing request, and the next call asks again", async () => {
    let rejectFetch: (error: Error) => void = () => {};
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<AccountSummary>((_resolve, reject) => (rejectFetch = reject))).mockResolvedValueOnce(summary(1_000_000));
    const first = fetchPlutoAccountSummary(Date.now(), fetch);
    const second = fetchPlutoAccountSummary(Date.now(), fetch);
    rejectFetch(new Error("Account summary timeout."));
    await expect(first).rejects.toThrow("timeout");
    await expect(second).rejects.toThrow("timeout");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await fetchPlutoAccountSummary(Date.now(), fetch)).netLiquidationValue).toBe(1_000_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a fetch that throws synchronously is a rejection, not a stuck in-flight request", async () => {
    const fetch = vi.fn().mockImplementationOnce(() => {
      throw new Error("not connected");
    }).mockResolvedValueOnce(summary(1));
    await expect(fetchPlutoAccountSummary(Date.now(), fetch)).rejects.toThrow("not connected");
    expect((await fetchPlutoAccountSummary(Date.now(), fetch)).netLiquidationValue).toBe(1);
  });

  it("documents: a successful summary with no NLV (IBKR sent no tag) is cached like any other for the full minute", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(summary(null)).mockResolvedValueOnce(summary(1_000_000));
    const now = Date.now();
    expect((await fetchPlutoAccountSummary(now, fetch)).netLiquidationValue).toBeNull();
    expect((await fetchPlutoAccountSummary(now + accountSummaryCacheMs - 1_000, fetch)).netLiquidationValue).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the cache age is measured from when the answer arrived, not when it was asked for", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const fetch = vi.fn().mockImplementation(() => new Promise<AccountSummary>((resolve) => setTimeout(() => resolve(summary(1)), 20_000)));
      const pending = fetchPlutoAccountSummary(Date.now(), fetch);
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
      // 70 s after asking, 50 s after the answer: still cached.
      expect((await fetchPlutoAccountSummary(1_000_000 + 70_000, fetch)).netLiquidationValue).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
