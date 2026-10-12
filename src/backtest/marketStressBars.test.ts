import { describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { ibkrEndDateTime, MarketStressPrices } from "./marketStressBars.js";

const bar = (dateIso: string, startsAt: string, close: number) => ({ barTime: easternInstant(dateIso, Number(startsAt.slice(0, 2)), Number(startsAt.slice(3))), close });

describe("SPY's change on the day at a look", () => {
  // Friday 27 February closes at 500 (its last bar); Monday 2 March: 495 at 10:00, 480 at 10:30, 505 at the close.
  const prices = new MarketStressPrices([bar("2026-03-02", "10:00", 480), bar("2026-02-27", "15:30", 500), bar("2026-02-27", "09:30", 498), bar("2026-03-02", "09:30", 495), bar("2026-03-02", "15:30", 505), bar("2026-03-03", "09:30", 510)]);

  it("is the close of the bar ending at the look against the last close of the session before", () => {
    expect(prices.dayChangePercentAt("2026-03-02", "10:00")).toBeCloseTo(-1, 10);
    expect(prices.dayChangePercentAt("2026-03-02", "10:30")).toBeCloseTo(-4, 10);
    // The session before a Monday is Friday; the one before Tuesday is Monday, at its own last bar.
    expect(prices.dayChangePercentAt("2026-03-03", "10:00")).toBeCloseTo((510 / 505 - 1) * 100, 10);
  });

  it("is unknown without a bar ending at the look, or without an earlier session", () => {
    expect(prices.dayChangePercentAt("2026-03-02", "11:00")).toBeNull();
    expect(prices.dayChangePercentAt("2026-02-27", "10:00")).toBeNull();
    expect(prices.dayChangePercentAt("2026-03-04", "10:00")).toBeNull();
    expect(new MarketStressPrices([]).dayChangePercentAt("2026-03-02", "10:00")).toBeNull();
  });

  it("knows the days it holds", () => {
    expect([prices.firstDate, prices.lastDate]).toEqual(["2026-02-27", "2026-03-03"]);
    expect(prices.hasDate("2026-03-02")).toBe(true);
    expect(prices.hasDate("2026-02-28")).toBe(false);
    expect(new MarketStressPrices([]).lastDate).toBeNull();
  });

  it("follows the Eastern clock across the change to summer time", () => {
    // 9 March 2026 is on summer time: the 09:30 ET bar starts at 13:30 UTC, not 14:30.
    const summer = new MarketStressPrices([{ barTime: new Date("2026-03-06T20:30:00Z"), close: 400 }, { barTime: new Date("2026-03-09T13:30:00Z"), close: 396 }]);
    expect(summer.dayChangePercentAt("2026-03-09", "10:00")).toBeCloseTo(-1, 10);
  });
});

describe("IBKR's end time of a historical request", () => {
  it("is the instant in UTC, yyyyMMdd-HH:mm:ss", () => {
    expect(ibkrEndDateTime(new Date("2021-01-01T06:00:00Z"))).toBe("20210101-06:00:00");
    expect(ibkrEndDateTime(new Date("2026-10-12T21:05:09.500Z"))).toBe("20261012-21:05:09");
  });
});
