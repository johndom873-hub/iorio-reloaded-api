import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "../dataFileSummary.js";
import { BacktestSymbolFile } from "./backtestSymbolFile.js";
import { syntheticOptionQuotes, writeSyntheticSymbolFile, type SyntheticSymbolFileDay } from "./testSupport/syntheticBacktestData.js";

// Symbol files as the downloader leaves them: the first downloads' tables only, or with its record of what it could not
// retrieve (day_issues, unavailable_days) and of the days that have intraday quotes.

let dataDirectory: string;
let previousDataDirectory: string | undefined;
const day = (tradingDate: string, withoutEndOfDay = false): SyntheticSymbolFileDay => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, 100, ["2026-03-13"], 0.5, 0.04, 5, 2), endOfDayVolume: 100, openInterest: 200, withoutEndOfDay });
const fileOf = (symbol: string) => path.join(dataDirectory, `${symbol}.sqlite`);

beforeAll(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-symbol-file-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  writeSyntheticSymbolFile(fileOf("OLDF"), "OLDF", [day("2026-03-02"), day("2026-03-03")]);
  // 4 March could not be retrieved at all; the 5th is stored without its end-of-day part; the 6th lacks one expiration's
  // open interest; the 9th has its 10:00 parts but no intraday quotes.
  writeSyntheticSymbolFile(fileOf("NEWF"), "NEWF", [day("2026-03-02"), day("2026-03-03"), day("2026-03-05", true), day("2026-03-06"), day("2026-03-09")], [], {
    dayIssues: [
      { tradingDate: "2026-03-05", part: "eod", expiry: null, message: "HTTP 500" },
      { tradingDate: "2026-03-06", part: "open_interest", expiry: "2026-03-13", message: "timeout" },
      { tradingDate: "2026-03-06", part: "eod", expiry: "2026-03-20", message: "timeout" },
    ],
    unavailableDays: [
      { tradingDate: "2026-03-04", reason: "no 10:00 quotes" },
      { tradingDate: "2026-03-09", reason: "no intraday quotes" },
    ],
    intradayCompleteDays: ["2026-03-02", "2026-03-03", "2026-03-05"],
  });
  // A file reopened by the newer downloader: version 2, day_issues counts its attempts, a complete day without
  // end-of-day rows says "no data returned", and the reasons of unavailable days name the part.
  writeSyntheticSymbolFile(fileOf("VERTWO"), "VERTWO", [day("2026-03-02"), day("2026-03-03", true)], [], {
    schemaVersion: "2",
    dayIssues: [{ tradingDate: "2026-03-03", part: "eod", expiry: null, message: "no data returned" }],
    unavailableDays: [{ tradingDate: "2026-03-04", reason: "quotes at 10:00: HTTP 500" }],
    intradayCompleteDays: ["2026-03-02"],
  });
  writeSyntheticSymbolFile(fileOf("VERTHREE"), "VERTHREE", [day("2026-03-02")], [], { schemaVersion: "3" });
  writeSyntheticSymbolFile(fileOf("VERFOUR"), "VERFOUR", [day("2026-03-02")], [], { schemaVersion: "4" });
  // A file holding every expiry (schema 3): contracts 10, 45, 46 and 300 days out, at 10:00, at the close and at a later
  // look, and issues for a whole part and for expirations inside and beyond the engine's window.
  const everyExpiry = syntheticOptionQuotes("2026-03-02", 100, ["2026-03-12", "2026-04-16", "2026-04-17", "2026-12-27"], 0.5, 0.04, 5, 1);
  const allExpiriesIssue = (part: "quotes" | "eod" | "open_interest" | "intraday_quotes", expiry: string | null) => ({ tradingDate: "2026-03-02", part, expiry, message: "timeout" });
  writeSyntheticSymbolFile(fileOf("ALLEXP"), "ALLEXP", [{ ...day("2026-03-02"), quotes: everyExpiry, intradayQuotes: { "10:30": everyExpiry } }], [], {
    schemaVersion: "3",
    dayIssues: [
      allExpiriesIssue("quotes", "2026-04-16"),
      allExpiriesIssue("quotes", "2026-04-17"),
      allExpiriesIssue("intraday_quotes", "2026-12-27"),
      allExpiriesIssue("eod", null),
      allExpiriesIssue("eod", "2026-04-17"),
      allExpiriesIssue("open_interest", "2026-12-27"),
    ],
  });
  // Intraday quotes on the 2nd (looks at 10:30 and 11:00, the stock a dollar higher at each) and none on the 3rd; the
  // 4th is a holiday, the 5th was never downloaded, the 6th is recorded as unavailable.
  const laterLook = (price: number) => syntheticOptionQuotes("2026-03-02", price, ["2026-03-13"], 0.5, 0.04, 5, 2);
  writeSyntheticSymbolFile(fileOf("INTRA"), "INTRA", [{ ...day("2026-03-02"), intradayQuotes: { "10:30": laterLook(101), "11:00": laterLook(102) } }, day("2026-03-03"), day("2026-03-09")], ["2026-03-04"], { unavailableDays: [{ tradingDate: "2026-03-06", reason: "quotes at 10:00: HTTP 500" }] });
});

