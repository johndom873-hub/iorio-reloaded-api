import { describe, expect, it } from "vitest";
import { volatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import { computeParityStockPrice, computeSaleFillPrice } from "./backtestBook.js";
import { decideBacktestDay, decisionInstantMs, earningsNotYetReported, selectCapturedQuotes, type BacktestBookView, type BacktestDayContext, type BacktestTickerProfile } from "./backtestDayDecision.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween } from "./testSupport/syntheticBacktestData.js";

const todayIso = "2026-03-02";
const riskFreeRatePercent = 4;
const bars = new BacktestBarHistory(syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-02-27"), 100, 0.25, 7, 0.5));
const quotes = syntheticOptionQuotes(todayIso, 100, ["2026-03-06", "2026-03-13", "2026-03-20"], 0.6, riskFreeRatePercent / 100, 1, 15);
const stockPrice = computeParityStockPrice(quotes, todayIso, riskFreeRatePercent / 100, null)!.price;
const sessionDays = weekdaysBetween("2026-03-02", "2026-03-31").map((tradingDate) => ({ tradingDate, status: "complete" as const }));
const calendar = new BacktestTradingCalendar(sessionDays, []);
const profile: BacktestTickerProfile = { tickerId: "ticker-1", symbol: "SYN", companyName: "Synthetic Co", sector: "Technology", valuationGroup: "stock", calendarChecksApply: true, earningsCalendarResolved: true, earnings: [], exDividends: [] };
const emptyBook: BacktestBookView = { netLiquidationValue: 1_000_000, cash: 1_000_000, freeCash: 1_000_000, cashLockedInPuts: 0, committedDollars: 0, markedExposureDollars: 0, openPositionCount: 0, occupiedContracts: [], lastOpenedAtMs: null };

function context(overrides: Partial<BacktestDayContext> = {}): BacktestDayContext {
  const volumes = new Map(quotes.map((quote) => [`${quote.expiry}|${quote.strike}|${quote.right}`, 1_000]));
  return {
    profile,
    bars,
    market: { todayIso, quotes, openInterestByContract: volumes, previousSessionVolumeByContract: volumes, stockPrice, riskFreeRatePercent },
    book: emptyBook,
    settings: fixtureBacktestSettings(),
    calendar,
    modelTables: volatilityModelTables,
    ...overrides,
  };
}

describe("decideBacktestDay", () => {
  it("sells Pluto's top pick, sized within the order size, at mid − λ × half-spread", () => {
    const decision = decideBacktestDay(context());
    expect(decision.fitIssue).toBeNull();
    expect(decision.open).not.toBeNull();
    const { candidate, quantity, fillPrice, commissionDollars, kellyContracts } = decision.open!;
    expect(decision.summary).toMatch(/^Opened SYN Sell \$\d+(\.\d+)? (Put|Call) · \d+ Mar \(\d+DTE\) · \d+× @ \d+\.\d\d/);
    // The model's figures exist and the pick passes Pluto's dials.
    expect(candidate.model).not.toBeNull();
    expect(Math.abs(candidate.delta)).toBeLessThanOrEqual(0.4);
    expect(candidate.dte).toBeGreaterThanOrEqual(1);
    expect(fillPrice).toBeCloseTo(computeSaleFillPrice(candidate.bid, candidate.ask, 0.5), 12);
    expect(commissionDollars).toBeCloseTo(0.68 * quantity, 12);
    // Order size: 1,000,000 × 50% budget × 10% = $50,000 of EXP $ at most.
    const unitExposure = candidate.strategyKey === "covered_call" ? (stockPrice - candidate.bid) * 100 : (candidate.strike - candidate.bid) * 100;
    expect(quantity).toBeGreaterThanOrEqual(1);
    expect(quantity * unitExposure).toBeLessThanOrEqual(50_000 + unitExposure * 0.05);
    expect(quantity).toBeLessThanOrEqual(kellyContracts ?? Infinity);
  });

  it("keeps the ticker cooldown: no second open within the cooldown", () => {
    const decision = decideBacktestDay(context({ book: { ...emptyBook, lastOpenedAtMs: decisionInstantMs(todayIso) - 30 * 60_000 } }));
    expect(decision.open).toBeNull();
    expect(decision.summary).toContain("opens_blocked");
  });

  it("stops at the open-positions cap", () => {
    const decision = decideBacktestDay(context({ settings: fixtureBacktestSettings({ maxOpenPositions: 2 }), book: { ...emptyBook, openPositionCount: 2 } }));
    expect(decision.open).toBeNull();
    expect(decision.summary).toContain("open_positions_cap");
  });

  it("applies the order gate's max position size from the trading settings", () => {
    const settings = fixtureBacktestSettings();
    settings.trading.maxPositionPctOfPortfolio = 0.1;
    const decision = decideBacktestDay(context({ settings }));
    expect(decision.open).toBeNull();
    expect(decision.summary).toContain("blocked by the order gate");
  });

  it("refuses contracts with no previous-session volume (unknown volume fails Pluto's volume rule)", () => {
    const decision = decideBacktestDay(context({ market: { ...context().market, previousSessionVolumeByContract: null } }));
    expect(decision.open).toBeNull();
    expect(decision.summary).toContain("volume");
  });

  it("skips expiries spanning a known earnings date", () => {
    const decision = decideBacktestDay(context({ profile: { ...profile, earnings: [{ dateIso: "2026-03-03", eventTime: null }] } }));
    expect(decision.open).toBeNull();
    expect(decision.summary).toContain("span earnings");
  });

  it("reports a day whose quotes cannot be fitted", () => {
    const decision = decideBacktestDay(context({ market: { ...context().market, riskFreeRatePercent: null } }));
    expect(decision.open).toBeNull();
    expect(decision.fitIssue).toBe("no_risk_free_rate");
    expect(decision.summary).toContain("no_surface_fit");
  });
});

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
});
