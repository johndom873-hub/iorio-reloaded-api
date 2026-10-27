import { describe, expect, it } from "vitest";
import { earningsNextDateDoubt, earningsNextDateMaxGapDays, earningsNextDateMissingAfterDays, isEtfSector, tickerCalendarProfile } from "./tickerCalendarRelevance.js";

describe("isEtfSector", () => {
  it("is true only for IBKR's literal ETF sector", () => {
    expect(isEtfSector("ETF")).toBe(true);
    expect(isEtfSector("Technology")).toBe(false);
    expect(isEtfSector("etf")).toBe(false);
    expect(isEtfSector(null)).toBe(false);
    expect(isEtfSector(undefined)).toBe(false);
  });
});

describe("tickerCalendarProfile", () => {
  it("an ETF: no calendar checks, earnings resolved without a TradingView symbol", () => {
    expect(tickerCalendarProfile({ tradingview_ticker: null, sector: "ETF" })).toEqual({ calendarChecksApply: false, earningsCalendarResolved: true });
    expect(tickerCalendarProfile({ tradingview_ticker: "NASDAQ:TLT", sector: "ETF" })).toEqual({ calendarChecksApply: false, earningsCalendarResolved: true });
  });

  it("a stock: checks apply, resolved only with a TradingView symbol", () => {
    expect(tickerCalendarProfile({ tradingview_ticker: "NASDAQ:AAPL", sector: "Technology" })).toEqual({ calendarChecksApply: true, earningsCalendarResolved: true });
    expect(tickerCalendarProfile({ tradingview_ticker: null, sector: "Technology" })).toEqual({ calendarChecksApply: true, earningsCalendarResolved: false });
    expect(tickerCalendarProfile({ tradingview_ticker: "", sector: null })).toEqual({ calendarChecksApply: true, earningsCalendarResolved: false });
  });

  it("no ticker row: checks apply and the calendar is unresolved", () => {
    expect(tickerCalendarProfile(undefined)).toEqual({ calendarChecksApply: true, earningsCalendarResolved: false });
  });
});

describe("earningsNextDateDoubt", () => {
  it("uses the approved limits", () => {
    expect(earningsNextDateMaxGapDays).toBe(150);
    expect(earningsNextDateMissingAfterDays).toBe(60);
  });

  it("doubts a next date more than 150 days after the last report (NBIS 2026-08-12 → 2027-02-16 = 188), across a year end", () => {
    expect(earningsNextDateDoubt("2026-08-12", "2027-02-16", "2026-10-27")).toBe("too_far");
    expect(earningsNextDateDoubt("2026-10-20", "2027-03-19", "2026-10-27")).toBeNull(); // 150 days
    expect(earningsNextDateDoubt("2026-10-20", "2027-03-20", "2026-10-27")).toBe("too_far"); // 151
  });

  it("doubts no next date only once the last report is more than 60 days old", () => {
    expect(earningsNextDateDoubt("2026-08-12", null, "2026-10-27")).toBe("missing"); // 76 days
    expect(earningsNextDateDoubt("2026-08-28", null, "2026-10-27")).toBeNull(); // 60
    expect(earningsNextDateDoubt("2026-08-27", null, "2026-10-27")).toBe("missing"); // 61
    expect(earningsNextDateDoubt("2026-10-13", null, "2026-10-27")).toBeNull(); // GS, just reported
  });

  it("has nothing to judge with no report on record", () => {
    expect(earningsNextDateDoubt(null, null, "2026-10-27")).toBeNull();
    expect(earningsNextDateDoubt(null, "2027-06-01", "2026-10-27")).toBeNull();
  });
});
