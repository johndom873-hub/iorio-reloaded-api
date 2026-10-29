import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { addFileStockBars, addOlderFileDailyBars, describeFileStockBars, FileIntradayPrices, intradayBarKey, readFileDailyBars, readFileIntradayPrices, readFileStockBarsTail, summarizeFileStockBars, writeFileStockBars, type FileIntradayBar } from "./backtestFileStockBars.js";

const dailyBar = (tradingDate: string, close: number) => ({ tradingDate, open: close - 1, high: close + 1, low: close - 2, close, volume: 1_000_000, impliedVolatility: 0.5 });
const intradayBar = (dateIso: string, startsAt: string, close: number): FileIntradayBar => ({ barStart: easternInstant(dateIso, Number(startsAt.slice(0, 2)), Number(startsAt.slice(3))), open: close, high: close, low: close, close, volume: 1_000 });
const metaValue = (database: DatabaseSync, key: string) => (database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
});

afterEach(() => database.close());

describe("a data file's IBKR stock bars", () => {
  const first = {
    daily: [dailyBar("2026-03-03", 101), dailyBar("2026-03-02", 100)],
    intraday: [intradayBar("2026-03-02", "09:30", 99.5), intradayBar("2026-03-02", "15:30", 100), intradayBar("2026-03-03", "09:30", 100.5)],
    fetchedAt: new Date("2026-10-14T01:00:00Z"),
  };

  it("reads nothing from a file that has none yet", () => {
    expect(readFileDailyBars(database)).toBeNull();
    expect(readFileIntradayPrices(database, "2026-01-01", "2026-12-31")).toBeNull();
    expect(describeFileStockBars(database)).toEqual({ dailyFirstDate: null, dailyLastDate: null, intradayFirstDate: null, intradayLastDate: null, fetchedAt: null });
  });

  it("stores the bars with when they were fetched, and reads the daily ones back in date order", () => {
    writeFileStockBars(database, first);
    expect(readFileDailyBars(database)).toEqual([dailyBar("2026-03-02", 100), dailyBar("2026-03-03", 101)]);
    expect(describeFileStockBars(database)).toEqual({ dailyFirstDate: "2026-03-02", dailyLastDate: "2026-03-03", intradayFirstDate: "2026-03-02", intradayLastDate: "2026-03-03", fetchedAt: "2026-10-14T01:00:00.000Z" });
    expect(metaValue(database, "ibkr_bars_version")).toBe("1");
  });

  it("replaces every bar on the next write, so no two split adjustments are mixed", () => {
    writeFileStockBars(database, first);
    // After a 2-for-1 split IBKR sends the whole history halved.
    writeFileStockBars(database, { daily: [dailyBar("2026-03-03", 50.5)], intraday: [intradayBar("2026-03-03", "09:30", 50.25)], fetchedAt: new Date("2026-10-15T01:00:00Z") });
    expect(readFileDailyBars(database)).toEqual([dailyBar("2026-03-03", 50.5)]);
    const prices = readFileIntradayPrices(database, "2026-03-01", "2026-03-31")!;
    expect(prices.priceAt("2026-03-02", "16:00")).toBeNull();
    expect(prices.priceAt("2026-03-03", "10:00")).toBe(50.25);
    expect(metaValue(database, "ibkr_bars_fetched_at")).toBe("2026-10-15T01:00:00.000Z");
  });

  it("keeps the bars it has when a fetch brings no daily or no 30-minute bars", () => {
    writeFileStockBars(database, first);
    expect(() => writeFileStockBars(database, { ...first, daily: [] })).toThrow("No IBKR bars to write: the file keeps the ones it has.");
    expect(() => writeFileStockBars(database, { ...first, intraday: [] })).toThrow("No IBKR bars to write: the file keeps the ones it has.");
    expect(readFileDailyBars(database)).toHaveLength(2);
    expect(readFileIntradayPrices(database, "2026-03-01", "2026-03-31")!.lastDate).toBe("2026-03-03");
  });

  it("rolls the whole write back when a row fails, keeping the earlier bars", () => {
    writeFileStockBars(database, first);
    const broken = { ...first, daily: [dailyBar("2026-03-04", 102), dailyBar("2026-03-04", 103)], fetchedAt: new Date("2026-10-16T01:00:00Z") };
    expect(() => writeFileStockBars(database, broken)).toThrow();
    expect(readFileDailyBars(database)!.map((bar) => bar.tradingDate)).toEqual(["2026-03-02", "2026-03-03"]);
    expect(metaValue(database, "ibkr_bars_fetched_at")).toBe("2026-10-14T01:00:00.000Z");
  });

  it("files each 30-minute bar under its Eastern date and start time, on winter and summer time alike", () => {
    // 6 March 2026 is on winter time (09:30 ET = 14:30 UTC), 9 March on summer time (09:30 ET = 13:30 UTC).
    writeFileStockBars(database, { daily: [dailyBar("2026-03-09", 100)], intraday: [{ ...intradayBar("2026-03-06", "09:30", 98), barStart: new Date("2026-03-06T14:30:00Z") }, { ...intradayBar("2026-03-09", "09:30", 99), barStart: new Date("2026-03-09T13:30:00Z") }], fetchedAt: new Date("2026-10-14T01:00:00Z") });
    const rows = database.prepare("SELECT trading_date AS tradingDate, start_minutes_et AS startMinutesEt, bar_start AS barStart FROM ibkr_intraday_bars ORDER BY trading_date").all();
    expect(rows).toEqual([
      { tradingDate: "2026-03-06", startMinutesEt: 570, barStart: "2026-03-06T14:30:00.000Z" },
      { tradingDate: "2026-03-09", startMinutesEt: 570, barStart: "2026-03-09T13:30:00.000Z" },
    ]);
  });

  it("reads the 30-minute bars of the dates asked for only", () => {
    writeFileStockBars(database, first);
    const prices = readFileIntradayPrices(database, "2026-03-01", "2026-03-02")!;
    expect(prices.lastDate).toBe("2026-03-02");
    expect(prices.priceAt("2026-03-03", "10:00")).toBeNull();
  });

  it("adds a tail over the bars of the same days and keeps the others, keeping a day's implied volatility when the tail has none", () => {
    writeFileStockBars(database, first);
    const tailDaily = [{ ...dailyBar("2026-03-03", 101), volume: 2_000_000, impliedVolatility: null }, { ...dailyBar("2026-03-04", 102), impliedVolatility: 0.6 }];
    addFileStockBars(database, { daily: tailDaily, intraday: [intradayBar("2026-03-03", "09:30", 100.5), intradayBar("2026-03-04", "09:30", 101.5)], fetchedAt: new Date("2026-10-15T01:00:00Z") });
    expect(readFileDailyBars(database)).toEqual([dailyBar("2026-03-02", 100), { ...dailyBar("2026-03-03", 101), volume: 2_000_000 }, { ...dailyBar("2026-03-04", 102), impliedVolatility: 0.6 }]);
    const prices = readFileIntradayPrices(database, "2026-03-01", "2026-03-31")!;
    expect(prices.priceAt("2026-03-02", "16:00")).toBe(100);
    expect(prices.priceAt("2026-03-04", "10:00")).toBe(101.5);
    expect(metaValue(database, "ibkr_bars_fetched_at")).toBe("2026-10-15T01:00:00.000Z");
    expect(summarizeFileStockBars(database)).toEqual({
      dailyBars: 3,
      dailyFirstDate: "2026-03-02",
      dailyLastDate: "2026-03-04",
      impliedVolatilityDays: 3,
      intradayBars: 4,
      intradayFirstDate: "2026-03-02",
      intradayLastDate: "2026-03-04",
    });
  });

  it("adds the daily bars before the first stored one, leaving the stored bars, the 30-minute bars and the meta keys as they were", () => {
    writeFileStockBars(database, first);
    const added = addOlderFileDailyBars(database, [dailyBar("2026-02-26", 98), { ...dailyBar("2026-02-27", 99), impliedVolatility: null }, dailyBar("2026-03-02", 250)]);
    expect(added).toBe(2);
    expect(readFileDailyBars(database)).toEqual([dailyBar("2026-02-26", 98), { ...dailyBar("2026-02-27", 99), impliedVolatility: null }, dailyBar("2026-03-02", 100), dailyBar("2026-03-03", 101)]);
    expect(readFileIntradayPrices(database, "2026-03-01", "2026-03-31")!.priceAt("2026-03-03", "10:00")).toBe(100.5);
    expect(metaValue(database, "ibkr_bars_fetched_at")).toBe("2026-10-14T01:00:00.000Z");
    expect(addOlderFileDailyBars(database, [dailyBar("2026-02-27", 99)])).toBe(0);
  });

  it("adds no older daily bars to a file without daily bars", () => {
    expect(() => addOlderFileDailyBars(database, [dailyBar("2026-02-26", 98)])).toThrow("The file has no IBKR daily bars to add older ones before: Update it first.");
  });

  it("reads the closes from a date on, the extent of every bar and their version, to check a tail against", () => {
    expect(readFileStockBarsTail(database, "2026-03-03")).toBeNull();
    expect(summarizeFileStockBars(database)).toBeNull();
    writeFileStockBars(database, first);
    expect(readFileStockBarsTail(database, "2026-03-03")).toEqual({
      version: "1",
      dailyFirstDate: "2026-03-02",
      dailyLastDate: "2026-03-03",
      intradayFirstDate: "2026-03-02",
      intradayLastDate: "2026-03-03",
      dailyCloseByDate: new Map([["2026-03-03", 101]]),
      intradayCloseByKey: new Map([[intradayBarKey("2026-03-03", 570), 100.5]]),
    });
  });
});

