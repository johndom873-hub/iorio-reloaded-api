import { describe, expect, it, vi } from "vitest";
import type { PriceBar } from "./fetchTickerOverview.js";
import { describePriceAdjustment, detectPriceAdjustment, storeDailyBarsCheckingForSplit, type DailyBarStoreDependencies, type StoredBarPrices } from "./dailyBarSplitCheck.js";

const timeOf = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 1000;
const freshBar = (isoDate: string, close: number): PriceBar => ({ time: timeOf(isoDate), open: close * 0.99, high: close * 1.02, low: close * 0.97, close, volume: 1_000_000 });
const storedFrom = (bar: PriceBar, factor = 1): StoredBarPrices => ({ tradingDate: new Date(bar.time * 1000).toISOString().slice(0, 10), open: bar.open * factor, high: bar.high * factor, low: bar.low * factor, close: bar.close * factor });

describe("detectPriceAdjustment", () => {
  const monday = freshBar("2026-10-05", 50);
  const tuesday = freshBar("2026-10-06", 51);

  it("finds a 2-for-1 split: every price of a shared day stored at twice IBKR's", () => {
    expect(detectPriceAdjustment([storedFrom(monday, 2)], [monday, tuesday])).toEqual({ ratio: 2, adjustedDates: ["2026-10-05"] });
  });
  it("finds a 1-for-10 reverse split", () => {
    expect(detectPriceAdjustment([storedFrom(monday, 0.1)], [monday, tuesday])!.ratio).toBeCloseTo(0.1, 10);
  });
  it("sees nothing when the stored day matches IBKR's, or there is no shared day", () => {
    expect(detectPriceAdjustment([storedFrom(monday)], [monday, tuesday])).toBeNull();
    expect(detectPriceAdjustment([], [monday, tuesday])).toBeNull();
  });
  it("ignores a correction of one price (a revised close) and today's still-forming bar", () => {
    expect(detectPriceAdjustment([{ ...storedFrom(monday), close: monday.close * 1.03 }], [monday])).toBeNull();
    expect(detectPriceAdjustment([{ ...storedFrom(monday), high: monday.high * 0.95, low: monday.low * 1.02, close: monday.close * 0.98 }], [monday])).toBeNull();
  });
  it("ignores differences within 0.5%", () => {
    expect(detectPriceAdjustment([storedFrom(monday, 1.004)], [monday])).toBeNull();
    expect(detectPriceAdjustment([storedFrom(monday, 1.006)], [monday])!.ratio).toBeCloseTo(1.006, 10);
  });
  it("only shared days that moved count: days stored after the split agree with IBKR", () => {
    expect(detectPriceAdjustment([storedFrom(monday, 3), storedFrom(tuesday)], [monday, tuesday])).toEqual({ ratio: 3, adjustedDates: ["2026-10-05"] });
  });
});

describe("describePriceAdjustment", () => {
  it("names whole-number splits and falls back to the factor", () => {
    expect(describePriceAdjustment(2)).toBe("2-for-1 split");
    expect(describePriceAdjustment(10.04)).toBe("10-for-1 split");
    expect(describePriceAdjustment(0.1)).toBe("1-for-10 reverse split");
    expect(describePriceAdjustment(1.5)).toBe("price adjustment of 1.500×");
  });
});

