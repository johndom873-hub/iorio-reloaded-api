import { describe, expect, it } from "vitest";
import { firstTwoSidedMids, markKey, markMidByContract } from "./backtestOptionMarks.js";

const quote = (strike: number, right: "C" | "P", bid: number | null, ask: number | null) => ({ expiry: "2020-03-20", strike, right, bid, ask });

describe("markMidByContract", () => {
  it("marks two-sided quotes at their mid and leaves out a quote with no bid, as NOK's $4.5 call quoted 0 / 5.80 on 9 Mar 2020", () => {
    const marks = markMidByContract([quote(4.5, "C", 0, 5.8), quote(4, "C", 0.1, 0.12), quote(4, "P", null, 0.3), quote(3.5, "P", 0.02, 0.01), quote(5, "C", 0.05, 0.07)], new Set([4, 4.5, 3.5]));
    expect([...marks]).toEqual([[markKey("2020-03-20", 4, "C"), 0.11]]);
  });
});

describe("firstTwoSidedMids", () => {
  it("takes each contract's first two-sided quote across the day's quote sets, in order, and leaves out one never quoted two-sided", () => {
    const contracts = [{ expiry: "2020-03-20", strike: 4.5, right: "C" as const }, { expiry: "2020-03-20", strike: 4, right: "P" as const }, { expiry: "2020-03-20", strike: 5, right: "C" as const }];
    const tenThirty = [quote(4.5, "C", 0, 5.8), quote(4, "P", 0.2, 0.24)];
    const eleven = [quote(4.5, "C", 0.02, 0.06), quote(4, "P", 0.3, 0.34)];
    const close = [quote(4.5, "C", 0.01, 0.03), quote(5, "C", 0, 0.05)];
    const marks = firstTwoSidedMids([tenThirty, eleven, close], contracts);
    expect(marks.get(markKey("2020-03-20", 4.5, "C"))).toBeCloseTo(0.04, 10);
    expect(marks.get(markKey("2020-03-20", 4, "P"))).toBeCloseTo(0.22, 10);
    expect(marks.has(markKey("2020-03-20", 5, "C"))).toBe(false);
    expect(firstTwoSidedMids([], contracts).size).toBe(0);
  });
});
