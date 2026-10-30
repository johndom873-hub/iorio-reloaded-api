import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceBar } from "./fetchTickerOverview.js";

const mocks = vi.hoisted(() => ({ fetchHistoricalBarsRaw: vi.fn(), loadTradingSessionsBetween: vi.fn() }));

vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: vi.fn() }));
vi.mock("./fetchTickerOverview.js", () => ({ fetchHistoricalBarsRaw: mocks.fetchHistoricalBarsRaw }));
vi.mock("../lib/marketSessionStatus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/marketSessionStatus.js")>()),
  loadTradingSessionsBetween: mocks.loadTradingSessionsBetween,
}));
vi.mock("../db/connection.js", () => ({ db: vi.fn() }));

const { cachedExtendedHoursChartBars, clearExtendedHoursChartBarsCache, fetchExtendedHoursChartBars, isExtendedHoursChartRange, tagBarSessions } = await import(
  "./extendedHoursChartBars.js"
);

type Connection = Parameters<typeof fetchExtendedHoursChartBars>[0];
const connection = { ib: {}, disconnect: vi.fn() } as unknown as Connection;

function barAt(isoInstant: string, close = 25): PriceBar {
  return { time: Date.parse(isoInstant) / 1000, open: close, high: close, low: close, close, volume: 100 };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-30T01:00:00Z") });
  mocks.fetchHistoricalBarsRaw.mockReset();
  mocks.loadTradingSessionsBetween.mockReset();
  mocks.loadTradingSessionsBetween.mockResolvedValue([]);
  clearExtendedHoursChartBarsCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isExtendedHoursChartRange", () => {
  it("is true for 1D and 5D only", () => {
    expect(["1D", "5D", "1M", "3M", "6M", "1Y", "5Y", "All"].filter((range) => isExtendedHoursChartRange(range as never))).toEqual(["1D", "5D"]);
  });
});

describe("tagBarSessions", () => {
  // Thu 29 Oct 2026 is EDT (UTC-4): 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
  const thursday = { dateIso: "2026-10-29", closeMinutesEt: 960 };

  it("marks 09:30 up to 16:00 ET regular and the minutes either side extended", () => {
    const bars = ["2026-10-29T08:00:00Z", "2026-10-29T13:29:00Z", "2026-10-29T13:30:00Z", "2026-10-29T19:59:00Z", "2026-10-29T20:00:00Z", "2026-10-29T23:59:00Z"].map((at) => barAt(at));
    expect(tagBarSessions(bars, [thursday]).map((bar) => bar.session)).toEqual(["extended", "extended", "regular", "regular", "extended", "extended"]);
  });

  it("ends the regular session at a half day's 13:00 ET close (Fri 27 Nov: 12:59 regular, 13:00 extended)", () => {
    // 27 Nov is EST (UTC-5): 12:59 ET = 17:59 UTC.
    const bars = [barAt("2026-11-27T17:59:00Z"), barAt("2026-11-27T18:00:00Z")];
    expect(tagBarSessions(bars, [{ dateIso: "2026-11-27", closeMinutesEt: 780 }]).map((bar) => bar.session)).toEqual(["regular", "extended"]);
  });

  it("follows the clock change: on Mon 2 Nov (EST) the open is 14:30 UTC, so 13:30 UTC is pre-market", () => {
    const bars = [barAt("2026-11-02T13:30:00Z"), barAt("2026-11-02T14:29:00Z"), barAt("2026-11-02T14:30:00Z")];
    expect(tagBarSessions(bars, [{ dateIso: "2026-11-02", closeMinutesEt: 960 }]).map((bar) => bar.session)).toEqual(["extended", "extended", "regular"]);
  });

  it("marks every bar of a day with no open session extended", () => {
    expect(tagBarSessions([barAt("2026-10-29T15:00:00Z")], [])[0]!.session).toBe("extended");
  });

  it("keeps each bar's prices and time", () => {
    const bar = barAt("2026-10-29T15:00:00Z", 26.27);
    expect(tagBarSessions([bar], [thursday])).toEqual([{ ...bar, session: "regular" }]);
  });
});

describe("fetchExtendedHoursChartBars", () => {
  it.each([
    ["1D", BarSizeSetting.MINUTES_ONE, "2 D"],
    ["5D", BarSizeSetting.MINUTES_FIVE, "7 D"],
  ] as const)("asks IBKR for %s as %s bars over %s with extended hours", async (range, barSize, duration) => {
    mocks.fetchHistoricalBarsRaw.mockResolvedValue([barAt("2026-10-29T15:00:00Z")]);
    await fetchExtendedHoursChartBars(connection, "IREN", range, 41);
    expect(mocks.fetchHistoricalBarsRaw).toHaveBeenCalledWith(connection, "IREN", barSize, duration, 41, WhatToShow.TRADES, { includeExtendedHours: true });
  });

  it("loads the sessions from the first bar's Eastern date to the last one's (00:30 UTC on 30 Oct is still 29 Oct ET)", async () => {
    mocks.fetchHistoricalBarsRaw.mockResolvedValue([barAt("2026-10-28T08:00:00Z"), barAt("2026-10-30T00:30:00Z")]);
    mocks.loadTradingSessionsBetween.mockResolvedValue([{ dateIso: "2026-10-28", closeMinutesEt: 960 }, { dateIso: "2026-10-29", closeMinutesEt: 960 }]);
    const bars = await fetchExtendedHoursChartBars(connection, "IREN", "1D", 1);
    expect(mocks.loadTradingSessionsBetween).toHaveBeenCalledWith("2026-10-28", "2026-10-29");
    expect(bars.map((bar) => bar.session)).toEqual(["extended", "extended"]);
  });

  it("returns no bars without reading the calendar when IBKR returns none", async () => {
    mocks.fetchHistoricalBarsRaw.mockResolvedValue([]);
    expect(await fetchExtendedHoursChartBars(connection, "IREN", "5D", 1)).toEqual([]);
    expect(mocks.loadTradingSessionsBetween).not.toHaveBeenCalled();
  });
});

describe("cachedExtendedHoursChartBars", () => {
  it("reuses an answer for the same symbol and range for 30 seconds, then loads again", async () => {
    const load = vi.fn(async () => []);
    await cachedExtendedHoursChartBars("IREN", "1D", load);
    await cachedExtendedHoursChartBars("IREN", "1D", load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await cachedExtendedHoursChartBars("IREN", "1D", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps each symbol and range apart", async () => {
    const load = vi.fn(async () => []);
    await cachedExtendedHoursChartBars("IREN", "1D", load);
    await cachedExtendedHoursChartBars("IREN", "5D", load);
    await cachedExtendedHoursChartBars("NBIS", "1D", load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