describe("storeDailyBarsCheckingForSplit", () => {
  const bars = [freshBar("2026-10-05", 50), freshBar("2026-10-06", 51)];
  const fullHistory = { bars: [freshBar("2021-10-06", 20), ...bars], ivByDate: new Map([["2026-10-06", 0.6]]) };

  function dependencies(stored: StoredBarPrices[], history = fullHistory, options: { newestStoredDate?: string | null; window?: PriceBar[] } = {}): DailyBarStoreDependencies & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      loadStoredPrices: vi.fn(async (_tickerId: string, dates: string[]) => stored.filter((bar) => dates.includes(bar.tradingDate))),
      loadNewestStoredDate: vi.fn(async () => options.newestStoredDate ?? null),
      fetchSince: vi.fn(async () => (calls.push("fetchSince"), { bars: options.window ?? [], ivByDate: new Map() })),
      upsertBars: vi.fn(async () => void calls.push("upsert")),
      fetchFullHistory: vi.fn(async () => (calls.push("fetchFull"), history)),
      replaceHistory: vi.fn(async () => (calls.push("replace"), { removedEarlierDays: 0 })),
      notify: vi.fn(async (message: string) => void calls.push(`notify:${message}`)),
    };
  }

  it("writes the fresh bars as they are when nothing moved", async () => {
    const deps = dependencies([storedFrom(bars[0]!)]);
    const result = await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map() }, deps);
    expect(result).toEqual({ adjustment: null, replacedDays: 0 });
    expect(deps.calls).toEqual(["upsert"]);
  });

  it("on a split, replaces the whole history from a fresh fetch instead of writing the short window, and says so", async () => {
    const deps = dependencies([storedFrom(bars[0]!, 2)]);
    const result = await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map() }, deps);
    expect(result.replacedDays).toBe(3);
    expect(deps.calls.slice(0, 2)).toEqual(["fetchFull", "replace"]);
    expect(deps.upsertBars).not.toHaveBeenCalled();
    expect(deps.calls[2]).toBe("notify:ℹ️ SMCI (staging): 2-for-1 split detected (stored prices 2.000× IBKR's on 2026-10-05). The price history was fetched again from IBKR and replaced: 3 days.");
  });

  it("writes nothing and fails when the re-fetch returns no bars, so the two price bases never mix", async () => {
    const deps = dependencies([storedFrom(bars[0]!, 2)], { bars: [], ivByDate: new Map() });
    await expect(storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map() }, deps)).rejects.toThrow("2-for-1 split detected");
    expect(deps.upsertBars).not.toHaveBeenCalled();
    expect(deps.replaceHistory).not.toHaveBeenCalled();
    expect(deps.calls.at(-1)).toMatch(/^notify:⚠️ SMCI \(staging\)/);
  });

  it("with no shared day (a missed night), fetches back to the newest stored day, compares there and fills the gap", async () => {
    const friday = freshBar("2026-10-02", 49);
    const deps = dependencies([storedFrom(friday, 2)], fullHistory, { newestStoredDate: "2026-10-02", window: [friday, freshBar("2026-10-03", 49.5)] });
    const result = await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map() }, deps);
    expect(deps.fetchSince).toHaveBeenCalledWith("2026-10-02");
    expect(result.adjustment).toEqual({ ratio: 2, adjustedDates: ["2026-10-02"] });
    expect(deps.calls.slice(0, 3)).toEqual(["fetchSince", "fetchFull", "replace"]);
  });

  it("the gap-filling window is written with the fresh bars when nothing moved", async () => {
    const friday = freshBar("2026-10-02", 49);
    const deps = dependencies([storedFrom(friday)], fullHistory, { newestStoredDate: "2026-10-02", window: [friday, freshBar("2026-10-03", 49.5)] });
    await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map([["2026-10-06", 0.6]]) }, deps);
    const written = vi.mocked(deps.upsertBars).mock.calls[0]![1];
    expect(written.bars.map((bar) => new Date(bar.time * 1000).toISOString().slice(0, 10))).toEqual(["2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"]);
    expect(written.ivByDate.get("2026-10-06")).toBe(0.6);
  });

  it("a ticker with no stored bars is written without a window fetch", async () => {
    const deps = dependencies([], fullHistory, { newestStoredDate: null });
    await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars, ivByDate: new Map() }, deps);
    expect(deps.fetchSince).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(["upsert"]);
  });

  it("does nothing for an empty fetch", async () => {
    const deps = dependencies([]);
    expect(await storeDailyBarsCheckingForSplit({ tickerId: "t", symbol: "SMCI", environment: "staging", bars: [], ivByDate: new Map() }, deps)).toEqual({ adjustment: null, replacedDays: 0 });
    expect(deps.loadStoredPrices).not.toHaveBeenCalled();
  });
});
