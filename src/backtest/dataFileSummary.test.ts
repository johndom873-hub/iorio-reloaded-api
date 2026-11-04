import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayNumberOf } from "./engine/symbolFileSlices.js";
import type { SymbolFileQuote } from "./engine/backtestSymbolFile.js";
import { writeSyntheticSymbolFile, type SyntheticSymbolFileDay } from "./engine/testSupport/syntheticBacktestData.js";
import { lastFullWeekMondays, medianOfWeeklyExpiryCounts, readBacktestDataFileExpiriesPerWeek } from "./dataFileSummary.js";

const isoOfDayNumber = (dayNumber: number) => new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);

describe("the weeks the Expiries column looks at", () => {
  // 2026-10-19 is a Monday.
  it("end with the week of the file's last day when that day is a Friday (or later in the week's end), else with the week before", () => {
    const monday = dayNumberOf("2026-10-19");
    expect(lastFullWeekMondays(dayNumberOf("2026-10-23"), 2)).toEqual([monday, monday - 7]);
    expect(lastFullWeekMondays(dayNumberOf("2026-10-24"), 1)).toEqual([monday]);
    expect(lastFullWeekMondays(dayNumberOf("2026-10-22"), 1)).toEqual([monday - 7]);
    expect(lastFullWeekMondays(dayNumberOf("2026-10-19"), 1)).toEqual([monday - 7]);
  });

  it("take the middle value of the weekly counts, the mean of the two middle ones when the number of weeks is even, none without a week", () => {
    expect(medianOfWeeklyExpiryCounts([5, 3, 5])).toBe(5);
    expect(medianOfWeeklyExpiryCounts([5, 5, 4, 4])).toBe(4.5);
    expect(medianOfWeeklyExpiryCounts([1])).toBe(1);
    expect(medianOfWeeklyExpiryCounts([])).toBeNull();
  });
});

describe("a data file's expiries a week", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "expiries-per-week-"));
  const previousDirectory = process.env.BACKTEST_DATA_DIR;
  beforeAll(() => {
    process.env.BACKTEST_DATA_DIR = directory;
  });
  afterAll(() => {
    if (previousDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
    else process.env.BACKTEST_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });

  /** A stored day whose chain holds a Call and a Put on each of the given expirations. */
  const dayWithExpiries = (tradingDate: string, expiries: string[]): SyntheticSymbolFileDay => ({
    tradingDate,
    quotes: expiries.flatMap((expiry): SymbolFileQuote[] => (["C", "P"] as const).map((right) => ({ expiry, strike: 100, right, bid: 1, ask: 1.1, bidSize: 10, askSize: 10 }))),
    endOfDayVolume: 10,
    openInterest: 10,
  });
  /** The weekdays of the week starting Monday `mondayIso`, up to and including `lastWeekdayIndex` (Monday = 0). */
  const weekdaysOf = (mondayIso: string, lastWeekdayIndex = 4) => Array.from({ length: lastWeekdayIndex + 1 }, (_, offset) => isoOfDayNumber(dayNumberOf(mondayIso) + offset));

  it("is the median of the last 4 full weeks' distinct expirations: daily 5, Monday-Wednesday-Friday 3, a week with no stored day left out, the partial last week not counted", () => {
    const week = (mondayIso: string, expiryWeekdayIndexes: number[], lastWeekdayIndex = 4) =>
      weekdaysOf(mondayIso, lastWeekdayIndex).map((tradingDate) => dayWithExpiries(tradingDate, expiryWeekdayIndexes.map((index) => isoOfDayNumber(dayNumberOf(mondayIso) + index)).filter((expiry) => expiry >= tradingDate)));
    // 09-28 has no stored day; 10-05 and 10-12 have daily expirations; 10-19 has Monday-Wednesday-Friday; 10-26 is partial (to Tuesday) with 5.
    const days = [...week("2026-10-05", [0, 1, 2, 3, 4]), ...week("2026-10-12", [0, 1, 2, 3, 4]), ...week("2026-10-19", [0, 2, 4]), ...week("2026-10-26", [0, 1, 2, 3, 4], 1)];
    writeSyntheticSymbolFile(path.join(directory, "EXPW.sqlite"), "EXPW", days);
    expect(readBacktestDataFileExpiriesPerWeek("EXPW", "2026-10-27")).toBe(5);
  });

  it("counts a Monday-Wednesday-Friday ticker as 3 even when a stored Monday lacks one expiry that a later day of the week still holds", () => {
    const monday = "2026-11-02";
    const days = [dayWithExpiries(monday, ["2026-11-02", "2026-11-06"]), dayWithExpiries("2026-11-03", ["2026-11-04", "2026-11-06"]), dayWithExpiries("2026-11-04", ["2026-11-04", "2026-11-06"])];
    writeSyntheticSymbolFile(path.join(directory, "EXPM.sqlite"), "EXPM", days);
    expect(readBacktestDataFileExpiriesPerWeek("EXPM", "2026-11-06")).toBe(3);
  });

  it("is null without a file, without a last day and when no full week is stored", () => {
    writeSyntheticSymbolFile(path.join(directory, "EXPN.sqlite"), "EXPN", [dayWithExpiries("2026-11-03", ["2026-11-06"])]);
    expect(readBacktestDataFileExpiriesPerWeek("NOFILE", "2026-11-03")).toBeNull();
    expect(readBacktestDataFileExpiriesPerWeek("EXPN", null)).toBeNull();
    expect(readBacktestDataFileExpiriesPerWeek("EXPN", "2026-11-03")).toBeNull();
  });
});
