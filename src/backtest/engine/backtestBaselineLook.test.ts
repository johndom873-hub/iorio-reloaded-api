import { describe, expect, it } from "vitest";
import { valueContract } from "../../lib/contractValuation.js";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { fixtureModelForecast } from "../../lib/testSupport/valuationModelFixtures.js";
import { volatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import { validateBaselineSettings } from "../jobs/backtestSessionRequest.js";
import { baselineContractsForCash, selectBaselineCandidates, type BaselineCandidateInput, type BaselineModelInput } from "./backtestBaselineLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";

const todayIso = "2026-03-02";
const stockPrice = 100;
const riskFreeRate = 0.04;
const volatility = 0.5;

/** A quote priced by Black-76 at 50% volatility, with a 4% spread around that mid unless given. */
function quote(expiry: string, strike: number, right: "C" | "P", spreadFraction = 0.04): SymbolFileQuote {
  const years = yearsBetweenIsoDates(todayIso, expiry);
  const mid = blackScholesPriceOnForward(stockPrice * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, volatility, right === "C");
  const halfSpread = (mid * spreadFraction) / 2;
  return { expiry, strike, right, bid: Math.round((mid - halfSpread) * 10_000) / 10_000, ask: Math.round((mid + halfSpread) * 10_000) / 10_000, bidSize: 10, askSize: 10 };
}

function input(quotes: SymbolFileQuote[], overrides: Partial<BaselineCandidateInput> = {}): BaselineCandidateInput {
  return {
    quotes,
    right: "P",
    todayIso,
    stockPrice,
    riskFreeRate,
    previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), 1_000])),
    settings: { minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45 },
    spreadShareCharged: 0.5,
    isHeld: () => false,
    ...overrides,
  };
}

describe("selectBaselineCandidates", () => {
  it("ranks by premium yield on the time value and reads each quote's own delta", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-06", 100, "P"), quote("2026-03-27", 95, "P"), quote("2026-03-06", 105, "C")];
    const { candidates } = selectBaselineCandidates(input(quotes));
    // The 25-day $95 put out-earns the 4-day one a year at these prices (45% vs 41%); the call is the other right.
    expect(candidates.map((candidate) => [candidate.expiry, candidate.strike])).toEqual([
      ["2026-03-06", 100],
      ["2026-03-27", 95],
      ["2026-03-06", 95],
    ]);
    for (const candidate of candidates) {
      const years = yearsBetweenIsoDates(todayIso, candidate.expiry);
      expect(candidate.impliedVolatility).toBeCloseTo(volatility, 2);
      expect(candidate.delta).toBeCloseTo(blackScholesDelta(stockPrice * Math.exp(riskFreeRate * years), candidate.strike, years, riskFreeRate, volatility, false), 2);
      expect(candidate.volumeCap).toBe(200);
    }
    // At the money: no intrinsic value, so the yield is the fill after its commission on the capital, annualized.
    const atTheMoney = candidates[0]!;
    const years = yearsBetweenIsoDates(todayIso, atTheMoney.expiry);
    expect(atTheMoney.premiumYield).toBeCloseTo((atTheMoney.fillPrice * 100 - 0.68) / ((100 - atTheMoney.fillPrice) * 100) / years, 10);
  });

  it("counts only the time value of an in-the-money contract", () => {
    // $1 in the money, |delta| 0.56: inside the range.
    const inTheMoney = quote("2026-03-06", 101, "P");
    const { candidates } = selectBaselineCandidates(input([inTheMoney]));
    expect(candidates[0]!.timeValue).toBeCloseTo(candidates[0]!.fillPrice - 1, 10);
  });

  it("leaves out what the delta and expiry ranges, the realism limits and the held contracts exclude", () => {
    const quotes = [
      quote("2026-03-27", 75, "P"), // bid $0.051 but |delta| below 0.05
      quote("2026-04-30", 95, "P"), // 59 days
      quote("2026-03-06", 99, "P", 0.4), // spread 40% of the mid
      { ...quote("2026-03-06", 98, "P"), bid: 0.04 }, // bid under $0.05
      quote("2026-03-06", 97, "P"), // no volume
      quote("2026-03-06", 96, "P"), // held
      quote("2026-03-06", 100, "P"), // the only one left
    ];
    const volume = new Map(quotes.filter((entry) => entry.strike !== 97).map((entry) => [contractKey(entry), 50]));
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { previousSessionVolumeByContract: volume, isHeld: (contract) => contract.strike === 96 }));
    expect(candidates.map((candidate) => candidate.strike)).toEqual([100]);
    expect(candidates[0]!.volumeCap).toBe(10);
    expect(rejections).toEqual({ outsideExpiryRange: 1, noUsableQuote: 1, spreadTooWide: 1, tooLittleVolume: 1, noImpliedVolatility: 0, outsideDeltaRange: 1, noTimeValue: 0, alreadyHeld: 1, belowCost: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0 });
  });

  it("leaves out expiries that span a known earnings date when earnings are given", () => {
    const quotes = [quote("2026-03-06", 100, "P"), quote("2026-03-27", 100, "P")];
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-03-10"] }));
    expect(candidates.map((candidate) => candidate.expiry)).toEqual(["2026-03-06"]);
    expect(rejections.spansEarnings).toBe(1);
    // A report on the expiry day itself is spanned; one already past is not.
    expect(selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-03-06"] })).candidates.map((candidate) => candidate.expiry)).toEqual([]);
    expect(selectBaselineCandidates(input(quotes, { earningsDatesIso: ["2026-02-27"] })).candidates).toHaveLength(2);
  });

  it("keeps calls at or above a cost floor when one is given", () => {
    const quotes = [quote("2026-03-06", 100, "C"), quote("2026-03-06", 102, "C"), quote("2026-03-06", 104, "C")];
    const { candidates, rejections } = selectBaselineCandidates(input(quotes, { right: "C", minimumStrike: 101.5 }));
    expect(candidates.map((candidate) => candidate.strike)).toEqual([102, 104]);
    expect(rejections.belowCost).toBe(1);
    expect(selectBaselineCandidates(input(quotes, { right: "C", minimumStrike: Number.POSITIVE_INFINITY })).candidates).toEqual([]);
  });

  it("refuses everything when the previous session's volume is unknown", () => {
    expect(selectBaselineCandidates(input([quote("2026-03-06", 100, "P")], { previousSessionVolumeByContract: null })).candidates).toEqual([]);
  });
});