afterAll(() => {
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("BacktestSymbolFile", () => {
  it("reads a file from before the downloader recorded what it could not retrieve: no issues, no unavailable days", () => {
    const file = BacktestSymbolFile.open("OLDF");
    try {
      expect(file.loadDays().map((entry) => entry.tradingDate)).toEqual(["2026-03-02", "2026-03-03"]);
      expect(file.loadDayIssues("2026-03-02")).toEqual([]);
      expect(file.loadUnavailableDays()).toEqual([]);
    } finally {
      file.close();
    }
  });

  it("reads the day issues and the unavailable days of a newer file", () => {
    const file = BacktestSymbolFile.open("NEWF");
    try {
      expect(file.loadDayIssues("2026-03-05")).toEqual([{ tradingDate: "2026-03-05", part: "eod", expiry: null, message: "HTTP 500" }]);
      expect(file.loadDayIssues("2026-03-06")).toEqual([
        { tradingDate: "2026-03-06", part: "eod", expiry: "2026-03-20", message: "timeout" },
        { tradingDate: "2026-03-06", part: "open_interest", expiry: "2026-03-13", message: "timeout" },
      ]);
      expect(file.loadDayIssues("2026-03-02")).toEqual([]);
      expect(file.loadUnavailableDays()).toEqual([
        { tradingDate: "2026-03-04", reason: "no 10:00 quotes" },
        { tradingDate: "2026-03-09", reason: "no intraday quotes" },
      ]);
      // The day stored without its end-of-day part is a complete day with no such rows.
      expect(file.loadDays().find((entry) => entry.tradingDate === "2026-03-05")).toEqual({ tradingDate: "2026-03-05", status: "complete" });
      expect(file.loadEndOfDay("2026-03-05")).toEqual([]);
      expect(file.loadQuotes("2026-03-05").length).toBeGreaterThan(0);
    } finally {
      file.close();
    }
  });

  it("accepts schema versions 1, 2 and 3 and refuses any other", () => {
    const versionTwo = BacktestSymbolFile.open("VERTWO");
    try {
      expect(versionTwo.loadDayIssues("2026-03-03")).toEqual([{ tradingDate: "2026-03-03", part: "eod", expiry: null, message: "no data returned" }]);
      expect(versionTwo.loadUnavailableDays()).toEqual([{ tradingDate: "2026-03-04", reason: "quotes at 10:00: HTTP 500" }]);
    } finally {
      versionTwo.close();
    }
    expect(readBacktestDataFileContents("VERTWO")).toMatchObject({ completeDays: 2, daysWithIssues: 1, unavailableDays: 1, intradayDays: 1 });
    BacktestSymbolFile.open("VERTHREE").close();
    expect(() => BacktestSymbolFile.open("VERFOUR")).toThrow("The data file has schema version 4; the engine reads versions 1, 2, 3.");
  });

  it("reads the expiries up to 45 days out (46 for the end of day and the open interest) of a file holding every expiry", () => {
    const file = BacktestSymbolFile.open("ALLEXP");
    try {
      const expiriesOf = (expiries: string[]) => [...new Set(expiries)].sort();
      expect(expiriesOf(file.loadQuotes("2026-03-02").map((quote) => quote.expiry))).toEqual(["2026-03-12", "2026-04-16"]);
      expect(expiriesOf(file.loadEndOfDay("2026-03-02").map((row) => row.expiry))).toEqual(["2026-03-12", "2026-04-16", "2026-04-17"]);
      expect(expiriesOf([...file.loadOpenInterest("2026-03-02").keys()].map((key) => key.split("|")[0]!))).toEqual(["2026-03-12", "2026-04-16", "2026-04-17"]);
      const looks = file.loadIntradayQuotes("2026-03-02", "09:30", "15:30", 0, 1_000);
      expect([...looks.keys()]).toEqual(["10:00", "10:30"]);
      for (const quotes of looks.values()) expect(expiriesOf(quotes.map((quote) => quote.expiry))).toEqual(["2026-03-12", "2026-04-16"]);
    } finally {
      file.close();
    }
  });

  it("reads only the issues about what it reads: a whole part, or an expiration within the part's window", () => {
    const file = BacktestSymbolFile.open("ALLEXP");
    try {
      expect(file.loadDayIssues("2026-03-02").map((issue) => `${issue.part} ${issue.expiry ?? "all"}`)).toEqual(["eod all", "eod 2026-04-17", "quotes 2026-04-16"]);
    } finally {
      file.close();
    }
    // The file's own count still names every day with an issue, whatever its expiry.
    expect(readBacktestDataFileContents("ALLEXP")).toMatchObject({ daysWithIssues: 1 });
  });
});

describe("readBacktestDataFileContents", () => {
  it("counts the days with issues, the unavailable days and the days with intraday quotes", () => {
    expect(readBacktestDataFileContents("NEWF")).toEqual({ firstDate: "2026-03-02", lastDate: "2026-03-09", completeDays: 5, missingWeekdays: 1, daysWithIssues: 2, unavailableDays: 2, intradayDays: 3 });
  });

  it("reads zero issues and unavailable days, and no intraday count, from a file without those tables", () => {
    expect(readBacktestDataFileContents("OLDF")).toEqual({ firstDate: "2026-03-02", lastDate: "2026-03-03", completeDays: 2, missingWeekdays: 0, daysWithIssues: 0, unavailableDays: 0, intradayDays: null });
  });
});

describe("the quotes at the looks inside a day", () => {
  it("are read by look time, for the looks and strikes asked for", () => {
    const file = BacktestSymbolFile.open("INTRA");
    try {
      expect([...file.loadIntradayDays()]).toEqual(["2026-03-02"]);
      // Strikes 90 to 110 every 5 dollars, calls and puts: 10 quotes a look. The 10:00 look is the capture itself.
      const afterTen = file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", 0, 1_000);
      expect([...afterTen.keys()]).toEqual(["10:30", "11:00"]);
      expect(afterTen.get("10:30")).toHaveLength(10);
      const atTheMoneyCall = (lookTime: string) => afterTen.get(lookTime)!.find((quote) => quote.strike === 100 && quote.right === "C")!;
      expect(atTheMoneyCall("11:00").bid!).toBeGreaterThan(atTheMoneyCall("10:30").bid!);
      expect(atTheMoneyCall("10:30")).toMatchObject({ expiry: "2026-03-13", strike: 100, right: "C", bidSize: null, askSize: null });
      expect(atTheMoneyCall("10:30").ask!).toBeGreaterThan(atTheMoneyCall("10:30").bid!);
      expect([...file.loadIntradayQuotes("2026-03-02", "10:00", "10:30", 0, 1_000).keys()]).toEqual(["10:30"]);
      expect([...file.loadIntradayQuotes("2026-03-02", "09:30", "15:30", 0, 1_000).keys()]).toEqual(["10:00", "10:30", "11:00"]);
      expect(file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", 95, 105).get("10:30")!.map((quote) => quote.strike).sort((a, b) => a - b)).toEqual([95, 95, 100, 100, 105, 105]);
      expect(file.loadIntradayQuotes("2026-03-03", "10:00", "15:30", 0, 1_000).size).toBe(0);
    } finally {
      file.close();
    }
  });

  it("are none in a file downloaded before they existed", () => {
    for (const symbol of ["OLDF", "NEWF"]) {
      const file = BacktestSymbolFile.open(symbol);
      try {
        expect(file.loadIntradayDays().size).toBe(0);
        expect(file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", 0, 1_000).size).toBe(0);
      } finally {
        file.close();
      }
    }
  });
});

describe("readBacktestDataFilePeriodContents", () => {
  it("counts the weekdays of a period with nothing stored, leaving out holidays, weekends and the days recorded as unavailable", () => {
    // 2 to 9 March: the 5th is the only weekday with no row and no record; the 3rd and the 9th have no intraday quotes.
    expect(readBacktestDataFilePeriodContents("INTRA", "2026-03-02", "2026-03-09")).toEqual({ missingWeekdays: 1, firstMissingWeekday: "2026-03-05", lastMissingWeekday: "2026-03-05", completeDays: 3, completeDaysWithoutIntradayQuotes: 2 });
    expect(readBacktestDataFilePeriodContents("INTRA", "2026-03-02", "2026-03-04")).toEqual({ missingWeekdays: 0, firstMissingWeekday: null, lastMissingWeekday: null, completeDays: 2, completeDaysWithoutIntradayQuotes: 1 });
    // A period reaching past what the file holds: every weekday after it is missing.
    expect(readBacktestDataFilePeriodContents("INTRA", "2026-03-09", "2026-03-13")).toMatchObject({ missingWeekdays: 4, firstMissingWeekday: "2026-03-10", lastMissingWeekday: "2026-03-13" });
  });

  it("reads a file without intraday quotes as having none on any day, and no file as null", () => {
    expect(readBacktestDataFilePeriodContents("OLDF", "2026-03-02", "2026-03-03")).toEqual({ missingWeekdays: 0, firstMissingWeekday: null, lastMissingWeekday: null, completeDays: 2, completeDaysWithoutIntradayQuotes: 2 });
    // NEWF lists days as having intraday quotes but holds no quotes table: none can be read, so none counts.
    expect(readBacktestDataFilePeriodContents("NEWF", "2026-03-02", "2026-03-09")).toMatchObject({ missingWeekdays: 0, completeDays: 5, completeDaysWithoutIntradayQuotes: 5 });
    expect(readBacktestDataFilePeriodContents("NOFILE", "2026-03-02", "2026-03-03")).toBeNull();
  });
});
