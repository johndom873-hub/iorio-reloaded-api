import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeOptionActivity } from "../analysis/analysisOptionActivity.js";
import { checkSchemaFourFile, convertSymbolFileToSchemaFour } from "../symbolFileSchemaFourConversion.js";
import { BacktestDayDataReader } from "./backtestDayDataReader.js";
import { BacktestSymbolFile, type SymbolFileQuote } from "./backtestSymbolFile.js";
import { decodeSlice, packSlice, sliceValueAt, tenOClockQuoteColumns, type SliceRow } from "./symbolFileSlices.js";
import { syntheticOptionQuotes, writeSyntheticSymbolFile, type SyntheticSymbolFileDay } from "./testSupport/syntheticBacktestData.js";

// Schema 4 (symbolFileSlices.ts, Marcelo 2026-10-29): the slices hold every value exactly, the conversion's check
// passes on files with every case the downloader leaves, and each read gives what the schema 3 file gives.

let schemaThreeDirectory: string;
let schemaFourDirectory: string;
let previousDataDirectory: string | undefined;
const symbols = ["EDGES", "INTRA", "ALLEXP"];
const schemaThreeFile = (symbol: string) => path.join(schemaThreeDirectory, `${symbol}.sqlite`);
const schemaFourFile = (symbol: string) => path.join(schemaFourDirectory, `${symbol}.sqlite`);
const day = (tradingDate: string, price = 100, withoutEndOfDay = false): SyntheticSymbolFileDay => ({ tradingDate, quotes: syntheticOptionQuotes(tradingDate, price, ["2026-03-13", "2026-03-20"], 0.5, 0.04, 2.5, 3), endOfDayVolume: 100, openInterest: 200, withoutEndOfDay });

