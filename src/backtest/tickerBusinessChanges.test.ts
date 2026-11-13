import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { loadDailyBarsOf } from "./analysis/analysisFigures.js";
import { writeFileStockBars } from "./backtestFileStockBars.js";
import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "./dataFileSummary.js";
import { BacktestSymbolFile } from "./engine/backtestSymbolFile.js";
import { syntheticOptionQuotes, writeSyntheticSymbolFile, type SyntheticSymbolFileDay } from "./engine/testSupport/syntheticBacktestData.js";
import { currentBusinessFromOf, possibleBusinessChangeNotice, rowsFrom, tickerBusinessChangeOf } from "../lib/tickerBusinessChanges.js";

describe("the list of business changes", () => {
  it("gives a listed ticker's first session of its current business, and none for the others", () => {
    expect(currentBusinessFromOf("SOFI")).toBe("2021-06-01");
    expect(tickerBusinessChangeOf("NBIS")?.before).toBe("Yandex");
    expect(currentBusinessFromOf("GLD")).toBeNull();
  });

  it("keeps the rows from a date, or every row without one", () => {
    const rows = [{ tradingDate: "2021-05-28" }, { tradingDate: "2021-06-01" }, { tradingDate: "2021-06-02" }];
    expect(rowsFrom(rows, "2021-06-01").map((row) => row.tradingDate)).toEqual(["2021-06-01", "2021-06-02"]);
    expect(rowsFrom(rows, null)).toEqual(rows);
  });
});

describe("a newly downloaded ticker that may have been another company", () => {
  it("is flagged when its options start more than 60 days after its stock prices", () => {
    // RKLB's dates as downloaded, for a ticker not on the list: the SPAC's prices from 2020-11-17, options from 2021-08-25.
    expect(possibleBusinessChangeNotice("NEWCO", "2020-11-17", "2021-08-25")).toContain("NEWCO: its options start 2021-08-25, 281 days after its stock prices (2020-11-17)");
  });

  it("is not flagged at 60 days or less, with options from the option data's start, or when already on the list", () => {
    expect(possibleBusinessChangeNotice("NEWCO", "2021-03-24", "2021-05-23")).toBeNull();
    expect(possibleBusinessChangeNotice("NEWCO", "2007-03-29", "2020-01-02")).toBeNull();
    expect(possibleBusinessChangeNotice("SOFI", "2020-11-30", "2021-06-01")).toBeNull();
  });
});

describe("a data file of a ticker whose business changed", () => {
  // SOFI's file: two complete days, an issue, an unavailable day and bars before its business change on 2021-06-01, and
  // the same after; PLAIN, a ticker without a change, holds the same.
  let dataDirectory: string;
  let previousDataDirectory: string | undefined;
  const dates = ["2021-05-27", "2021-05-28", "2021-06-01", "2021-06-02"];
  const day = (tradingDate: string): SyntheticSymbolFileDay => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, 20, ["2021-06-18"], 0.5, 0.04, 1, 2), endOfDayVolume: 100, openInterest: 200, intradayQuotes: { "10:30": syntheticOptionQuotes(tradingDate, 20, ["2021-06-18"], 0.5, 0.04, 1, 2) } });
  const writeFile = (symbol: string) => {
    const filePath = path.join(dataDirectory, `${symbol}.sqlite`);
    writeSyntheticSymbolFile(filePath, symbol, dates.map(day), [], {
      dayIssues: [
        { tradingDate: "2021-05-28", part: "eod", expiry: null, message: "timeout" },
        { tradingDate: "2021-06-02", part: "eod", expiry: null, message: "timeout" },
      ],
      unavailableDays: [
        { tradingDate: "2021-05-26", reason: "no 10:00 quotes" },
        { tradingDate: "2021-06-03", reason: "no 10:00 quotes" },
      ],
    });
    const database = new DatabaseSync(filePath);
    try {
      writeFileStockBars(database, {
        daily: dates.map((tradingDate) => ({ tradingDate, open: 20, high: 20, low: 20, close: 20, volume: 1_000, impliedVolatility: 0.5 })),
        intraday: dates.map((tradingDate) => ({ barStart: easternInstant(tradingDate, 9, 30), open: 20, high: 20, low: 20, close: 20, volume: 100 })),
        fetchedAt: new Date("2021-06-03T00:00:00Z"),
      });
    } finally {
      database.close();
    }
  };

  beforeAll(() => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), "business-change-"));
    previousDataDirectory = process.env.BACKTEST_DATA_DIR;
    process.env.BACKTEST_DATA_DIR = dataDirectory;
    writeFile("SOFI");
    writeFile("PLAIN");
  });

  afterAll(() => {
    if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
    else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it("reads as starting at the change in the engine: days, issues, unavailable days, intraday days and bars", () => {
    const file = BacktestSymbolFile.open("SOFI");
    try {
      expect(file.loadDays().map((stored) => stored.tradingDate)).toEqual(["2021-06-01", "2021-06-02"]);
      expect([...file.loadDayIssuesByDate().keys()]).toEqual(["2021-06-02"]);
      expect(file.loadUnavailableDays().map((stored) => stored.tradingDate)).toEqual(["2021-06-03"]);
      expect([...file.loadIntradayDays()]).toEqual(["2021-06-01", "2021-06-02"]);
      expect(file.loadIbkrDailyBars()!.map((bar) => bar.tradingDate)).toEqual(["2021-06-01", "2021-06-02"]);
      const prices = file.loadIbkrIntradayPrices("2021-05-27", "2021-06-02")!;
      expect(prices.priceAt("2021-05-28", "10:00")).toBeNull();
      expect(prices.priceAt("2021-06-01", "10:00")).toBe(20);
      expect(file.loadIbkrIntradayPrices("2021-05-27", "2021-05-28")).toBeNull();
    } finally {
      file.close();
    }
  });

  it("starts at the change in the daily bars every analysis reads and in the file's contents", async () => {
    expect((await loadDailyBarsOf("SOFI", {} as never)).bars.map((bar) => bar.tradingDate)).toEqual(["2021-06-01", "2021-06-02"]);
    expect(readBacktestDataFileContents("SOFI")).toMatchObject({ firstDate: "2021-06-01", completeDays: 2, daysWithIssues: 1, unavailableDays: 1, intradayDays: 2 });
    expect(readBacktestDataFilePeriodContents("SOFI", "2021-05-24", "2021-06-02")).toMatchObject({ missingWeekdays: 0, completeDays: 2 });
  });

  it("reads every day for a ticker without a change", async () => {
    const file = BacktestSymbolFile.open("PLAIN");
    try {
      expect(file.loadDays().map((stored) => stored.tradingDate)).toEqual(dates);
    } finally {
      file.close();
    }
    expect((await loadDailyBarsOf("PLAIN", {} as never)).bars).toHaveLength(4);
    expect(readBacktestDataFileContents("PLAIN")).toMatchObject({ firstDate: "2021-05-27", completeDays: 4, daysWithIssues: 2, unavailableDays: 2 });
  });
});
