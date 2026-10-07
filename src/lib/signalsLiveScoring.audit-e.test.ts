import { afterEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { emptyCandidateExclusionTally, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { describeNoCandidates, scoreTicker } from "./signalsLiveScoring.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";

// Audit E (2026-10-07): scoreTicker scores the macro flag against the clock (Date.now) and the earnings exclusion against
// todayEasternIso, not against the snapshot date. Fixture copied from signalsLiveScoring.test.ts.

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const years60 = 60 / 365;
const slice = (expiry: string, years: number): SignalSurfaceSlice => ({
  expiry,
  status: "ok",
  parameters: params,
  kMin: -0.4,
  kMax: 0.4,
  yearsToExpiry: years,
  forwardPrice: forward,
  pointCount: 20,
  rmseVolatility: 0.01,
  minButterflyDensity: 0.8,
  droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 },
  calendarChecks: 0,
  calendarViolations: 0,
});
function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}
function inputs(overrides: Partial<TickerSignalsInputs> = {}): TickerSignalsInputs {
  return {
    tickerId: "t1",
    symbol: "AUDE",
    companyName: "Audit Co",
    sector: null,
    header: { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100, fitCompletedAt: "2026-09-21T14:06:00Z", fitIssue: null },
    slices: [slice("2026-10-21", years30), slice("2026-11-20", years60)],
    quotes: [quoteAt(90, "P", "2026-10-21", years30), quoteAt(85, "P", "2026-11-20", years60)],
    dayQuotes: [],
    forecast: { volatility: 0.15, windowDays: 63 },
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    momentum: 0.12,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: { close: 98, dateIso: "2026-09-21" },
    freeShares: 200,
    openShortLegs: [],
    dailyBarCount: 1253,
    dividendCadenceUnknown: false,
    todayEasternIso: "2026-09-21",
    ...overrides,
  };
}
const account = { freeCash: 1_000_000 };
const permissiveSettings = { minAnnualizedYieldPct: 0, deltaTargetMin: 0, deltaTargetMax: 1, recoveryDteMin: 1, recoveryDteMax: 14, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0, commissionWarnSharePctOfPremium: 5, priceCheckMaxDeviationPct: 10, priceCheckMinToleranceDollars: 0.05, spreadCostChargedPct: 100, orderUnfilledCancelMinutes: 15 };

const flaggedExpiries = (scored: ReturnType<typeof scoreTicker>): string[] =>
  [...new Set(scored.candidates.filter((candidate) => candidate.flags.includes("macro_event_before_expiry")).map((candidate) => candidate.expiry))].sort();

afterEach(() => {
  vi.useRealTimers();
});

describe("scoreTicker macro flag uses the clock", () => {
  const fedToday = { dateIso: "2026-09-21", eventAtIso: "2026-09-21T18:00:00Z", title: "Fed rate decision" }; // 14:00 EDT

  it("flags a 14:00 ET release today when scored at 10:00 ET, not when scored at 14:05 ET (same inputs object)", () => {
    const sameInputs = inputs({ macroEvents: [fedToday] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T14:00:00Z"));
    expect(flaggedExpiries(scoreTicker(sameInputs, account, permissiveSettings))).toEqual(["2026-10-21", "2026-11-20"]);
    vi.setSystemTime(new Date("2026-09-21T18:05:00Z"));
    expect(flaggedExpiries(scoreTicker(sameInputs, account, permissiveSettings))).toEqual([]);
  });

  it("an election evening (19:00 ET) on the near expiry's date flags only the far expiry", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T14:30:00Z"));
    const election = { dateIso: "2026-10-21", eventAtIso: "2026-10-21T23:00:00Z", title: "US midterm elections" };
    expect(flaggedExpiries(scoreTicker(inputs({ macroEvents: [election] }), account, permissiveSettings))).toEqual(["2026-11-20"]);
  });

  it("an event stored with a malformed eventAtIso never flags (Date.parse is NaN)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T14:30:00Z"));
    const broken = { dateIso: "2026-10-01", eventAtIso: "not a time", title: "CPI" };
    expect(flaggedExpiries(scoreTicker(inputs({ macroEvents: [broken] }), account, permissiveSettings))).toEqual([]);
  });
});

describe("scoreTicker earnings exclusion uses todayEasternIso, not the snapshot date", () => {
  it("with yesterday's snapshot before 10:00 ET, today's (not before-open) report excludes every expiry through it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z")); // 08:00 ET, the 2026-09-21 snapshot is still the latest
    const scored = scoreTicker(inputs({ todayEasternIso: "2026-09-22", earningsDatesIso: ["2026-09-22"] }), account, permissiveSettings);
    expect(scored.candidates).toEqual([]);
    expect(scored.noCandidatesReason?.earningsDateIso).toBe("2026-09-22");
    expect(scored.noCandidatesReason?.spansEarningsExpiries).toEqual(["2026-10-21", "2026-11-20"]);
  });

  it("the snapshot day's report is yesterday's once the day has moved on: it excludes nothing", () => {
    const scored = scoreTicker(inputs({ todayEasternIso: "2026-09-22", earningsDatesIso: ["2026-09-21"] }), account, permissiveSettings);
    expect(scored.candidates.length).toBeGreaterThan(0);
  });

  it("a report on the near expiry's date excludes both expiries (strict on the expiry day); one the day after excludes only the far one", () => {
    const scored = scoreTicker(inputs({ earningsDatesIso: ["2026-10-21"] }), account, permissiveSettings);
    expect(scored.candidates).toEqual([]); // the far expiry also spans 10-21
    const afterNear = scoreTicker(inputs({ earningsDatesIso: ["2026-10-22"] }), account, permissiveSettings);
    expect([...new Set(afterNear.candidates.map((candidate) => candidate.expiry))]).toEqual(["2026-10-21"]);
  });
});

describe("describeNoCandidates next earnings", () => {
  const settings = { minAnnualizedYieldPct: 0, deltaTargetMin: 0, deltaTargetMax: 1 };
  it("names today's date as the next earnings, and skips yesterday's", () => {
    const tally = { ...emptyCandidateExclusionTally(), spansEarningsExpiries: new Set(["2026-10-16"]) };
    expect(describeNoCandidates(tally, ["2026-10-06", "2026-10-07", "2027-01-20"], "2026-10-07", settings).earningsDateIso).toBe("2026-10-07");
    expect(describeNoCandidates(tally, ["2026-10-06"], "2026-10-07", settings).earningsDateIso).toBeNull();
  });
});

describe("spans_earnings exclusion reason", () => {
  it("names the first date from today through each contract's expiry, today included", () => {
    const reasons: { expiry: string; earningsDateIso: string | null }[] = [];
    scoreTicker(inputs({ earningsDatesIso: ["2026-09-20", "2026-11-05", "2026-09-21"] }), account, permissiveSettings, undefined, {
      onContractExcluded: (quote, exclusion) => {
        if (exclusion.kind === "spans_earnings") reasons.push({ expiry: quote.expiry, earningsDateIso: exclusion.earningsDateIso });
      },
    });
    expect(reasons).toEqual([
      { expiry: "2026-10-21", earningsDateIso: "2026-09-21" },
      { expiry: "2026-11-20", earningsDateIso: "2026-09-21" },
    ]);
  });
});