beforeAll(() => {
  schemaThreeDirectory = mkdtempSync(path.join(tmpdir(), "symbol-file-schema-three-"));
  schemaFourDirectory = mkdtempSync(path.join(tmpdir(), "symbol-file-schema-four-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  // Quotes without a bid, without an ask, a crossed one and one at a half cent; a day without its end of day; issues
  // and an unavailable day; a holiday; days with and without intraday quotes.
  const edgeQuotes = syntheticOptionQuotes("2026-03-02", 100, ["2026-03-13", "2026-03-20", "2026-04-16", "2026-04-17", "2026-12-27"], 0.5, 0.04, 2.5, 4);
  edgeQuotes[1] = { ...edgeQuotes[1]!, bid: null };
  edgeQuotes[4] = { ...edgeQuotes[4]!, ask: null, askSize: null };
  edgeQuotes[6] = { ...edgeQuotes[6]!, bid: 2.5, ask: 2.4 };
  edgeQuotes[8] = { ...edgeQuotes[8]!, bid: 1.005 };
  writeSyntheticSymbolFile(schemaThreeFile("EDGES"), "EDGES", [{ ...day("2026-03-02"), quotes: edgeQuotes, intradayQuotes: { "10:30": edgeQuotes, "11:00": syntheticOptionQuotes("2026-03-02", 101, ["2026-03-13"], 0.5, 0.04, 2.5, 4) } }, day("2026-03-03", 101), day("2026-03-05", 99, true), day("2026-03-06", 98)], ["2026-03-04"], {
    schemaVersion: "3",
    dayIssues: [
      { tradingDate: "2026-03-05", part: "eod", expiry: null, message: "HTTP 500" },
      { tradingDate: "2026-03-06", part: "open_interest", expiry: "2026-03-13", message: "timeout" },
    ],
    unavailableDays: [{ tradingDate: "2026-03-09", reason: "quotes at 10:00: HTTP 500" }],
    intradayCompleteDays: ["2026-03-03"],
  });
  const laterLook = (price: number) => syntheticOptionQuotes("2026-03-02", price, ["2026-03-13"], 0.5, 0.04, 5, 2);
  writeSyntheticSymbolFile(schemaThreeFile("INTRA"), "INTRA", [{ ...day("2026-03-02"), intradayQuotes: { "10:30": laterLook(101), "11:00": laterLook(102), "15:30": laterLook(99) } }, day("2026-03-03"), day("2026-03-09")], ["2026-03-04"], { schemaVersion: "3" });
  const everyExpiry = syntheticOptionQuotes("2026-03-02", 100, ["2026-03-12", "2026-04-16", "2026-04-17", "2026-12-27"], 0.5, 0.04, 5, 1);
  writeSyntheticSymbolFile(schemaThreeFile("ALLEXP"), "ALLEXP", [{ ...day("2026-03-02"), quotes: everyExpiry, intradayQuotes: { "10:30": everyExpiry } }], [], { schemaVersion: "3" });
  for (const symbol of symbols) convertSymbolFileToSchemaFour(schemaThreeFile(symbol), schemaFourFile(symbol));
});

afterAll(() => {
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(schemaThreeDirectory, { recursive: true, force: true });
  rmSync(schemaFourDirectory, { recursive: true, force: true });
});

const openFile = (filePath: string) => new BacktestSymbolFile(new DatabaseSync(filePath, { readOnly: true }));
const decodedRows = (rows: readonly SliceRow[]) => {
  const slice = decodeSlice(packSlice(rows, tenOClockQuoteColumns), tenOClockQuoteColumns);
  return Array.from({ length: slice.count }, (_, index) => tenOClockQuoteColumns.map((kind, column) => (kind === "right" ? (slice.puts[index] === 1 ? "P" : "C") : sliceValueAt(slice.columns[column]!, index))));
};

describe("slices", () => {
  it("give back every value exactly, whatever width each column needs", () => {
    const rows: SliceRow[] = [
      [100, "C", 1.25, 1.3, 10, 12, 1500],
      [100, "P", null, 0.05, null, 3, null],
      [102.5, "C", 0, 0, 0, 0, 0],
      [105, "P", 655.36, 700.01, 70_000, 65_536, 3_000_000_000],
      [1000.125, "C", 2, 1.5, 1, 1, 0],
    ];
    expect(decodedRows(rows)).toStrictEqual(rows);
  });

  it("keep a column that is not exact in its unit as stored, and a slice of equal values", () => {
    const halfCent: SliceRow[] = [
      [50, "C", 0.015, 1, 5, 5, 0],
      [55, "P", 0.02, 1.01, 5, 5, 0],
    ];
    expect(decodedRows(halfCent)).toStrictEqual(halfCent);
    const equal: SliceRow[] = [[50, "C", 1, 1, 5, 5, 0]];
    expect(decodedRows(equal)).toStrictEqual(equal);
  });

  it("refuse a right other than C or P", () => {
    expect(() => packSlice([[50, "X", 1, 1, 5, 5, 0]], tenOClockQuoteColumns)).toThrow("right X");
  });
});

describe("the schema 3 → 4 conversion", () => {
  it("passes its check on every file: each option row, table row and meta key identical", () => {
    for (const symbol of symbols) expect(checkSchemaFourFile(schemaThreeFile(symbol), schemaFourFile(symbol)).optionRows).toBeGreaterThan(0);
  });

  it("refuses a file whose intraday quotes at 10:00 differ from the 10:00 quotes, and a file of another version", () => {
    const quotes = syntheticOptionQuotes("2026-03-02", 100, ["2026-03-13"], 0.5, 0.04, 2.5, 2);
    const differing = path.join(schemaThreeDirectory, "DIFFER.sqlite");
    writeSyntheticSymbolFile(differing, "DIFFER", [{ ...day("2026-03-02"), quotes, intradayQuotes: { "10:00": quotes.map((quote, index) => (index === 0 ? { ...quote, bid: (quote.bid ?? 0) + 0.01 } : quote)) } }], [], { schemaVersion: "3" });
    expect(() => convertSymbolFileToSchemaFour(differing, path.join(schemaFourDirectory, "DIFFER.sqlite"))).toThrow("1 intraday quotes at 10:00 differ from the 10:00 quotes");
    const versionTwo = path.join(schemaThreeDirectory, "VERTWO.sqlite");
    writeSyntheticSymbolFile(versionTwo, "VERTWO", [day("2026-03-02")], [], { schemaVersion: "2" });
    expect(() => convertSymbolFileToSchemaFour(versionTwo, path.join(schemaFourDirectory, "VERTWO.sqlite"))).toThrow("only version 3 files are converted");
  });
});

describe("a schema 4 file", () => {
  it("reads as its schema 3 original, read by read", () => {
    for (const symbol of symbols) {
      const original = openFile(schemaThreeFile(symbol));
      const converted = openFile(schemaFourFile(symbol));
      const same = <T>(read: (file: BacktestSymbolFile) => T): T => {
        const expected = read(original);
        expect(read(converted)).toStrictEqual(expected);
        return expected;
      };
      same((file) => file.loadDays());
      same((file) => file.loadIntradayDays());
      same((file) => file.loadDayIssuesByDate());
      same((file) => file.loadUnavailableDays());
      const days = original.loadDays().filter((stored) => stored.status === "complete").map((stored) => stored.tradingDate);
      days.forEach((tradingDate, index) => {
        const quotes = same((file) => file.loadQuotes(tradingDate));
        same((file) => file.loadEndOfDay(tradingDate));
        same((file) => file.loadNextCallExpiryDay(tradingDate, index === 0 ? null : days[index - 1]!));
        const looks: string[] = [];
        for (let look = same((file) => file.nextIntradayLookTime(tradingDate, "10:00")); look !== null; look = same((file) => file.nextIntradayLookTime(tradingDate, look!))) looks.push(look);
        same((file) => file.loadIntradayQuotes(tradingDate, "10:00", "15:30", 0, Number.MAX_SAFE_INTEGER));
        same((file) => file.loadIntradayQuotes(tradingDate, "10:30", "15:30", 97, 103));
        for (const look of looks) {
          same((file) => file.hasIntradayQuoteWithin(tradingDate, look, 99, 101));
          same((file) => file.hasIntradayQuoteWithin(tradingDate, look, 1000, 2000));
        }
        const allQuotes: SymbolFileQuote[] = [...quotes, ...original.loadCallExpiries(tradingDate).flatMap((expiry) => original.loadCallQuotesOfExpiry(tradingDate, expiry))];
        for (const quote of allQuotes) {
          const contract = { expiry: quote.expiry, right: quote.right };
          same((file) => file.loadQuotesOfContract(tradingDate, contract, quote.strike - 0.0001, quote.strike + 0.0001));
          same((file) => file.loadEndOfDayOfContract(tradingDate, contract, quote.strike - 0.0001, quote.strike + 0.0001));
          for (const look of looks) same((file) => file.loadIntradayQuotesOfContract(tradingDate, look, contract, quote.strike - 0.0001, quote.strike + 0.0001));
        }
        for (const expiry of same((file) => file.loadCallExpiries(tradingDate))) {
          same((file) => file.loadCallQuotesOfExpiry(tradingDate, expiry));
          for (const look of looks) same((file) => file.loadIntradayCallQuotesOfExpiry(tradingDate, look, expiry));
        }
        for (const expiry of same((file) => file.loadPutExpiries(tradingDate))) {
          same((file) => file.loadPutQuotesOfExpiry(tradingDate, expiry));
          for (const look of looks) same((file) => file.loadIntradayPutQuotesOfExpiry(tradingDate, look, expiry));
        }
      });
      original.close();
      converted.close();
    }
  });

  it("hands the reader threads the same days, for a full session and a Vol Farmer v2 session", async () => {
    for (const readsNextCallExpiryOnly of [false, true]) {
      process.env.BACKTEST_DATA_DIR = schemaThreeDirectory;
      const originalReader = new BacktestDayDataReader({ readsIntradayQuotes: true, readsNextCallExpiryOnly, threadCount: 1 });
      process.env.BACKTEST_DATA_DIR = schemaFourDirectory;
      const convertedReader = new BacktestDayDataReader({ readsIntradayQuotes: true, readsNextCallExpiryOnly, threadCount: 1 });
      try {
        for (const symbol of symbols) {
          const file = openFile(schemaThreeFile(symbol));
          const days = file.loadDays().filter((stored) => stored.status === "complete").map((stored) => stored.tradingDate);
          file.close();
          for (const [index, tradingDate] of days.entries()) {
            const extras = { intradayLookCheck: { lookTime: "11:00", lowestStrike: 99, highestStrike: 101 }, previousFileDay: readsNextCallExpiryOnly && index > 0 ? days[index - 1]! : null };
            const [originalDay, convertedDay] = await Promise.all([originalReader.take(symbol, tradingDate, "10:00", extras), convertedReader.take(symbol, tradingDate, "10:00", extras)]);
            expect(originalDay).not.toBeNull();
            expect(convertedDay).not.toBeNull();
            expect(convertedDay!.quotes()).toStrictEqual(originalDay!.quotes());
            expect(convertedDay!.endOfDay()).toStrictEqual(originalDay!.endOfDay());
            expect(convertedDay!.nextCallExpiryDay()).toStrictEqual(originalDay!.nextCallExpiryDay());
            expect(convertedDay!.intradayQuotes("10:00", "15:30", 0, Number.MAX_SAFE_INTEGER)).toStrictEqual(originalDay!.intradayQuotes("10:00", "15:30", 0, Number.MAX_SAFE_INTEGER));
            expect(convertedDay!.intradayLookHasQuoteWithin("11:00", 99, 101)).toStrictEqual(originalDay!.intradayLookHasQuoteWithin("11:00", 99, 101));
          }
        }
      } finally {
        await originalReader.close();
        await convertedReader.close();
      }
    }
  });

  it("refuses an intraday read at 10:00 or earlier: 10:00 is read from the 10:00 quotes", () => {
    const converted = openFile(schemaFourFile("INTRA"));
    try {
      expect(() => converted.loadIntradayCallQuotesOfExpiry("2026-03-02", "10:00", "2026-03-13")).toThrow("Schema 4 files keep intraday quotes after 10:00 only");
      expect(() => converted.loadIntradayQuotes("2026-03-02", "09:30", "15:30", 0, 1000)).toThrow("Schema 4 files keep intraday quotes after 10:00 only");
    } finally {
      converted.close();
    }
  });

  it("gives the Analyse window the same option volume and open interest", () => {
    const capByDate = new Map([["2026-03-02", 100], ["2026-03-03", 101]]);
    for (const symbol of symbols) {
      const original = new DatabaseSync(schemaThreeFile(symbol), { readOnly: true });
      const converted = new DatabaseSync(schemaFourFile(symbol), { readOnly: true });
      expect(computeOptionActivity(converted, "2026-03-06", capByDate)).toStrictEqual(computeOptionActivity(original, "2026-03-06", capByDate));
      original.close();
      converted.close();
    }
  });
});
