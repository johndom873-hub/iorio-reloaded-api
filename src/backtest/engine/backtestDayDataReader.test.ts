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
let probingReader: BacktestDayDataReader;

beforeAll(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-day-data-reader-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  // Expiries 11, 18, 45, 46 and 300 days out: a file holding every expiry, of which the engine reads 0..45 days (46 for the end of day and the open interest).
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
  reader = new BacktestDayDataReader();
  probingReader = new BacktestDayDataReader({ probeIntradayQuotesOnly: true });
});

afterAll(async () => {
  await reader.close();
  await probingReader.close();
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("BacktestDayDataReader", () => {
  it("hands over the 10:00 quotes, end-of-day rows, open interest and intraday quotes as the file reads them", async () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      const day = await reader.take("READ", "2026-03-02", "10:00");
      expect(day).not.toBeNull();
      expect(day!.quotes()).toStrictEqual(file.loadQuotes("2026-03-02"));
      expect(day!.endOfDay()).toStrictEqual(file.loadEndOfDay("2026-03-02"));
      expect([...day!.openInterest()]).toStrictEqual([...file.loadOpenInterest("2026-03-02")]);
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

  it("probes the looks instead of reading their rows when asked: with the file's own check, a look has quotes in a strike range exactly when its rows say so", async () => {
    const file = BacktestSymbolFile.open("READ");
    try {
      const strikeRanges = [[0, 1e9], [90, 105], [100, 100], [97.495, 102.505], [200, 300], [100.0001, 102.4999]] as const;
      // Probed around the 10:00 price as the session does, around another price, and with no range at all.
      for (const probeStrikeRange of [{ lowestStrike: 45 - 0.005, highestStrike: 220 + 0.005 }, { lowestStrike: 200, highestStrike: 300 }, null]) {
        const day = await probingReader.take("READ", "2026-03-02", "10:00", probeStrikeRange);
        expect(day!.quotes()).toStrictEqual(file.loadQuotes("2026-03-02"));
        // The rows are left to the file.
        expect(day!.intradayQuotes("10:00", "15:30", 0, 1e9)).toBeNull();
        for (const lookTime of ["10:30", "11:00", "12:00", "15:30"]) {
          for (const [lowestStrike, highestStrike] of strikeRanges) {
            const fileHasQuotes = file.loadIntradayQuotes("2026-03-02", "10:00", "15:30", lowestStrike, highestStrike).has(lookTime);
            expect(file.hasIntradayQuoteWithin("2026-03-02", lookTime, lowestStrike, highestStrike)).toBe(fileHasQuotes);
            const probed = day!.intradayLookHasStrikeWithin("10:00", lookTime, { lowestStrike, highestStrike });
            if (probed !== null) expect(probed).toBe(fileHasQuotes);
          }
        }
        // Every look with rows, as the file holds them.
        expect(day!.intradayProbedLookTimes("10:00")).toStrictEqual([...file.loadIntradayQuotes("2026-03-02", "10:00", "23:59", 0, 1e9).keys()].sort());
        expect(day!.intradayProbedLookTimes("10:30")).toBeNull();
        // A look with no rows, and one with rows probed in range, are told without the file.
        expect(day!.intradayLookHasStrikeWithin("10:00", "12:00", { lowestStrike: 0, highestStrike: 1e9 })).toBe(false);
        if (probeStrikeRange?.lowestStrike === 45 - 0.005) expect(day!.intradayLookHasStrikeWithin("10:00", "10:30", { lowestStrike: 0, highestStrike: 1e9 })).toBe(true);
        expect(day!.intradayLookHasStrikeWithin("10:30", "11:00", { lowestStrike: 0, highestStrike: 1e9 })).toBeNull();
      }
      // A day read with its rows answers from them (intradayQuotes), not this way.
      const fullDay = await reader.take("READ", "2026-03-02", "10:00");
      expect(fullDay!.intradayLookHasStrikeWithin("10:00", "11:00", { lowestStrike: 0, highestStrike: 1e9 })).toBeNull();
      expect(fullDay!.intradayProbedLookTimes("10:00")).toBeNull();
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