describe("the stock's price at a look", () => {
  // Monday 2 March: the 09:30 bar closes at 99.5, the 10:00 bar at 99.8, the 15:30 bar (the last) at 100.
  const prices = new FileIntradayPrices([
    { tradingDate: "2026-03-02", startMinutesEt: 600, close: 99.8 },
    { tradingDate: "2026-03-02", startMinutesEt: 570, close: 99.5 },
    { tradingDate: "2026-03-02", startMinutesEt: 930, close: 100 },
    { tradingDate: "2026-03-03", startMinutesEt: 570, close: null },
    { tradingDate: "2026-03-04", startMinutesEt: 570, close: 0 },
  ]);

  it("is the close of the last bar ending by the look: 10:00 reads the 09:30 bar", () => {
    expect(prices.priceAt("2026-03-02", "10:00")).toBe(99.5);
    expect(prices.priceAt("2026-03-02", "10:15")).toBe(99.5);
    expect(prices.priceAt("2026-03-02", "10:30")).toBe(99.8);
    expect(prices.priceAt("2026-03-02", "15:30")).toBe(99.8);
    expect(prices.priceAt("2026-03-02", "16:00")).toBe(100);
  });

  it("is unknown before the day's first bar ends, on a day without bars, and from a bar without a positive close", () => {
    expect(prices.priceAt("2026-03-02", "09:45")).toBeNull();
    expect(prices.priceAt("2026-03-05", "10:00")).toBeNull();
    expect(prices.priceAt("2026-03-03", "10:00")).toBeNull();
    expect(prices.priceAt("2026-03-04", "10:00")).toBeNull();
  });

  it("knows the last day it can price", () => {
    expect(prices.lastDate).toBe("2026-03-02");
    expect(new FileIntradayPrices([]).lastDate).toBeNull();
  });
});
