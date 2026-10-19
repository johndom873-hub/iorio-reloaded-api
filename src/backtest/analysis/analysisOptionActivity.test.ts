import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeOptionActivity } from "./analysisOptionActivity.js";

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE eod (trading_date TEXT, expiry TEXT, strike REAL, option_right TEXT, close REAL, volume INTEGER, bid REAL, ask REAL)");
  database.exec("CREATE TABLE open_interest (trading_date TEXT, expiry TEXT, strike REAL, option_right TEXT, open_interest INTEGER)");
});
afterEach(() => database.close());

const eod = (date: string, right: "C" | "P", strike: number, volume: number | null) =>
  database.prepare("INSERT INTO eod VALUES (?, '2026-11-20', ?, ?, 1, ?, 1, 1)").run(date, strike, right, volume);
const openInterest = (date: string, right: "C" | "P", strike: number, contracts: number) => database.prepare("INSERT INTO open_interest VALUES (?, '2026-11-20', ?, ?, ?)").run(date, strike, right, contracts);

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
    const activity = computeOptionActivity(database, "2026-10-16", caps);
    expect(activity.volume).toEqual({ sessions: 2, fromDate: "2026-10-15", toDate: "2026-10-16", averagePerDay: 300, callShare: 400 / 600, cappedPutsAveragePerDay: 20, yearSessions: 2, yearAveragePerDay: 300 });
    expect(activity.openInterest).toEqual({ date: "2026-10-16", total: 1_000, callShare: 0.6, cappedPuts: 300 });
  });

  it("keeps 21 sessions in the recent average and 252 in the year's", () => {
    const start = Date.UTC(2025, 0, 1);
    for (let index = 0; index < 300; index++) eod(new Date(start + index * 86_400_000).toISOString().slice(0, 10), "C", 100, index < 279 ? 10 : 100);
    const activity = computeOptionActivity(database, "2026-12-31", new Map());
    expect(activity.volume).toMatchObject({ sessions: 21, averagePerDay: 100, yearSessions: 252, cappedPutsAveragePerDay: null });
    // The year: the 21 busy days at 100 and 231 at 10.
    expect(activity.volume!.yearAveragePerDay).toBeCloseTo((21 * 100 + 231 * 10) / 252, 9);
    expect(activity.openInterest).toBeNull();
  });

  it("gives nothing for a file without the tables", () => {
    const empty = new DatabaseSync(":memory:");
    expect(computeOptionActivity(empty, "2026-10-16", new Map())).toEqual({ volume: null, openInterest: null });
    empty.close();
  });
});
