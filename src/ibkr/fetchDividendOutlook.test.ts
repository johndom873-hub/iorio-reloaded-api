import { describe, expect, it } from "vitest";
import { parseIbDividendsTick } from "./fetchDividendOutlook.js";

describe("parseIbDividendsTick", () => {
  it("reads IBKR's past, next, date and amount", () => {
    expect(parseIbDividendsTick("3.89138,3.9015,20261102,0.325125")).toEqual({ pastTwelveMonths: 3.89138, nextTwelveMonths: 3.9015, nextDate: "2026-11-02", nextAmount: 0.325125 });
  });

  it("leaves an empty or malformed field null", () => {
    expect(parseIbDividendsTick("0,0,,")).toEqual({ pastTwelveMonths: 0, nextTwelveMonths: 0, nextDate: null, nextAmount: null });
    expect(parseIbDividendsTick("x,1.1,2026110,")).toEqual({ pastTwelveMonths: null, nextTwelveMonths: 1.1, nextDate: null, nextAmount: null });
    expect(parseIbDividendsTick("")).toEqual({ pastTwelveMonths: null, nextTwelveMonths: null, nextDate: null, nextAmount: null });
  });
});
