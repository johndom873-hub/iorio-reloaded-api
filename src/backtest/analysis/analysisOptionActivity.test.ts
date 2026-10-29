import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dailySliceLookMinute, endOfDayColumns, openInterestColumns, schemaFourSliceTablesSql, sliceColumn, type SliceRow } from "../engine/symbolFileSlices.js";
import { contractSlicesOf } from "../engine/testSupport/syntheticBacktestData.js";
import { computeOptionActivity } from "./analysisOptionActivity.js";

let database: DatabaseSync;
/** Each day's end-of-day and open-interest contracts of the 20 Nov 2026 expiry, written as slices before a computation. */
let endOfDayByDate: Map<string, SliceRow[]>;
let openInterestByDate: Map<string, SliceRow[]>;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(schemaFourSliceTablesSql);
  endOfDayByDate = new Map();
  openInterestByDate = new Map();
});
afterEach(() => database.close());

const addTo = (rowsByDate: Map<string, SliceRow[]>, date: string, row: SliceRow) => rowsByDate.set(date, [...(rowsByDate.get(date) ?? []), row]);
const eod = (date: string, right: "C" | "P", strike: number, volume: number | null) => addTo(endOfDayByDate, date, [strike, right, 1, volume, 1, 1]);
const openInterest = (date: string, right: "C" | "P", strike: number, contracts: number) => addTo(openInterestByDate, date, [strike, right, contracts]);

function activityOf(lastDate: string, capByDate: ReadonlyMap<string, number>) {
  const insertEndOfDay = database.prepare("INSERT INTO end_of_day_slices (key, call_count, put_count, has_volume, data) VALUES (?, ?, ?, ?, ?)");
  const insertOpenInterest = database.prepare("INSERT INTO open_interest_slices (key, call_count, put_count, data) VALUES (?, ?, ?, ?)");
  const contractsOf = (rows: SliceRow[]) => rows.map((row) => ({ expiry: "2026-11-20", row }));
  for (const [date, rows] of endOfDayByDate) for (const [key, calls, puts, hasVolume, data] of contractSlicesOf(date, dailySliceLookMinute, contractsOf(rows), endOfDayColumns, { column: sliceColumn.volume, kind: "volume" })) insertEndOfDay.run(key, calls, puts, hasVolume, data);
  for (const [date, rows] of openInterestByDate) for (const [key, calls, puts, , data] of contractSlicesOf(date, dailySliceLookMinute, contractsOf(rows), openInterestColumns, { column: sliceColumn.openInterest, kind: "volume" })) insertOpenInterest.run(key, calls, puts, data);
  return computeOptionActivity(database, lastDate, capByDate);
}

describe("computeOptionActivity", () => {
  it("averages the recent sessions' volume, splits Calls and Puts, counts Puts at or under each day's cap, and reads the latest open interest", () => {
    // Two sessions: 16 Oct 300 Calls + 100 Puts (40 at the $85 cap), 15 Oct 100 Calls + 100 Puts (none under its $80 cap).
    eod("2026-10-16", "C", 110, 300);
    eod("2026-10-16", "P", 85, 40);
    eod("2026-10-16", "P", 95, 60);
    eod("2026-10-15", "C", 110, 100);
    eod("2026-10-15", "P", 90, 100);
    eod("2026-10-15", "P", 70, null);
    // A day after the analysis's last day is left out.
    eod("2026-10-19", "C", 110, 9_999);
    openInterest("2026-10-16", "C", 110, 600);
    openInterest("2026-10-16", "P", 80, 300);
    openInterest("2026-10-16", "P", 95, 100);
    const caps = new Map([
      ["2026-10-16", 85],
      ["2026-10-15", 80],
    ]);
    const activity = activityOf("2026-10-16", caps);
    expect(activity.volume).toEqual({ sessions: 2, fromDate: "2026-10-15", toDate: "2026-10-16", averagePerDay: 300, callShare: 400 / 600, cappedPutsAveragePerDay: 20, yearSessions: 2, yearAveragePerDay: 300 });
    expect(activity.openInterest).toEqual({ date: "2026-10-16", total: 1_000, callShare: 0.6, cappedPuts: 300 });
  });

  it("keeps 21 sessions in the recent average and 252 in the year's", () => {
    const start = Date.UTC(2025, 0, 1);
    for (let index = 0; index < 300; index++) eod(new Date(start + index * 86_400_000).toISOString().slice(0, 10), "C", 100, index < 279 ? 10 : 100);
    const activity = activityOf("2026-12-31", new Map());
    expect(activity.volume).toMatchObject({ sessions: 21, averagePerDay: 100, yearSessions: 252, cappedPutsAveragePerDay: null });
    // The year: the 21 busy days at 100 and 231 at 10.
    expect(activity.volume!.yearAveragePerDay).toBeCloseTo((21 * 100 + 231 * 10) / 252, 9);
    expect(activity.openInterest).toBeNull();
  });

  it("gives nothing for a file without end-of-day or open-interest rows", () => {
    expect(activityOf("2026-10-16", new Map())).toEqual({ volume: null, openInterest: null });
  });
});