describe("selectBaselineCandidates with the Signals model", () => {
  /** τ: 0.8 variance sessions per calendar day, so the forecast's clock runs slower than the calendar's 1 ÷ 365. */
  const varianceSessionsPerDay = 0.8;
  function model(overrides: Partial<BaselineModelInput> = {}): BaselineModelInput {
    return { tables: volatilityModelTables, group: "stock", forecast: fixtureModelForecast(0.4), varianceSessionsTo: (expiryIso) => yearsBetweenIsoDates(todayIso, expiryIso) * 365 * varianceSessionsPerDay, minVolatilityEdge: null, rankByEdgeYield: false, ...overrides };
  }
  // The quotes' 50% on the calendar's clock is √(252 × 0.25 ÷ 365 ÷ 0.8) = 46.4% on the forecast's: 6.4 points above 40%.
  const edgeOnForecastClock = Math.sqrt((252 * volatility * volatility) / 365 / varianceSessionsPerDay) - 0.4;

  it("measures the volatility edge on the forecast's clock and sells only at or above the margin", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-20", 95, "P")];
    const kept = selectBaselineCandidates(input(quotes, { model: model({ minVolatilityEdge: 0.06 }) }));
    expect(kept.candidates).toHaveLength(2);
    for (const candidate of kept.candidates) expect(candidate.volatilityEdge).toBeCloseTo(edgeOnForecastClock, 2);
    const refused = selectBaselineCandidates(input(quotes, { model: model({ minVolatilityEdge: 0.07 }) }));
    expect(refused.candidates).toEqual([]);
    expect(refused.rejections.belowVolatilityEdge).toBe(2);
    // Without the model the edge is not measured; with it but no margin it is measured and nothing is left out.
    expect(selectBaselineCandidates(input(quotes)).candidates[0]!.volatilityEdge).toBeNull();
    expect(selectBaselineCandidates(input(quotes, { model: model() })).candidates).toHaveLength(2);
  });

  it("leaves everything out without a forecast or once the expiry's variance is spent", () => {
    const quotes = [quote("2026-03-06", 95, "P")];
    expect(selectBaselineCandidates(input(quotes, { model: model({ forecast: null }) })).rejections.noForecast).toBe(1);
    expect(selectBaselineCandidates(input(quotes, { model: model({ varianceSessionsTo: () => 0 }) })).rejections.noForecast).toBe(1);
  });

  it("ranks by the model's Edge Yield when asked, valued with the session's friction", () => {
    const quotes = [quote("2026-03-06", 95, "P"), quote("2026-03-06", 100, "P"), quote("2026-03-27", 95, "P"), quote("2026-03-27", 90, "P")];
    const byPremium = selectBaselineCandidates(input(quotes, { model: model() })).candidates;
    const byEdge = selectBaselineCandidates(input(quotes, { model: model({ rankByEdgeYield: true }) })).candidates;
    expect(byPremium.every((candidate) => candidate.edgeYield === null)).toBe(true);
    const edgeYields = byEdge.map((candidate) => candidate.edgeYield!);
    expect(edgeYields).toEqual([...edgeYields].sort((a, b) => b - a));
    expect(byEdge.map((candidate) => `${candidate.expiry} ${candidate.strike}`)).not.toEqual(byPremium.map((candidate) => `${candidate.expiry} ${candidate.strike}`));
    const first = byEdge[0]!;
    const years = yearsBetweenIsoDates(todayIso, first.expiry);
    const forward = stockPrice * Math.exp(riskFreeRate * years);
    const expected = valueContract(volatilityModelTables, {
      isCall: false,
      strike: first.strike,
      forward,
      mid: (first.bid + first.ask) / 2,
      frictionDollars: frictionDollarsPerContract(first.bid, first.ask, 0.5, 0.68),
      perSessionVariance: fixtureModelForecast(0.4).perSessionVariance,
      varianceSessions: years * 365 * varianceSessionsPerDay,
      calendarYears: years,
      riskFreeRate,
      group: "stock",
      spot: stockPrice,
    })!;
    expect(first.edgeYield).toBeCloseTo(expected.expectedAnnualizedReturn, 3);
  });
});

