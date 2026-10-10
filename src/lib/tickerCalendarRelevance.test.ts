import { describe, expect, it } from "vitest";
import { isEtfSector, tickerCalendarProfile } from "./tickerCalendarRelevance.js";

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
