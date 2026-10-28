import { describe, expect, it } from "vitest";
import { isZeroQuoteSnapshot, lookGridTimesEt, lookTimesInWindow, summarizeDayLooks, type DayLookSummary } from "./runBacktestSession.js";

describe("the looks of a day", () => {
  it("are the half hours from the window's start through its end, never later than 30 minutes before the close", () => {
    expect(lookTimesInWindow("10:00", "15:30", 16 * 60)).toEqual(lookGridTimesEt);
    // A 13:00 close pulls the end in to 12:30: the quotes stored for later times repeat the close and are never read.
    expect(lookTimesInWindow("10:00", "15:30", 13 * 60)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
    expect(lookTimesInWindow("10:45", "12:00", 16 * 60)).toEqual(["11:00", "11:30", "12:00"]);
    expect(lookTimesInWindow("09:30", "16:00", 16 * 60)).toEqual(lookGridTimesEt);
    expect(lookTimesInWindow("15:45", "15:50", 16 * 60)).toEqual([]);
  });
});

describe("the day's summary of its looks", () => {
  const looks: DayLookSummary[] = [
    { lookTimeEt: "10:00", summary: "SLV: first position: no Call at or above its break-even 31.20", filledCount: 0, refusedCount: 0, opensStopped: [] },
    { lookTimeEt: "10:30", summary: "No action", filledCount: 0, refusedCount: 0, opensStopped: [] },
    { lookTimeEt: "11:00", summary: "NVDA: Sell $150 Call · 7 Nov (10DTE) · 3× @ 1.20", filledCount: 1, refusedCount: 0, opensStopped: [] },
  ];

  it("drops a first look that did nothing once a later look filled an order", () => {
    expect(summarizeDayLooks(looks)).toEqual(["11:00 NVDA: Sell $150 Call · 7 Nov (10DTE) · 3× @ 1.20", "no action at the other 2 looks"]);
  });

  it("keeps Vol Farmer v2's first look when it noted something, why a position sold no Call", () => {
    expect(summarizeDayLooks(looks, true)).toEqual(["10:00 SLV: first position: no Call at or above its break-even 31.20", "11:00 NVDA: Sell $150 Call · 7 Nov (10DTE) · 3× @ 1.20", "no action at the other 1 look"]);
    const quietFirstLook = [{ ...looks[0]!, summary: "No action" }, ...looks.slice(1)];
    expect(summarizeDayLooks(quietFirstLook, true)).toEqual(["11:00 NVDA: Sell $150 Call · 7 Nov (10DTE) · 3× @ 1.20", "no action at the other 2 looks"]);
  });
});

describe("a snapshot of zeros", () => {
  it("is quotes none of which has an ask above 0", () => {
    const quote = (ask: number | null) => ({ ask });
    expect(isZeroQuoteSnapshot([quote(0), quote(null), quote(0)])).toBe(true);
    expect(isZeroQuoteSnapshot([quote(0), quote(0.05)])).toBe(false);
    // No quotes at all is no snapshot: nothing listed, not missing data.
    expect(isZeroQuoteSnapshot([])).toBe(false);
  });
});
