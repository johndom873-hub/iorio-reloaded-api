import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AlphaVantageRefusedError, dividendsFromAlphaVantage, readFileDividends, readFileDividendsFetchedAt, writeFileDividends } from "./backtestFileDividends.js";

describe("Alpha Vantage's dividends", () => {
  it("keeps each ex-dividend date and amount as paid, oldest first, and leaves out rows without a date or amount", () => {
    // XLE either side of its 2-for-1 split on 2025-12-05: amounts as paid then.
    const body = {
      symbol: "XLE",
      data: [
        { ex_dividend_date: "2025-12-22", amount: "0.373015" },
        { ex_dividend_date: "2025-09-22", amount: "0.748731" },
        { ex_dividend_date: "None", amount: "0.5" },
        { ex_dividend_date: "2025-06-23", amount: "0" },
      ],
    };
    expect(dividendsFromAlphaVantage(body)).toEqual([
      { exDividendDate: "2025-09-22", amount: 0.748731 },
      { exDividendDate: "2025-12-22", amount: 0.373015 },
    ]);
  });

  it("refuses an answer without data with Alpha Vantage's own message (its daily limit)", () => {
    expect(() => dividendsFromAlphaVantage({ Information: "Our standard API rate limit is 25 requests per day." })).toThrow(AlphaVantageRefusedError);
    expect(() => dividendsFromAlphaVantage({ Information: "Our standard API rate limit is 25 requests per day." })).toThrow("25 requests per day");
  });
});

describe("a data file's dividends", () => {
  it("are replaced whole with when they were fetched, and read back oldest first; none before the first fetch", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "file-dividends-"));
    const database = new DatabaseSync(path.join(directory, "TEST.sqlite"));
    try {
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      expect(readFileDividends(database)).toBeNull();
      writeFileDividends(database, [{ exDividendDate: "2026-03-23", amount: 0.385178 }, { exDividendDate: "2025-12-22", amount: 0.373015 }], new Date("2026-11-04T05:00:00Z"));
      writeFileDividends(database, [{ exDividendDate: "2025-12-22", amount: 0.373015 }], new Date("2026-11-05T05:00:00Z"));
      expect(readFileDividends(database)).toEqual([{ exDividendDate: "2025-12-22", amount: 0.373015 }]);
      expect(readFileDividendsFetchedAt(database)).toBe("2026-11-05T05:00:00.000Z");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
