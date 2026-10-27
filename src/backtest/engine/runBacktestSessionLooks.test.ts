import { describe, expect, it } from "vitest";
import { lookGridTimesEt, lookTimesInWindow } from "./runBacktestSession.js";

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
