import { describe, expect, it } from "vitest";
import { classifyFreshness, percentChange } from "./pricePerformanceSnapshot.js";

describe("percentChange (the formula the browser now applies to live prices)", () => {
  it("is (current - reference) / reference * 100", () => {
    expect(percentChange(110, 100)).toBeCloseTo(10);
    expect(percentChange(90, 100)).toBeCloseTo(-10);
    expect(percentChange(100, 100)).toBe(0);
  });
  it("is null with no reference or a zero reference", () => {
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(100, 0)).toBeNull();
  });
});

describe("classifyFreshness", () => {
  const latest = { AAPL: "2026-09-18", MSFT: "2026-09-17", NVDA: "2026-09-18", TSLA: "2026-09-10" };

  it("a ticker is behind when its latest completed bar predates the expected session", () => {
    expect(classifyFreshness(latest, "2026-09-18").behindSymbols).toEqual(["MSFT", "TSLA"]);
  });

  it("nothing is behind when every ticker has the expected session", () => {
    expect(classifyFreshness({ A: "2026-09-18", B: "2026-09-18" }, "2026-09-18")).toEqual({ behindSymbols: [] });
  });

  it("just after the close the nightly job still has its window: not 'behind' yet", () => {
    expect(classifyFreshness({ A: "2026-09-17", B: "2026-09-17" }, "2026-09-17")).toEqual({ behindSymbols: [] });
  });

  it("is empty for no tickers", () => {
    expect(classifyFreshness({}, "2026-09-18")).toEqual({ behindSymbols: [] });
  });
});
