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
import { optionsStartBeforeStockPrices, reasonTailDiffers, reasonToFetchEveryBar, refreshFileStockBars } from "./refreshFileStockBars.js";

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

describe("refreshing a data file's IBKR bars", () => {
  // IBKR's history in this test: every weekday of 2026 to Monday 26 October, two 30-minute bars a day (09:30 and 15:30).
  const historyDates: string[] = [];
  for (let date = "2026-01-02"; date <= "2026-10-26"; date = addCalendarDays(date, 1)) if (![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) historyDates.push(date);
  const now = new Date("2026-10-27T03:00:00Z");
  let priceScale = 1;
  const closeOn = (index: number) => Math.round((100 + index * 0.37) * 100) / 100;
  const dailyHistory = (): PriceBar[] => historyDates.map((date, index) => ({ time: Date.parse(`${date}T00:00:00Z`) / 1000, open: closeOn(index) * priceScale, high: closeOn(index) * priceScale, low: closeOn(index) * priceScale, close: closeOn(index) * priceScale, volume: 1_000 }));
  const intradayHistory = (): PriceBar[] =>
    historyDates.flatMap((date, index) =>
      [
        [9, 30, closeOn(index) - 0.25],
        [15, 30, closeOn(index)],
      ].map(([hour, minute, close]) => ({ time: easternInstant(date, hour!, minute!).getTime() / 1000, open: close! * priceScale, high: close! * priceScale, low: close! * priceScale, close: close! * priceScale, volume: 100 })),
    );
  /** IBKR as this test sees it: "1 M" is the last 30 days, "1 Y" the year up to endDateTime, "20 Y" everything. */
  const fakeIbkr = (_connection: unknown, _symbol: string, barSize: string, duration: string, _requestId: number, whatToShow: WhatToShow, options: { endDateTime?: string } = {}) => {
    const bars = barSize === "30 mins" ? intradayHistory() : dailyHistory().map((bar) => (whatToShow === WhatToShow.OPTION_IMPLIED_VOLATILITY ? { ...bar, close: 0.4 } : bar));
    const end = options.endDateTime ? Date.parse(`${options.endDateTime.slice(0, 4)}-${options.endDateTime.slice(4, 6)}-${options.endDateTime.slice(6, 8)}T${options.endDateTime.slice(9)}Z`) : now.getTime();
    const days = duration === "1 M" ? 30 : duration === "1 Y" ? 366 : 20 * 366;
    return Promise.resolve(bars.filter((bar) => bar.time * 1000 <= end && bar.time * 1000 > end - days * 86_400_000));
  };

  let directory: string;
  let previousDataDirectory: string | undefined;
  let requestLabels: string[];
  const refresh = (lastDateToStore: string) => {
    requestLabels = [];
    let requestId = 1;
    return refreshFileStockBars({} as IbkrConnection, "TEST", { firstOptionDay: "2026-01-05", lastDateToStore, nextRequestId: () => requestId++, pause: async () => {}, onRequest: (label) => requestLabels.push(label), now });
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
    expect(requestLabels).toEqual(["IBKR daily bars, 20 years", "IBKR implied volatility, 20 years", "IBKR 30-minute bars, 2026"]);

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
    expect(requestLabels).toEqual(["IBKR daily bars, last month", "IBKR implied volatility, last month", "IBKR 30-minute bars, last month", "IBKR daily bars, 20 years", "IBKR implied volatility, 20 years", "IBKR 30-minute bars, 2026"]);
    expect(storedDailyCloses()).toEqual(dailyHistory().map((bar, index) => ({ tradingDate: historyDates[index], close: bar.close })));
    expect(storedDailyCloses()[0]!.close).toBe(50);
  });

  it("fetches every bar without asking for the last month when the file's bars end more than 14 days back", async () => {
    await refresh("2026-09-30");
    const result = await refresh("2026-10-26");
    expect(result).toMatchObject({ kind: "full", fullRefreshReason: "its bars end 2026-09-30, more than 14 days before 2026-10-26" });
    expect(requestLabels).toEqual(["IBKR daily bars, 20 years", "IBKR implied volatility, 20 years", "IBKR 30-minute bars, 2026"]);
  });

  it("keeps the stored implied volatility when the last month's request for it fails", async () => {
    await refresh("2026-10-16");
    fetchHistoricalBarsRaw.mockImplementation((...args: Parameters<typeof fakeIbkr>) => (args[5] === WhatToShow.OPTION_IMPLIED_VOLATILITY ? Promise.reject(new Error("Historical data timeout for TEST")) : fakeIbkr(...args)));
    const result = await refresh("2026-10-26");
    expect(result).toMatchObject({ kind: "tail", impliedVolatilityError: "Historical data timeout for TEST", dailyBars: historyDates.length, impliedVolatilityDays: historyDates.indexOf("2026-10-16") + 1 });
  });
});
