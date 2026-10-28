import { describe, expect, it } from "vitest";
import { firstTwoSidedQuotes, markKey, markOfTwoSidedQuote, twoSidedQuoteByContract } from "./backtestOptionMarks.js";

const quote = (strike: number, right: "C" | "P", bid: number | null, ask: number | null) => ({ expiry: "2020-03-20", strike, right, bid, ask });

describe("twoSidedQuoteByContract", () => {
  it("keeps two-sided quotes and leaves out a quote with no bid, as NOK's $4.5 call quoted 0 / 5.80 on 9 Mar 2020", () => {
    const quotes = twoSidedQuoteByContract([quote(4.5, "C", 0, 5.8), quote(4, "C", 0.1, 0.12), quote(4, "P", null, 0.3), quote(3.5, "P", 0.02, 0.01), quote(5, "C", 0.05, 0.07)], new Set([4, 4.5, 3.5]));
    expect([...quotes]).toEqual([[markKey("2020-03-20", 4, "C"), { bid: 0.1, ask: 0.12 }]]);
  });
});

describe("markOfTwoSidedQuote", () => {
  it("marks at the mid with no spread cost, and a LEAPS at the lab's 33% of the half-spread below the mid", () => {
    expect(markOfTwoSidedQuote({ bid: 0.1, ask: 0.12 }, 0)).toBeCloseTo(0.11, 10);
    expect(markOfTwoSidedQuote({ bid: 10, ask: 13 }, 0.33)).toBeCloseTo(11.005, 10);
  });
});

describe("firstTwoSidedQuotes", () => {
  it("takes each contract's first two-sided quote across the day's quote sets, in order, and leaves out one never quoted two-sided", () => {
    const contracts = [{ expiry: "2020-03-20", strike: 4.5, right: "C" as const }, { expiry: "2020-03-20", strike: 4, right: "P" as const }, { expiry: "2020-03-20", strike: 5, right: "C" as const }];
    const tenThirty = [quote(4.5, "C", 0, 5.8), quote(4, "P", 0.2, 0.24)];
    const eleven = [quote(4.5, "C", 0.02, 0.06), quote(4, "P", 0.3, 0.34)];
    const close = [quote(4.5, "C", 0.01, 0.03), quote(5, "C", 0, 0.05)];
    const quotes = firstTwoSidedQuotes([tenThirty, eleven, close], contracts);
    expect(quotes.get(markKey("2020-03-20", 4.5, "C"))).toEqual({ bid: 0.02, ask: 0.06 });
    expect(quotes.get(markKey("2020-03-20", 4, "P"))).toEqual({ bid: 0.2, ask: 0.24 });
    expect(quotes.has(markKey("2020-03-20", 5, "C"))).toBe(false);
    expect(firstTwoSidedQuotes([], contracts).size).toBe(0);
  });
});
