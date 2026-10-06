import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlutoSettings } from "./settingsStore.js";

const harness = vi.hoisted(() => ({
  linesEnabled: true,
  subscribed: [] as string[],
  unsubscribed: [] as string[],
}));

vi.mock("../config/env.js", () => ({ ibkrMarketDataLinesEnabled: () => harness.linesEnabled }));
vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: async (contract: { key: string }) => {
    harness.subscribed.push(contract.key);
    return () => harness.unsubscribed.push(contract.key);
  },
}));

const { PlutoMarketWatch } = await import("./marketWatch.js");

const settings = { burstLines: 10, burstSettleSeconds: 4 } as PlutoSettings;

beforeEach(() => {
  harness.linesEnabled = true;
  harness.subscribed.length = 0;
  harness.unsubscribed.length = 0;
});

describe("PlutoMarketWatch.watch", () => {
  it("subscribes one stock line per ticker plus SPY and books no burst lines up front", async () => {
    const watch = new PlutoMarketWatch(settings);
    const result = await watch.watch(["COIN", "HOOD"]);
    expect(result).toEqual({ ok: true, detail: "3 stock lines; a quote burst adds up to 10 more for 4 s" });
    expect(harness.subscribed).toEqual(["pluto-stock-COIN", "pluto-stock-HOOD", "pluto-stock-SPY"]);
  });

  it("drops tickers that left the list and keeps the rest subscribed once", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["COIN", "HOOD"]);
    await watch.watch(["HOOD"]);
    expect(harness.unsubscribed).toEqual(["pluto-stock-COIN"]);
    expect(harness.subscribed).toEqual(["pluto-stock-COIN", "pluto-stock-HOOD", "pluto-stock-SPY"]);
  });

  it("refuses and holds nothing when market-data lines are disabled in the environment", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["COIN"]);
    harness.linesEnabled = false;
    const result = await watch.watch(["COIN"]);
    expect(result.ok).toBe(false);
    expect(harness.unsubscribed).toEqual(["pluto-stock-COIN", "pluto-stock-SPY"]);
  });
});

describe("PlutoMarketWatch.burst", () => {
  it("subscribes at most burstLines contracts for the settle time, then lets them go", async () => {
    vi.useFakeTimers();
    try {
      const watch = new PlutoMarketWatch({ burstLines: 2, burstSettleSeconds: 4 } as PlutoSettings);
      const contracts = [100, 105, 110].map((strike) => ({ expiry: "2026-10-16", strike, right: "P" as const }));
      const burst = watch.burst("COIN", contracts);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.subscribed).toHaveLength(2);
      expect(harness.unsubscribed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_000);
      await burst;
      expect(harness.unsubscribed).toEqual(harness.subscribed);
    } finally {
      vi.useRealTimers();
    }
  });
});
