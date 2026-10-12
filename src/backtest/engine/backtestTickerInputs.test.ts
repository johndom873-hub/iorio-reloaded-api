import { describe, expect, it } from "vitest";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import { computeParityStockPrice } from "./backtestBook.js";
import { buildHistoricalTickerInputs, earningsDateKnownCalendarDaysAhead, earningsNotYetReported, selectCapturedQuotes, type BacktestTickerProfile } from "./backtestTickerInputs.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween } from "./testSupport/syntheticBacktestData.js";

const todayIso = "2026-03-02";
const riskFreeRatePercent = 4;
const bars = new BacktestBarHistory(syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-02-27"), 100, 0.25, 7, 0.5));
const quotes = syntheticOptionQuotes(todayIso, 100, ["2026-03-06", "2026-03-13", "2026-03-20"], 0.6, riskFreeRatePercent / 100, 1, 15);
const stockPrice = computeParityStockPrice(quotes, todayIso, riskFreeRatePercent / 100, null)!.price;
const calendar = new BacktestTradingCalendar(weekdaysBetween("2026-03-02", "2026-03-31").map((tradingDate) => ({ tradingDate, status: "complete" as const })), []);
const profile: BacktestTickerProfile = { tickerId: "ticker-1", symbol: "SYN", companyName: "Synthetic Co", sector: "Technology", valuationGroup: "stock", calendarChecksApply: true, earningsCalendarResolved: true, earnings: [], exDividends: [] };
const volumes = new Map(quotes.map((quote) => [`${quote.expiry}|${quote.strike}|${quote.right}`, 1_000]));
const market = { todayIso, quotes, openInterestByContract: volumes, previousSessionVolumeByContract: volumes, stockPrice, riskFreeRatePercent };

describe("history inputs", () => {
  it("selects the contracts the live capture would request: out-of-the-money sides plus both sides within 3% of spot", () => {
    const captured = selectCapturedQuotes(quotes, todayIso, 100, 0.5);
    expect(captured.some((quote) => quote.right === "P" && quote.strike === 90)).toBe(true);
    expect(captured.some((quote) => quote.right === "C" && quote.strike === 90)).toBe(false);
    expect(captured.some((quote) => quote.right === "C" && quote.strike === 98)).toBe(true);
  });

  it("drops a report made before today's open from the earnings that still count", () => {
    expect(earningsNotYetReported([{ dateIso: "2026-03-02", eventTime: "-1" }, { dateIso: "2026-03-02", eventTime: null }, { dateIso: "2026-02-27", eventTime: "1" }], todayIso)).toEqual(["2026-03-02"]);
  });

  it("knows an earnings date from 30 calendar days before it: 30 days out it is seen, 31 days out it is not", () => {
    expect(earningsDateKnownCalendarDaysAhead).toBe(30);
    // 2 March + 30 days = 1 April; 2 March + 31 days = 2 April.
    const earnings = [{ dateIso: "2026-04-01", eventTime: "1" }, { dateIso: "2026-04-02", eventTime: "1" }];
    expect(earningsNotYetReported(earnings, todayIso)).toEqual(["2026-04-01"]);
    expect(earningsNotYetReported(earnings, "2026-03-01")).toEqual([]);
    expect(earningsNotYetReported(earnings, "2026-03-03")).toEqual(["2026-04-01", "2026-04-02"]);
    // The inputs Signals and Pluto read carry only the known date.
    const { inputs } = buildHistoricalTickerInputs({ profile: { ...profile, earnings }, bars, market, calendar });
    expect(inputs.earningsDatesIso).toEqual(["2026-04-01"]);
    expect(inputs.nextEarningsDateIso).toBe("2026-04-01");
    // A report 10 days out, inside the expiries the chain lists: the expiries after it are excluded, as live.
    const { inputs: nearReport } = buildHistoricalTickerInputs({ profile: { ...profile, earnings: [{ dateIso: "2026-03-12", eventTime: "1" }] }, bars, market, calendar });
    expect(nearReport.earningsDatesIso).toEqual(["2026-03-12"]);
  });

  it("fits the day's surface and builds the inputs with an empty book", () => {
    const { inputs, fitIssue } = buildHistoricalTickerInputs({ profile, bars, market, calendar });
    expect(fitIssue).toBeNull();
    expect(inputs.slices.map((slice) => slice.expiry)).toEqual(["2026-03-06", "2026-03-13", "2026-03-20"]);
    expect(inputs.header).toMatchObject({ tradingDateIso: todayIso, underlyingPrice: stockPrice, riskFreeRatePercent });
    expect(inputs.quotes.every((quote) => quote.source === "snapshot" && quote.openInterest === 1_000 && quote.volume === 1_000)).toBe(true);
    expect(inputs).toMatchObject({ freeShares: 0, openShortLegs: [], macroEvents: [], todayEasternIso: todayIso });
  });

  it("reports a day whose quotes cannot be fitted", () => {
    const { inputs, fitIssue } = buildHistoricalTickerInputs({ profile, bars, market: { ...market, riskFreeRatePercent: null }, calendar });
    expect(fitIssue).toBe("no_risk_free_rate");
    expect(inputs.slices).toEqual([]);
  });
});
