import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toMarketIndexDailyBars } from "../fetchMarketIndexDailyBars.js";
import { loadMarketIndexCloses, MarketIndexCloses, marketIndexBarsFileCovers, readMarketIndexBarsFile, summarizeMarketIndexFiles, writeMarketIndexBarsFile, type MarketIndexBarsFile, type MarketIndexDailyBar } from "./marketIndexDailyBars.js";

const directory = mkdtempSync(path.join(tmpdir(), "backtest-market-index-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bar = (dateIso: string, close: number): MarketIndexDailyBar => ({ dateIso, open: close, high: close, low: close, close });
const vixFile = (bars: MarketIndexDailyBar[], lastFinishedSessionIso: string): MarketIndexBarsFile => ({ symbol: "VIX", fetchedAtIso: "2026-11-02T00:00:00Z", lastFinishedSessionIso, bars });

describe("MarketIndexCloses.closeBefore", () => {
  const closes = new MarketIndexCloses("VIX", [bar("2026-03-05", 20), bar("2026-03-06", 22), bar("2026-03-09", 25)]);

  it("returns the close of the last session strictly before the day, never the day's own", () => {
    expect(closes.closeBefore("2026-03-09")).toEqual({ dateIso: "2026-03-06", close: 22 });
    expect(closes.closeBefore("2026-03-06")).toEqual({ dateIso: "2026-03-05", close: 20 });
  });

  it("skips weekends and returns the last close after the series ends", () => {
    expect(closes.closeBefore("2026-03-08")).toEqual({ dateIso: "2026-03-06", close: 22 });
    expect(closes.closeBefore("2026-03-20")).toEqual({ dateIso: "2026-03-09", close: 25 });
  });

  it("is null on or before the first session", () => {
    expect(closes.closeBefore("2026-03-05")).toBeNull();
    expect(closes.closeBefore("2026-01-01")).toBeNull();
  });
});

describe("marketIndexBarsFileCovers", () => {
  const file = vixFile([bar("2015-11-06", 14.33), bar("2026-10-30", 17)], "2026-10-30");

  it("covers a session whose day before each day is in the file, a Monday after a Friday fetch included", () => {
    expect(marketIndexBarsFileCovers(file, "2016-01-04", "2026-10-30")).toBe(true);
    expect(marketIndexBarsFileCovers(file, "2016-01-04", "2026-11-02")).toBe(true);
  });

  it("is stale for a session reaching past the day after the last finished session", () => {
    expect(marketIndexBarsFileCovers(file, "2016-01-04", "2026-11-03")).toBe(false);
  });

  it("does not cover a session starting on or before the first bar (no close before it)", () => {
    expect(marketIndexBarsFileCovers(file, "2015-11-06", "2026-10-30")).toBe(false);
    expect(marketIndexBarsFileCovers(vixFile([], "2026-10-30"), "2016-01-04", "2026-10-30")).toBe(false);
  });
});

describe("toMarketIndexDailyBars", () => {
  const priceBar = (dateIso: string, close: number) => ({ time: Date.parse(`${dateIso}T00:00:00Z`) / 1000, open: close, high: close, low: close, close, volume: 0 });

  it("keeps finished sessions from 2015 on, ascending, dropping the session still in progress", () => {
    const bars = toMarketIndexDailyBars([priceBar("2026-11-02", 19.08), priceBar("2014-12-31", 19.2), priceBar("2026-10-30", 17.44), priceBar("2015-01-02", 17.79)], "2026-10-30");
    expect(bars.map((kept) => kept.dateIso)).toEqual(["2015-01-02", "2026-10-30"]);
    expect(bars[1]).toEqual({ dateIso: "2026-10-30", open: 17.44, high: 17.44, low: 17.44, close: 17.44 });
  });
});

describe("loadMarketIndexCloses", () => {
  it("names the command to run when the file is missing or stale, and serves it when it covers the session", () => {
    expect(() => loadMarketIndexCloses(directory, "VIX3M", "2020-01-02", "2026-10-30")).toThrow(/no VIX3M file \(ibkr-VIX3M\.json\): run npm run backtest:fetch-market-indices/);
    writeMarketIndexBarsFile(directory, vixFile([bar("2015-11-06", 14.33), bar("2026-10-30", 17)], "2026-10-30"));
    expect(readMarketIndexBarsFile(directory, "VIX")?.bars).toHaveLength(2);
    expect(() => loadMarketIndexCloses(directory, "VIX", "2020-01-02", "2026-11-10")).toThrow(/covers 2015-11-06 to 2026-10-30, not the closes before 2020-01-02 to 2026-11-10: run npm run backtest:fetch-market-indices/);
    expect(loadMarketIndexCloses(directory, "VIX", "2020-01-02", "2026-10-30").closeBefore("2026-10-30")).toEqual({ dateIso: "2015-11-06", close: 14.33 });
  });
});

describe("summarizeMarketIndexFiles", () => {
  it("is null while either file is missing, then gives the days both hold and the older fetch", () => {
    const summaryDirectory = mkdtempSync(path.join(tmpdir(), "backtest-market-index-summary-"));
    try {
      writeMarketIndexBarsFile(summaryDirectory, { symbol: "VIX", fetchedAtIso: "2026-11-02T08:37:10Z", lastFinishedSessionIso: "2026-10-30", bars: [bar("2015-01-02", 17.79), bar("2026-10-30", 17.44)] });
      expect(summarizeMarketIndexFiles(summaryDirectory)).toBeNull();
      writeMarketIndexBarsFile(summaryDirectory, { symbol: "VIX3M", fetchedAtIso: "2026-11-01T08:00:00Z", lastFinishedSessionIso: "2026-10-29", bars: [bar("2015-01-05", 19), bar("2026-10-29", 20.78)] });
      expect(summarizeMarketIndexFiles(summaryDirectory)).toEqual({ firstDateIso: "2015-01-05", lastDateIso: "2026-10-29", fetchedAtIso: "2026-11-01T08:00:00Z" });
    } finally {
      rmSync(summaryDirectory, { recursive: true, force: true });
    }
  });
});
