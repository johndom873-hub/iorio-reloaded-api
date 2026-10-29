import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BacktestDayDataReader } from "./backtestDayDataReader.js";
import { BacktestSymbolFile } from "./backtestSymbolFile.js";
import { syntheticOptionQuotes, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";

// The day-data reader thread reads a symbol's day ahead of the session: what it hands over must be what
// BacktestSymbolFile reads from the same file, row for row and value for value.

let dataDirectory: string;
let previousDataDirectory: string | undefined;
let reader: BacktestDayDataReader;
let readerWithoutIntraday: BacktestDayDataReader;

beforeAll(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-day-data-reader-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  // Expiries 11, 18, 45, 46 and 300 days out: a file holding every expiry, of which the engine reads 0..45 days (46 for the end of day).
  const expiries = ["2026-03-13", "2026-03-20", "2026-04-16", "2026-04-17", "2026-12-27"];
  const quotes = syntheticOptionQuotes("2026-03-02", 100, expiries, 0.5, 0.04, 2.5, 8);
  // Some quotes without a bid or an ask, as the files hold them.
  quotes[1] = { ...quotes[1]!, bid: null };
  quotes[4] = { ...quotes[4]!, ask: null, askSize: null };
  writeSyntheticSymbolFile(path.join(dataDirectory, "READ.sqlite"), "READ", [
    {
      tradingDate: "2026-03-02",
      quotes,
      endOfDayVolume: 100,
      openInterest: 200,
      intradayQuotes: {
        "10:30": syntheticOptionQuotes("2026-03-02", 101, expiries, 0.5, 0.04, 2.5, 8),
        "11:00": syntheticOptionQuotes("2026-03-02", 99, expiries, 0.5, 0.04, 2.5, 8).map((quote, index) => (index === 3 ? { ...quote, bid: null } : quote)),
        "15:30": syntheticOptionQuotes("2026-03-02", 98, ["2026-03-13"], 0.5, 0.04, 2.5, 8),
      },
    },
  ], [], { schemaVersion: "3" });
  reader = new BacktestDayDataReader({ readsIntradayQuotes: true, threadCount: 1 });
  readerWithoutIntraday = new BacktestDayDataReader({ readsIntradayQuotes: false, threadCount: 1 });
});

