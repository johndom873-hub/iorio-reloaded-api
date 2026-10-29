import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WhatToShow } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import type { PriceBar } from "../ibkr/fetchTickerOverview.js";
import { addCalendarDays } from "../lib/calendarDays.js";
import { easternInstant } from "../lib/easternIsoDate.js";
import { intradayBarKey, type FileIntradayBar, type StoredFileStockBarsTail } from "./backtestFileStockBars.js";
import { optionsStartBeforeStockPrices, reasonDailyBarsDiffer, reasonTailDiffers, reasonToFetchEveryBar, refreshFileStockBars, type FileStockBarsRefreshOptions } from "./refreshFileStockBars.js";

const fetchHistoricalBarsRaw = vi.hoisted(() => vi.fn());
vi.mock("../ibkr/fetchTickerOverview.js", () => ({ fetchHistoricalBarsRaw }));

describe("optionsStartBeforeStockPrices", () => {
  it("flags a file whose options start more than 14 days before IBKR's first daily bar", () => {
    // SPCX: the old ETF's options from 2021, SpaceX's stock prices from 12 June 2026.
    expect(optionsStartBeforeStockPrices("SPCX", "2021-01-12", "2026-06-12")).toMatch(/options start 2021-01-12 but IBKR's SPCX stock prices start 2026-06-12.*download it from 2026-06-12/);
    expect(optionsStartBeforeStockPrices("NEW", "2026-05-28", "2026-06-12")).not.toBeNull();
  });

  it("accepts options listed after the stock, a few days' gap in IBKR's history, and a stock older than its options", () => {
    // SpaceX's own options from 16 June, four days after its first bar.
    expect(optionsStartBeforeStockPrices("SPCX", "2026-06-16", "2026-06-12")).toBeNull();
    expect(optionsStartBeforeStockPrices("NEW", "2026-05-29", "2026-06-12")).toBeNull();
    expect(optionsStartBeforeStockPrices("HOOD", "2021-08-04", "2021-07-29")).toBeNull();
    expect(optionsStartBeforeStockPrices("AAPL", "2020-01-02", "2006-10-19")).toBeNull();
  });
});

const storedTail = (overrides: Partial<StoredFileStockBarsTail> = {}): StoredFileStockBarsTail => ({
  version: "1",
  dailyFirstDate: "2006-10-30",
  dailyLastDate: "2026-10-23",
  intradayFirstDate: "2020-01-02",
  intradayLastDate: "2026-10-23",
  dailyCloseByDate: new Map([
    ["2026-10-22", 100.12],
    ["2026-10-23", 101.5],
  ]),
  intradayCloseByKey: new Map([[intradayBarKey("2026-10-23", 570), 100.75]]),
  ...overrides,
});

describe("whether the file's bars can take the last month", () => {
  it("can when they are this version, cover the options' first year and end at most 14 days before the last session", () => {
    expect(reasonToFetchEveryBar(storedTail(), "2020-03-02", "2026-10-26")).toBeNull();
    expect(reasonToFetchEveryBar(storedTail({ dailyLastDate: "2026-10-12", intradayLastDate: "2026-10-12" }), "2020-03-02", "2026-10-26")).toBeNull();
  });

  it("cannot without bars, from another version, with options older than the 30-minute bars, or with bars ending over 14 days back", () => {
    expect(reasonToFetchEveryBar(null, "2020-03-02", "2026-10-26")).toBe("the file has no IBKR bars yet");
    expect(reasonToFetchEveryBar(storedTail({ version: null }), "2020-03-02", "2026-10-26")).toBe("its bars are version unknown, not 1");
    expect(reasonToFetchEveryBar(storedTail(), "2019-11-01", "2026-10-26")).toBe("its options start 2019-11-01, before its 30-minute bars (2020-01-02)");
    // Friday 9 October to Monday 26 October is 17 days.
    expect(reasonToFetchEveryBar(storedTail({ intradayLastDate: "2026-10-09" }), "2020-03-02", "2026-10-26")).toBe("its bars end 2026-10-09, more than 14 days before 2026-10-26");
  });
});

describe("whether the last month agrees with the file's bars", () => {
  const dailyBar = (tradingDate: string, close: number) => ({ tradingDate, open: close, high: close, low: close, close, volume: 1_000, impliedVolatility: 0.4 });
  const intradayBar = (dateIso: string, close: number): FileIntradayBar => ({ barStart: easternInstant(dateIso, 9, 30), open: close, high: close, low: close, close, volume: 100 });

  it("agrees when every shared close is the same to the cent, whatever IBKR sends for the new days", () => {
    expect(reasonTailDiffers(storedTail(), [dailyBar("2026-10-22", 100.1249), dailyBar("2026-10-23", 101.5), dailyBar("2026-10-26", 250)], [intradayBar("2026-10-23", 100.75), intradayBar("2026-10-26", 9)])).toBeNull();
  });

  it("differs after a split, which rescales every shared close, and on a one-cent change", () => {
    expect(reasonTailDiffers(storedTail(), [dailyBar("2026-10-22", 50.06), dailyBar("2026-10-23", 50.75)], [intradayBar("2026-10-23", 50.375)])).toBe(
      "IBKR's prices changed on 2 of 2 shared days and 1 of 1 shared 30-minute bars (2026-10-22 close 100.12 stored, 50.06 now): a split or other adjustment since the last fetch",
    );
    expect(reasonTailDiffers(storedTail(), [dailyBar("2026-10-23", 101.5)], [intradayBar("2026-10-23", 100.76)])).toMatch(/^IBKR's prices changed on 0 of 1 shared days and 1 of 1 shared 30-minute bars \(2026-10-23 570 minutes ET close 100.75 stored, 100.76 now\)/);
    expect(reasonTailDiffers(storedTail(), [{ ...dailyBar("2026-10-23", 101.5), close: null }], [intradayBar("2026-10-23", 100.75)])).toMatch(/changed on 1 of 1 shared days/);
  });

  it("differs when it shares no daily or no 30-minute bar with the file", () => {
    expect(reasonTailDiffers(storedTail(), [dailyBar("2026-10-26", 102)], [intradayBar("2026-10-23", 100.75)])).toBe("IBKR's last month shares no bar with the file's");
    expect(reasonTailDiffers(storedTail(), [dailyBar("2026-10-23", 101.5)], [intradayBar("2026-10-26", 100.75)])).toBe("IBKR's last month shares no bar with the file's");
  });
});

describe("whether IBKR's daily bars from 2000 agree with the file's", () => {
  const dailyBar = (tradingDate: string, close: number) => ({ tradingDate, open: close, high: close, low: close, close, volume: 1_000, impliedVolatility: 0.4 });
  const storedCloseByDate = new Map<string, number | null>([
    ["2006-11-01", 50.12],
    ["2026-10-23", 101.5],
  ]);

  it("agree when every shared close is the same to the cent, whatever IBKR sends for the older days", () => {
    expect(reasonDailyBarsDiffer(storedCloseByDate, [dailyBar("2000-01-03", 20), dailyBar("2006-11-01", 50.1249), dailyBar("2026-10-23", 101.5)])).toBeNull();
  });

  it("differ after a split, which rescales every shared close, on a one-cent change, and when they share no day", () => {
    expect(reasonDailyBarsDiffer(storedCloseByDate, [dailyBar("2006-11-01", 25.06), dailyBar("2026-10-23", 50.75)])).toBe(
      "IBKR's prices changed on 2 of 2 shared days (2006-11-01 close 50.12 stored, 25.06 now): a split or other adjustment since the last fetch",
    );
    expect(reasonDailyBarsDiffer(storedCloseByDate, [dailyBar("2006-11-01", 50.12), dailyBar("2026-10-23", 101.51)])).toMatch(/^IBKR's prices changed on 1 of 2 shared days \(2026-10-23 close 101.5 stored, 101.51 now\)/);
    expect(reasonDailyBarsDiffer(storedCloseByDate, [dailyBar("2000-01-03", 20)])).toBe("IBKR's daily bars share no day with the file's");
  });
});

describe("refreshing a data file's IBKR bars", () => {
  // IBKR's history in this test: every weekday of 2026 to Monday 26 October, two 30-minute bars a day (09:30 and 15:30).
  // With `ibkrHoldsOlderDays` it also holds the weekdays of the second half of 2025 (daily bars only), and with
  // `ibkrSendsDayBefore2000` a daily bar on 31 December 1999, as a whole-year duration reaching 2000 brings.
  const weekdaysBetween = (from: string, to: string) => {
    const dates: string[] = [];
    for (let date = from; date <= to; date = addCalendarDays(date, 1)) if (![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) dates.push(date);
    return dates;
  };
  const historyDates = weekdaysBetween("2026-01-02", "2026-10-26");
  const olderDates = weekdaysBetween("2025-07-01", "2025-12-31");
  const now = new Date("2026-10-27T03:00:00Z");
  let priceScale = 1;
  let ibkrHoldsOlderDays = false;
  let ibkrSendsDayBefore2000 = false;
  const closeOn = (index: number) => Math.round((100 + index * 0.37) * 100) / 100;
  const olderCloseOn = (index: number) => Math.round((60 + index * 0.25) * 100) / 100;
  const dailyBarOn = (date: string, close: number): PriceBar => ({ time: Date.parse(`${date}T00:00:00Z`) / 1000, open: close, high: close, low: close, close, volume: 1_000 });
  const dailyHistory = (): PriceBar[] => [
    ...(ibkrSendsDayBefore2000 ? [dailyBarOn("1999-12-31", 40 * priceScale)] : []),
    ...(ibkrHoldsOlderDays ? olderDates.map((date, index) => dailyBarOn(date, olderCloseOn(index) * priceScale)) : []),
    ...historyDates.map((date, index) => dailyBarOn(date, closeOn(index) * priceScale)),
  ];
  const intradayHistory = (): PriceBar[] =>
    historyDates.flatMap((date, index) =>
      [
        [9, 30, closeOn(index) - 0.25],
        [15, 30, closeOn(index)],
      ].map(([hour, minute, close]) => ({ time: easternInstant(date, hour!, minute!).getTime() / 1000, open: close! * priceScale, high: close! * priceScale, low: close! * priceScale, close: close! * priceScale, volume: 100 })),
    );
  /** IBKR as this test sees it: "1 M" is the last 30 days, "N Y" the N years up to endDateTime. */
  const fakeIbkr = (_connection: unknown, _symbol: string, barSize: string, duration: string, _requestId: number, whatToShow: WhatToShow, options: { endDateTime?: string } = {}) => {
    const bars = barSize === "30 mins" ? intradayHistory() : dailyHistory().map((bar) => (whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY ? { ...bar, close: 0.4 } : bar));
    const end = options.endDateTime ? Date.parse(`${options.endDateTime.slice(0, 4)}-${options.endDateTime.slice(4, 6)}-${options.endDateTime.slice(6, 8)}T${options.endDateTime.slice(9)}Z`) : now.getTime();
    const days = duration === "1 M" ? 30 : Number.parseInt(duration, 10) * 366;
    return Promise.resolve(bars.filter((bar) => bar.time * 1000 <= end && bar.time * 1000 > end - days * 86_400_000));
  };

  let directory: string;
  let previousDataDirectory: string | undefined;
  let requestLabels: string[];
  const refresh = (lastDateToStore: string, more: Partial<FileStockBarsRefreshOptions> = {}) => {
    requestLabels = [];
    let requestId = 1;
    return refreshFileStockBars({} as IbkrConnection, "TEST", { firstOptionDay: "2026-01-05", lastDateToStore, nextRequestId: () => requestId++, pause: async () => {}, onRequest: (label) => requestLabels.push(label), now, ...more });
  };
  const storedDailyCloses = () => {
    const database = new DatabaseSync(path.join(directory, "TEST.sqlite"), { readOnly: true });
    try {
      return database.prepare("SELECT trading_date AS tradingDate, close FROM ibkr_daily_bars ORDER BY trading_date").all() as { tradingDate: string; close: number }[];
    } finally {
      database.close();
    }
  };

  beforeEach(() => {
    priceScale = 1;
    ibkrHoldsOlderDays = false;
    ibkrSendsDayBefore2000 = false;
    fetchHistoricalBarsRaw.mockReset().mockImplementation(fakeIbkr);
    directory = mkdtempSync(path.join(tmpdir(), "file-stock-bars-"));
    previousDataDirectory = process.env.BACKTEST_DATA_DIR;
    process.env.BACKTEST_DATA_DIR = directory;
    const database = new DatabaseSync(path.join(directory, "TEST.sqlite"));
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.close();
  });

  afterEach(() => {
    if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
    else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
    rmSync(directory, { recursive: true, force: true });
  });

  it("fetches every bar for a file without any, then adds only the last month on the next Update", async () => {
    const first = await refresh("2026-10-16");
    expect(first).toMatchObject({ kind: "full", fullRefreshReason: "the file has no IBKR bars yet", dailyLastDate: "2026-10-16", intradayFirstDate: "2026-01-02" });
    expect(requestLabels).toEqual(["IBKR daily bars, from 2000-01-01", "IBKR implied volatility, from 2000-01-01", "IBKR 30-minute bars, 2026"]);

    const second = await refresh("2026-10-26");
    expect(second).toMatchObject({ kind: "tail", fullRefreshReason: null, dailyBars: historyDates.length, dailyFirstDate: "2026-01-02", dailyLastDate: "2026-10-26", impliedVolatilityDays: historyDates.length, intradayBars: 2 * historyDates.length, intradayLastDate: "2026-10-26" });
    expect(requestLabels).toEqual(["IBKR daily bars, last month", "IBKR implied volatility, last month", "IBKR 30-minute bars, last month"]);
    expect(storedDailyCloses()).toEqual(dailyHistory().map((bar, index) => ({ tradingDate: historyDates[index], close: bar.close })));
  });

  it("fetches every bar again when the last month's prices show a split, so the file never mixes two adjustments", async () => {
    await refresh("2026-10-16");
    priceScale = 0.5;
    const result = await refresh("2026-10-26");
    expect(result.kind).toBe("full");
    expect(result.fullRefreshReason).toMatch(/^IBKR's prices changed on 15 of 15 shared days and 30 of 30 shared 30-minute bars .*: a split or other adjustment since the last fetch$/);
    expect(requestLabels).toEqual(["IBKR daily bars, last month", "IBKR implied volatility, last month", "IBKR 30-minute bars, last month", "IBKR daily bars, from 2000-01-01", "IBKR implied volatility, from 2000-01-01", "IBKR 30-minute bars, 2026"]);
    expect(storedDailyCloses()).toEqual(dailyHistory().map((bar, index) => ({ tradingDate: historyDates[index], close: bar.close })));
    expect(storedDailyCloses()[0]!.close).toBe(50);
  });

  it("fetches every bar without asking for the last month when the file's bars end more than 14 days back", async () => {
    await refresh("2026-09-30");
    const result = await refresh("2026-10-26");
    expect(result).toMatchObject({ kind: "full", fullRefreshReason: "its bars end 2026-09-30, more than 14 days before 2026-10-26" });
    expect(requestLabels).toEqual(["IBKR daily bars, from 2000-01-01", "IBKR implied volatility, from 2000-01-01", "IBKR 30-minute bars, 2026"]);
  });

  it("keeps the stored implied volatility when the last month's request for it fails", async () => {
    await refresh("2026-10-16");
    fetchHistoricalBarsRaw.mockImplementation((...args: Parameters<typeof fakeIbkr>) => (args[5] === WhatToShow.OPTION_IMPLIED_VOLATILITY ? Promise.reject(new Error("Historical data timeout for TEST")) : fakeIbkr(...args)));
    const result = await refresh("2026-10-26");
    expect(result).toMatchObject({ kind: "tail", impliedVolatilityError: "Historical data timeout for TEST", dailyBars: historyDates.length, impliedVolatilityDays: historyDates.indexOf("2026-10-16") + 1 });
  });

  it("adds IBKR's older daily bars before the file's first one when every day both have closes the same, keeping every stored bar", async () => {
    await refresh("2026-10-26");
    const storedBefore = storedDailyCloses();
    ibkrHoldsOlderDays = true;
    const result = await refresh("2026-10-26", { extendDailyBarsBack: true });
    expect(result).toMatchObject({
      kind: "older_daily_bars",
      fullRefreshReason: null,
      dailyBars: olderDates.length + historyDates.length,
      dailyFirstDate: "2025-07-01",
      dailyLastDate: "2026-10-26",
      impliedVolatilityDays: olderDates.length + historyDates.length,
      intradayBars: 2 * historyDates.length,
      intradayFirstDate: "2026-01-02",
    });
    expect(requestLabels).toEqual(["IBKR daily bars, from 2000-01-01", "IBKR implied volatility, from 2000-01-01"]);
    expect(storedDailyCloses().slice(olderDates.length)).toEqual(storedBefore);
    expect(storedDailyCloses()[0]).toEqual({ tradingDate: "2025-07-01", close: 60 });
  });

  it("fetches every bar again, with the daily bars it already fetched, when IBKR's prices changed since the file's were fetched", async () => {
    await refresh("2026-10-26");
    ibkrHoldsOlderDays = true;
    priceScale = 0.5;
    const result = await refresh("2026-10-26", { extendDailyBarsBack: true });
    expect(result).toMatchObject({
      kind: "full",
      fullRefreshReason: `IBKR's prices changed on ${historyDates.length} of ${historyDates.length} shared days (2026-01-02 close 100 stored, 50 now): a split or other adjustment since the last fetch`,
      dailyFirstDate: "2025-07-01",
    });
    expect(requestLabels).toEqual(["IBKR daily bars, from 2000-01-01", "IBKR implied volatility, from 2000-01-01", "IBKR 30-minute bars, 2026"]);
    expect(storedDailyCloses()[0]).toEqual({ tradingDate: "2025-07-01", close: 30 });
    expect(storedDailyCloses()[olderDates.length]).toEqual({ tradingDate: "2026-01-02", close: 50 });
  });

  it("adds nothing when IBKR holds no older day, and never stores a bar before 2000-01-01", async () => {
    ibkrSendsDayBefore2000 = true;
    expect(await refresh("2026-10-26")).toMatchObject({ kind: "full", dailyBars: historyDates.length, dailyFirstDate: "2026-01-02" });
    expect(await refresh("2026-10-26", { extendDailyBarsBack: true })).toMatchObject({ kind: "older_daily_bars", dailyBars: historyDates.length, dailyFirstDate: "2026-01-02" });
  });

  it("writes no older bars when their implied-volatility request fails, so a later run adds both", async () => {
    await refresh("2026-10-26");
    ibkrHoldsOlderDays = true;
    fetchHistoricalBarsRaw.mockImplementation((...args: Parameters<typeof fakeIbkr>) => (args[5] === WhatToShow.OPTION_IMPLIED_VOLATILITY ? Promise.reject(new Error("Historical data timeout for TEST")) : fakeIbkr(...args)));
    await expect(refresh("2026-10-26", { extendDailyBarsBack: true })).rejects.toThrow("IBKR's implied volatility request failed (Historical data timeout for TEST): no older daily bars written.");
    expect(storedDailyCloses()[0]!.tradingDate).toBe("2026-01-02");
  });
});