describe("baselineContractsForCash", () => {
  it("reserves a put's strike less its fill, and pays a buy-write's shares less its fill, with commissions", () => {
    // Put: (95 − 2) × 100 + 0.68 = 9,300.68 per contract.
    expect(baselineContractsForCash(93_006.8, { strike: 95, fillPrice: 2 }, "put", 100.01)).toBe(10);
    expect(baselineContractsForCash(93_006.7, { strike: 95, fillPrice: 2 }, "put", 100.01)).toBe(9);
    // Buy-write: (100.01 − 3) × 100 + 0.68 + 100 × $0.005 = 9,702.18 per contract.
    expect(baselineContractsForCash(97_021.8, { strike: 105, fillPrice: 3 }, "buy_write", 100.01)).toBe(10);
    expect(baselineContractsForCash(97_021.7, { strike: 105, fillPrice: 3 }, "buy_write", 100.01)).toBe(9);
  });
});

describe("validateBaselineSettings", () => {
  it("accepts the defaults and refuses ranges that are out of order or out of bounds", () => {
    const valid = { entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, callStrike: "delta_range", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, ranking: "premium_yield" };
    expect(validateBaselineSettings(valid)).toBeNull();
    expect(validateBaselineSettings({ ...valid, entry: "strangle" })).toMatch(/entry/);
    expect(validateBaselineSettings({ ...valid, minAbsDelta: 0.7 })).toMatch(/minAbsDelta must not be above/);
    expect(validateBaselineSettings({ ...valid, maxDte: 60 })).toMatch(/1 to 45/);
    expect(validateBaselineSettings({ ...valid, minDte: 0 })).toMatch(/1 to 45/);
    expect(validateBaselineSettings({ ...valid, minDte: 10, maxDte: 5 })).toMatch(/minDte must not be above/);
    expect(validateBaselineSettings({ ...valid, callStrike: "above_break_even", takeProfitPct: 75 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callStrike: "anywhere" })).toMatch(/callStrike/);
    expect(validateBaselineSettings({ ...valid, callStrike: "none" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callStrike: "none", entry: "buy_write" })).toMatch(/buy-write/);
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "own_range", callMinAbsDelta: 0.1, callMaxAbsDelta: 0.2 })).toBeNull();
    expect(validateBaselineSettings({ ...valid, callDeltaRange: "wide" })).toMatch(/callDeltaRange/);
    expect(validateBaselineSettings({ ...valid, callMinAbsDelta: 0 })).toMatch(/callMinAbsDelta/);
    expect(validateBaselineSettings({ ...valid, callMinAbsDelta: 0.3, callMaxAbsDelta: 0.2 })).toMatch(/callMinAbsDelta must not be above/);
    expect(validateBaselineSettings({ ...valid, takeProfitPct: 100 })).toMatch(/takeProfitPct/);
    expect(validateBaselineSettings({ ...valid, shareStopLossPct: 25, earnings: "skip_spanning", maxAccountPctPerStock: 50, looks: "first_look" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, shareStopLossPct: -1 })).toMatch(/shareStopLossPct/);
    expect(validateBaselineSettings({ ...valid, earnings: "close_before" })).toMatch(/earnings/);
    expect(validateBaselineSettings({ ...valid, maxAccountPctPerStock: 0 })).toMatch(/maxAccountPctPerStock/);
    expect(validateBaselineSettings({ ...valid, looks: "hourly" })).toMatch(/looks/);
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "entries", minVolatilityEdgePoints: -5, ranking: "edge_yield" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "all_sales" })).toBeNull();
    expect(validateBaselineSettings({ ...valid, volatilityEdgeFilter: "on" })).toMatch(/volatilityEdgeFilter/);
    expect(validateBaselineSettings({ ...valid, minVolatilityEdgePoints: 150 })).toMatch(/minVolatilityEdgePoints/);
    expect(validateBaselineSettings({ ...valid, ranking: "delta" })).toMatch(/ranking/);
  });
});