afterAll(async () => {
  await reader.close();
  await readerWithoutIntraday.close();
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("BacktestDayDataReader", () => {
  it("hands over the 10:00 quotes, end-of-day rows and intraday quotes as the file reads them", async () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      const day = await reader.take("READ", "2026-03-02", "10:00");
      expect(day).not.toBeNull();
      expect(day!.quotes()).toStrictEqual(file.loadQuotes("2026-03-02"));
      expect(day!.endOfDay()).toStrictEqual(file.loadEndOfDay("2026-03-02"));
      for (const [through, lowest, highest] of [["15:30", 0, 1e9], ["11:00", 90, 105], ["10:30", 100, 100], ["15:30", 97.495, 102.505], ["12:00", 200, 300]] as const) {
        expect([...day!.intradayQuotes("10:00", through, lowest, highest)!]).toStrictEqual([...file.loadIntradayQuotes("2026-03-02", "10:00", through, lowest, highest)]);
      }
      const lastExpiry = (expiriesRead: string[]) => expiriesRead.sort().at(-1);
      expect(lastExpiry(day!.quotes().map((quote) => quote.expiry))).toBe("2026-04-16");
      expect(lastExpiry(day!.endOfDay().map((row) => row.expiry))).toBe("2026-04-17");
      expect(lastExpiry([...day!.intradayQuotes("10:00", "15:30", 0, 1e9)!.values()].flat().map((quote) => quote.expiry))).toBe("2026-04-16");
    } finally {
      file.close();
    }
  });

  it("hands over the same day from each of its threads", async () => {
    const file = BacktestSymbolFile.open("READ");
    const threeThreads = new BacktestDayDataReader({ readsIntradayQuotes: true, threadCount: 3 });
    try {
      // Asked for four times, a day taken in between: the requests go to the threads in turn, the first back to the first.
      for (let request = 0; request < 4; request++) {
        const day = await threeThreads.take("READ", "2026-03-02", "10:00");
        expect(day!.quotes()).toStrictEqual(file.loadQuotes("2026-03-02"));
        expect(day!.endOfDay()).toStrictEqual(file.loadEndOfDay("2026-03-02"));
        expect([...day!.intradayQuotes("10:00", "15:30", 0, 1e9)!]).toStrictEqual([...file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", 0, 1e9)]);
      }
    } finally {
      await threeThreads.close();
      file.close();
    }
  });

  it("leaves the intraday rows to the file for a session that does not read them", async () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      const day = await readerWithoutIntraday.take("READ", "2026-03-02", "10:00");
      expect(day!.quotes()).toStrictEqual(file.loadQuotes("2026-03-02"));
      expect(day!.endOfDay()).toStrictEqual(file.loadEndOfDay("2026-03-02"));
      expect(day!.intradayQuotes("10:00", "15:30", 0, 1e9)).toBeNull();
    } finally {
      file.close();
    }
  });

  it("checks a look for a quote in a strike range while it reads the day, as the file tells it", async () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      for (const lookTime of ["10:30", "11:00", "12:00", "15:30"]) {
        for (const [lowestStrike, highestStrike] of [[45, 220], [200, 300], [100, 100]] as const) {
          const day = await readerWithoutIntraday.take("READ", "2026-03-02", "10:00", { lookTime, lowestStrike, highestStrike });
          const fileHasQuote = file.hasIntradayQuoteWithin("2026-03-02", lookTime, lowestStrike, highestStrike);
          // Asked for the same range or a wider one, it answers when it found a quote; anything else is left to the file.
          expect(day!.intradayLookHasQuoteWithin(lookTime, lowestStrike, highestStrike)).toBe(fileHasQuote ? true : null);
          expect(day!.intradayLookHasQuoteWithin(lookTime, lowestStrike - 10, highestStrike + 10)).toBe(fileHasQuote ? true : null);
          expect(day!.intradayLookHasQuoteWithin(lookTime, lowestStrike + 1, highestStrike)).toBeNull();
          expect(day!.intradayLookHasQuoteWithin("13:00", lowestStrike, highestStrike)).toBeNull();
        }
      }
      expect((await readerWithoutIntraday.take("READ", "2026-03-02", "10:00"))!.intradayLookHasQuoteWithin("10:30", 0, 1e9)).toBeNull();
    } finally {
      file.close();
    }
  });

  it("tells whether a look has quotes in a strike range, and steps through the looks, as loadIntradayQuotes holds them", () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      for (const lookTime of ["10:30", "11:00", "12:00", "15:30"]) {
        for (const [lowestStrike, highestStrike] of [[0, 1e9], [90, 105], [100, 100], [97.495, 102.505], [200, 300], [100.0001, 102.4999]] as const) {
          expect(file.hasIntradayQuoteWithin("2026-03-02", lookTime, lowestStrike, highestStrike)).toBe(file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", lowestStrike, highestStrike).has(lookTime));
        }
      }
      const steppedLookTimes: string[] = [];
      for (let lookTime = file.nextIntradayLookTime("2026-03-02", "10:00"); lookTime !== null; lookTime = file.nextIntradayLookTime("2026-03-02", lookTime)) steppedLookTimes.push(lookTime);
      expect(steppedLookTimes).toStrictEqual([...file.loadIntradayQuotes("2026-03-02", "10:00", "23:59", 0, 1e9).keys()].sort());
      expect(file.nextIntradayLookTime("2026-03-02", "15:30")).toBeNull();
      // A day the file holds no intraday quotes for.
      expect(file.nextIntradayLookTime("2026-03-03", "10:00")).toBeNull();
    } finally {
      file.close();
    }
  });

  it("reads one contract's intraday quotes as loadIntradayQuotes holds them", () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      const all = file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", 0, 1e9);
      for (const [lookTime, quotes] of all) {
        for (const quote of quotes) {
          expect(file.loadIntradayQuotesOfContract("2026-03-02", lookTime, quote, quote.strike - 0.0001, quote.strike + 0.0001)).toStrictEqual(quotes.filter((other) => other.expiry === quote.expiry && other.right === quote.right && other.strike === quote.strike));
        }
      }
      // Past the 45-day window, as the look reads.
      expect(file.loadIntradayQuotesOfContract("2026-03-02", "10:30", { expiry: "2026-04-17", right: "C" }, 0, 1e9)).toStrictEqual([]);
    } finally {
      file.close();
    }
  });

  it("leaves to the file a look range it did not read, and a day it could not read", async () => {
    const day = await reader.take("READ", "2026-03-02", "10:00");
    expect(day!.intradayQuotes("10:30", "15:30", 0, 1e9)).toBeNull();
    expect(await reader.take("MISSING", "2026-03-02", "10:00")).toBeNull();
  });
});
