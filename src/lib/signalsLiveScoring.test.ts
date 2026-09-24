import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { buildSignalCandidates, gradeSignalCandidates, type SignalCandidate, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { candidateContractKey, computeAtmImpliedVolatility, computeDayChangePercent, computeUncompensatedByContract, contractKey, countGrades, mergeLiveQuotes, rebaseSlicesToToday, scaleSlicesToLiveSpot, scoreTicker, selectLiveQuoteContracts, shouldRefreshUncompensatedShare, toScreenRow } from "./signalsLiveScoring.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const years60 = 60 / 365;
const slice = (expiry: string, years: number, overrides: Partial<SignalSurfaceSlice> = {}): SignalSurfaceSlice => ({
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
  ...overrides,
});

function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number, spreadFraction = 0.04): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * (1 - spreadFraction / 2), ask: mid * (1 + spreadFraction / 2), source: "snapshot" };
}

function inputs(overrides: Partial<TickerSignalsInputs> = {}): TickerSignalsInputs {
  return {
    tickerId: "t1",
    symbol: "TEST",
    companyName: "Test Co",
    sector: null,
    header: { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100 },
    slices: [slice("2026-10-21", years30), slice("2026-11-20", years60)],
    quotes: [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30), quoteAt(85, "P", "2026-11-20", years60), quoteAt(115, "C", "2026-11-20", years60)],
    dayQuotes: [],
    forecast: { volatility: 0.15, windowDays: 63 },
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    momentum: 0.12,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: "2026-11-05",
    previousClose: { close: 98, dateIso: "2026-09-21" },
    freeShares: 200,
    dailyBarCount: 1253,
    dividendCadenceUnknown: false,
    // Same day as the snapshot: the surface is scored as fitted. See the rebaseSlicesToToday tests for a stale snapshot.
    todayEasternIso: "2026-09-21",
    ...overrides,
  };
}
const account = { freeCash: 1_000_000 };
// No test in this file is about the Signals tab's own limits (see signalCandidates.test.ts and
// signalOrderLimits.test.ts for those) -- wide open here so every existing candidate stays in.
const permissiveSettings = { maxDeltaDriftPct: 100, minAnnualizedYieldPct: 0, maxNetDelta: 1, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 };

describe("computeAtmImpliedVolatility", () => {
  it("reads the slice nearest 30 days (with >= 14 days left) at log-moneyness 0", () => {
    const slices = [slice("2026-10-01", 10 / 365), slice("2026-10-21", years30), slice("2026-11-20", years60)];
    const expected = Math.sqrt(sviTotalVariance(params, 0) / years30);
    expect(computeAtmImpliedVolatility(slices)).toBeCloseTo(expected, 12);
    // 10 days is under the minimum even though it is nearer to 30 than 60 is not; 60 wins when 30 is dropped
    expect(computeAtmImpliedVolatility([slices[0]!, slices[2]!])).toBeCloseTo(Math.sqrt(sviTotalVariance(params, 0) / years60), 12);
    expect(computeAtmImpliedVolatility([slices[0]!])).toBeNull();
    expect(computeAtmImpliedVolatility([slice("2026-10-21", years30, { status: "insufficient_points" as never })])).toBeNull();
  });
  it("is part of scoreTicker's output and does not move with the live spot", () => {
    const atSnapshot = scoreTicker(inputs(), account, permissiveSettings).atmImpliedVolatility;
    const atLiveSpot = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: 108, priceSource: "live" }).atmImpliedVolatility;
    expect(atSnapshot).toBeCloseTo(Math.sqrt(sviTotalVariance(params, 0) / years30), 12);
    expect(atLiveSpot).toBe(atSnapshot);
  });
});

describe("rebaseSlicesToToday (stale snapshot)", () => {
  it("re-times each slice to today, keeps the surface IV at every strike, and drops expiries already past", () => {
    const stale = [slice("2026-09-22", 1 / 365), slice("2026-10-21", years30), slice("2026-11-20", years60)];
    const rebased = rebaseSlicesToToday(stale, "2026-09-23");
    expect(rebased.map((s) => s.expiry)).toEqual(["2026-10-21", "2026-11-20"]);
    expect(rebased[0]!.yearsToExpiry).toBeCloseTo(28 / 365, 12);
    expect(rebased[1]!.yearsToExpiry).toBeCloseTo(58 / 365, 12);
    for (const k of [-0.2, 0, 0.15]) {
      const ivBefore = Math.sqrt(sviTotalVariance(params, k) / years30);
      const ivAfter = Math.sqrt(sviTotalVariance(rebased[0]!.parameters!, k) / rebased[0]!.yearsToExpiry);
      expect(ivAfter).toBeCloseTo(ivBefore, 12);
    }
  });

  it("is the identity when today is the snapshot day", () => {
    const same = [slice("2026-10-21", years30)];
    expect(rebaseSlicesToToday(same, "2026-09-21")).toEqual(same);
  });

  it("makes yesterday's snapshot score one day shorter today", () => {
    const today = scoreTicker(inputs(), account, permissiveSettings);
    const stale = scoreTicker(inputs({ todayEasternIso: "2026-09-22" }), account, permissiveSettings);
    const todayPut = today.candidates.find((c) => c.expiry === "2026-10-21" && c.strike === 90)!;
    const stalePut = stale.candidates.find((c) => c.expiry === "2026-10-21" && c.strike === 90)!;
    expect(todayPut.dte).toBe(30);
    expect(stalePut.dte).toBe(29);
    expect(stalePut.surfaceImpliedVolatility).toBeCloseTo(todayPut.surfaceImpliedVolatility, 12);
  });
});

describe("computeDayChangePercent", () => {
  it("is the percent move from the previous close", () => {
    expect(computeDayChangePercent(110, { close: 100, dateIso: "2026-09-21" })).toBeCloseTo(10, 10);
    expect(computeDayChangePercent(95, { close: 100, dateIso: "2026-09-21" })).toBeCloseTo(-5, 10);
  });
  it("is null without a spot or a usable previous close", () => {
    expect(computeDayChangePercent(null, { close: 100, dateIso: "2026-09-21" })).toBeNull();
    expect(computeDayChangePercent(100, null)).toBeNull();
    expect(computeDayChangePercent(100, { close: 0, dateIso: "2026-09-21" })).toBeNull();
  });
});

describe("scaleSlicesToLiveSpot (sticky moneyness)", () => {
  it("moves every forward in proportion to the spot move", () => {
    const scaled = scaleSlicesToLiveSpot([slice("a", years30, { forwardPrice: 100.5 }), slice("b", years60, { forwardPrice: 101.2 })], 100, 105);
    expect(scaled[0]!.forwardPrice).toBeCloseTo(100.5 * 1.05, 10);
    expect(scaled[1]!.forwardPrice).toBeCloseTo(101.2 * 1.05, 10);
    expect(scaled[0]!.parameters).toBe(params); // surface itself untouched
  });
  it("returns the same array when the spot has not moved or the inputs are unusable", () => {
    const slices = [slice("a", years30)];
    expect(scaleSlicesToLiveSpot(slices, 100, 100)).toBe(slices);
    expect(scaleSlicesToLiveSpot(slices, 0, 105)).toBe(slices);
    expect(scaleSlicesToLiveSpot(slices, 100, NaN)).toBe(slices);
  });
});

describe("mergeLiveQuotes", () => {
  const snapshot = [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30)];
  it("replaces bid/ask and marks the source live for a matching two-sided quote only", () => {
    const merged = mergeLiveQuotes(snapshot, [{ expiry: "2026-10-21", strike: 90, right: "P", bid: 1.5, ask: 1.6 }]);
    expect(merged[0]).toEqual({ ...snapshot[0], bid: 1.5, ask: 1.6, source: "live" });
    expect(merged[1]).toBe(snapshot[1]);
  });
  it("keeps the snapshot quote when the live quote is missing a side", () => {
    const merged = mergeLiveQuotes(snapshot, [{ expiry: "2026-10-21", strike: 90, right: "P", bid: 1.5, ask: null }]);
    expect(merged[0]).toBe(snapshot[0]);
  });
  it("returns the same array for no live quotes", () => {
    expect(mergeLiveQuotes(snapshot, [])).toBe(snapshot);
  });
});

describe("scoreTicker", () => {
  it("reports the unscored reasons in order: no snapshot, no fit, no forecast", () => {
    expect(scoreTicker(inputs({ header: null }), account, permissiveSettings).unscoredReason).toBe("no_snapshot");
    expect(scoreTicker(inputs({ slices: [slice("2026-10-21", years30, { status: "insufficient_points" as never })] }), account, permissiveSettings).unscoredReason).toBe("no_surface_fit");
    expect(scoreTicker(inputs({ forecast: null }), account, permissiveSettings).unscoredReason).toBe("no_forecast");
    const split = scoreTicker(inputs({ forecast: null, suspectedSplitDateIso: "2026-09-15" }), account, permissiveSettings);
    expect(split.unscoredReason).toBe("suspected_split");
    expect(split.caveats.map((caveat) => caveat.id)).toContain("suspected_split");
  });

  it("at snapshot prices matches buildSignalCandidates + gradeSignalCandidates directly, with counts and day change", () => {
    const in1 = inputs();
    const scored = scoreTicker(in1, account, permissiveSettings);
    const direct = gradeSignalCandidates(buildSignalCandidates({ spotPrice: forward, riskFreeRate: rate, forecast: in1.forecast, slices: in1.slices, quotes: in1.quotes, earningsDatesIso: [], earningsCalendarResolved: true, snapshotDateIso: "2026-09-21", freeShares: 200, freeCash: account.freeCash, maxNetDelta: permissiveSettings.maxNetDelta, minAnnualizedYieldPct: permissiveSettings.minAnnualizedYieldPct }));
    expect(scored.candidates).toEqual(direct);
    expect(scored.unscoredReason).toBeNull();
    expect(scored.priceSource).toBe("snapshot");
    expect(scored.spotPrice).toBe(forward);
    expect(scored.dayChangePercent).toBeNull(); // snapshot spot vs the same day's close is not a day change
    expect(Object.values(scored.gradeCounts).reduce((a, b) => a + b, 0)).toBe(4);
    expect(scored.best).toEqual(direct.slice().sort((a, b) => b.edgeDollars - a.edgeDollars || b.netEdge - a.netEdge)[0]);
  });

  it("re-reads the surface at the live spot: surface IV at the strike follows the scaled forward (independent SVI reference)", () => {
    const liveSpot = 105;
    const scored = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: liveSpot, priceSource: "live" });
    const put90 = scored.candidates.find((c) => c.strike === 90 && c.expiry === "2026-10-21")!;
    const scaledForward = forward * (liveSpot / forward);
    const expectedIv = Math.sqrt(sviTotalVariance(params, Math.log(90 / scaledForward)) / years30);
    expect(put90.surfaceImpliedVolatility).toBeCloseTo(expectedIv, 12);
    expect(put90.delta).toBeCloseTo(blackScholesDelta(scaledForward, 90, years30, rate, expectedIv, false), 12);
    expect(scored.spotPrice).toBe(liveSpot);
    expect(scored.priceSource).toBe("live");
    expect(scored.dayChangePercent).toBeCloseTo((105 / 98 - 1) * 100, 10);
    // A higher spot makes the 90 put further OTM: smaller |delta| than at the snapshot
    const snapshotPut90 = scoreTicker(inputs(), account, permissiveSettings).candidates.find((c) => c.strike === 90 && c.expiry === "2026-10-21")!;
    expect(Math.abs(put90.delta)).toBeLessThan(Math.abs(snapshotPut90.delta));
  });

  it("a live spot above the 110 call strike removes it from the OTM set entirely", () => {
    const scored = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: 112, priceSource: "live" });
    expect(scored.candidates.some((c) => c.strike === 110 && c.strategyKey === "covered_call")).toBe(false);
  });

  it("live quotes change friction and net Edge for their contracts only, and mark the source", () => {
    const snapshot = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: forward, priceSource: "live" });
    const put90Snapshot = snapshot.candidates.find((c) => c.strike === 90 && c.expiry === "2026-10-21")!;
    const wider = { bid: put90Snapshot.bid * 0.9, ask: put90Snapshot.ask * 1.1 };
    const live = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: forward, priceSource: "live", liveQuotes: [{ expiry: "2026-10-21", strike: 90, right: "P", ...wider }] });
    const put90Live = live.candidates.find((c) => c.strike === 90 && c.expiry === "2026-10-21")!;
    expect(put90Live.quoteSource).toBe("live");
    expect(put90Live.bid).toBe(wider.bid);
    expect(put90Live.frictionVolatility).toBeGreaterThan(put90Snapshot.frictionVolatility);
    expect(put90Live.netEdge).toBeLessThan(put90Snapshot.netEdge);
    const call110Live = live.candidates.find((c) => c.strike === 110 && c.expiry === "2026-10-21")!;
    const call110Snapshot = snapshot.candidates.find((c) => c.strike === 110 && c.expiry === "2026-10-21")!;
    expect(call110Live).toEqual(call110Snapshot);
    expect(call110Live.quoteSource).toBe("snapshot");
  });

  it("overrides at the snapshot price (quotes or Monte Carlo only) still report no day change", () => {
    const scored = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: forward, priceSource: "snapshot", uncompensatedByContract: new Map() });
    expect(scored.dayChangePercent).toBeNull();
    expect(scoreTicker(inputs(), account, permissiveSettings, { spotPrice: forward, priceSource: "frozen" }).dayChangePercent).toBeCloseTo((100 / 98 - 1) * 100, 10);
  });

  it("carries the last Monte Carlo result by contract across a re-score and leaves unknown contracts null", () => {
    const first = scoreTicker(inputs(), account, permissiveSettings);
    const key = candidateContractKey(first.candidates[0]!);
    const uncompensatedByContract = new Map([[key, 37.5]]);
    const rescored = scoreTicker(inputs(), account, permissiveSettings, { spotPrice: 101, priceSource: "live", uncompensatedByContract });
    expect(rescored.candidates.find((c) => candidateContractKey(c) === key)!.uncompensatedSharePercent).toBe(37.5);
    expect(rescored.candidates.filter((c) => candidateContractKey(c) !== key).every((c) => c.uncompensatedSharePercent === null)).toBe(true);
  });

  it("never drops a candidate for maxDeltaDriftPct (the setting is stored but not applied)", () => {
    const first = scoreTicker(inputs(), account, permissiveSettings);
    const knownKey = candidateContractKey(first.candidates[0]!);
    const uncompensatedByContract = new Map([[knownKey, 40]]);
    const strict = { ...permissiveSettings, maxDeltaDriftPct: 10 };
    const rescored = scoreTicker(inputs(), account, strict, { spotPrice: forward, priceSource: "snapshot", uncompensatedByContract });
    expect(rescored.candidates.length).toBe(first.candidates.length);
    expect(rescored.candidates.find((c) => candidateContractKey(c) === knownKey)!.uncompensatedSharePercent).toBe(40);
  });
});

describe("computeUncompensatedByContract", () => {
  it("keys every candidate and agrees with attaching directly at the same path count", () => {
    const in1 = inputs();
    const scored = scoreTicker(in1, account, permissiveSettings);
    const byContract = computeUncompensatedByContract(scored.candidates, forward, in1.slices);
    expect(byContract.size).toBe(scored.candidates.length);
    for (const candidate of scored.candidates) {
      const value = byContract.get(candidateContractKey(candidate));
      expect(value).not.toBeNull();
      expect(value!).toBeGreaterThan(0);
      expect(value!).toBeLessThanOrEqual(100);
    }
  });
});

describe("shouldRefreshUncompensatedShare", () => {
  it("always on the first run, then only at or beyond a 0.5% spot move", () => {
    expect(shouldRefreshUncompensatedShare(null, 100)).toBe(true);
    expect(shouldRefreshUncompensatedShare(100, 100.4)).toBe(false);
    expect(shouldRefreshUncompensatedShare(100, 100.5)).toBe(true);
    expect(shouldRefreshUncompensatedShare(100, 99.5)).toBe(true);
    expect(shouldRefreshUncompensatedShare(100, 99.6)).toBe(false);
  });
});

describe("selectLiveQuoteContracts", () => {
  const candidate = (expiry: string, strike: number, strategyKey: SignalCandidate["strategyKey"], edgeDollars: number): SignalCandidate =>
    ({ strategyKey, expiry, strike, edgeDollars, netEdge: edgeDollars / 10 }) as SignalCandidate;
  const list = [
    candidate("2026-10-21", 90, "cash_secured_put", 5),
    candidate("2026-10-21", 110, "covered_call", 1),
    candidate("2026-11-20", 85, "cash_secured_put", 50),
    candidate("2026-11-20", 115, "covered_call", 40),
    candidate("2026-12-18", 80, "cash_secured_put", 30),
  ];

  it("takes the selected expiry's candidates only, without duplicates (other expiries ride on day quotes)", () => {
    expect(selectLiveQuoteContracts(list, "2026-10-21").map(contractKey)).toEqual(["2026-10-21|90|P", "2026-10-21|110|C"]);
    expect(selectLiveQuoteContracts([...list, candidate("2026-10-21", 90, "cash_secured_put", 5)], "2026-10-21")).toHaveLength(2);
  });
  it("caps the total at maxContracts", () => {
    expect(selectLiveQuoteContracts(list, "2026-11-20", { maxContracts: 1 }).map(contractKey)).toEqual(["2026-11-20|85|P"]);
  });
  it("opens no lines without a selected expiry", () => {
    expect(selectLiveQuoteContracts(list, null)).toEqual([]);
  });
});

describe("toScreenRow / countGrades", () => {
  it("strips the candidate list and nothing else", () => {
    const scored = scoreTicker(inputs(), account, permissiveSettings);
    const row = toScreenRow(scored);
    expect("candidates" in row).toBe(false);
    expect({ ...row, candidates: scored.candidates }).toEqual(scored);
  });
  it("counts every grade", () => {
    const counts = countGrades([{ grade: "strong" }, { grade: "avoid" }, { grade: "avoid" }] as SignalCandidate[]);
    expect(counts).toEqual({ strong: 1, good: 0, weak: 0, avoid: 2 });
  });
});

describe("day quotes and the intraday IV shift (formula 3h)", () => {
  const expiry = "2026-10-21";
  function quoteAtVolatility(strike: number, right: "C" | "P", volatility: number, quotedAt: string) {
    const mid = blackScholesPriceOnForward(forward, strike, years30, rate, volatility, right === "C");
    return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, quotedAt };
  }
  const strikes: [number, "C" | "P"][] = [[80, "P"], [85, "P"], [90, "P"], [95, "P"], [105, "C"], [110, "C"], [115, "C"], [120, "C"]];
  const surfaceIvAt = (strike: number) => Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years30);
  const richInputs = (dayQuoteCount: number) =>
    inputs({
      slices: [slice(expiry, years30)],
      quotes: strikes.map(([strike, right]) => quoteAt(strike, right, expiry, years30)),
      dayQuotes: strikes.slice(0, dayQuoteCount).map(([strike, right], index) => quoteAtVolatility(strike, right, surfaceIvAt(strike) + 0.02, `2026-09-24T15:${String(10 + index).padStart(2, "0")}:00.000Z`)),
    });

  it("merges day quotes with source 'day' and their time, and a live quote still wins over a day quote", () => {
    const scored = scoreTicker(richInputs(3), account, permissiveSettings);
    const byKey = new Map(scored.candidates.map((candidate) => [candidateContractKey(candidate), candidate]));
    expect(byKey.get(`${expiry}|80|P`)).toMatchObject({ quoteSource: "day", quotedAt: "2026-09-24T15:10:00.000Z" });
    expect(byKey.get(`${expiry}|120|C`)).toMatchObject({ quoteSource: "snapshot", quotedAt: null });
    expect(scored.dayQuotesAsOf).toEqual({ oldest: "2026-09-24T15:10:00.000Z", newest: "2026-09-24T15:12:00.000Z", count: 3 });
    expect(scored.quoteSourceCounts).toEqual({ live: 0, day: 3, snapshot: 5 });

    const withLive = scoreTicker(richInputs(3), account, permissiveSettings, { spotPrice: forward, priceSource: "live", liveQuotes: [{ expiry, strike: 80, right: "P", bid: 1.4, ask: 1.5 }] });
    expect(withLive.candidates.find((candidate) => candidateContractKey(candidate) === `${expiry}|80|P`)).toMatchObject({ quoteSource: "live", bid: 1.4, ask: 1.5 });
    expect(withLive.quoteSourceCounts).toEqual({ live: 1, day: 2, snapshot: 5 });
  });

  it("shifts the whole expiry's surface IV by the median fresh mid-IV difference once five quotes qualify, and every candidate's edge moves with it", () => {
    const unshifted = scoreTicker(richInputs(4), account, permissiveSettings);
    expect(unshifted.ivShiftByExpiry[expiry]).toEqual({ shiftVolatilityPoints: 0, quoteCount: 4 });

    const shifted = scoreTicker(richInputs(5), account, permissiveSettings);
    expect(shifted.ivShiftByExpiry[expiry]!.quoteCount).toBe(5);
    expect(shifted.ivShiftByExpiry[expiry]!.shiftVolatilityPoints).toBeCloseTo(2, 2);
    const snapshotOnly = new Map(unshifted.candidates.map((candidate) => [candidateContractKey(candidate), candidate]));
    for (const candidate of shifted.candidates) {
      const before = snapshotOnly.get(candidateContractKey(candidate))!;
      expect(candidate.surfaceImpliedVolatility - before.surfaceImpliedVolatility).toBeCloseTo(0.02, 3);
      expect(candidate.edge - before.edge).toBeCloseTo(0.02, 3);
    }
    // A snapshot-quoted contract in the same expiry is shifted too: the shift is per expiry, not per quote.
    expect(shifted.candidates.find((candidate) => candidate.strike === 120)!.quoteSource).toBe("snapshot");
  });

  it("ignores wide, one-sided and in-the-money fresh quotes when computing the shift", () => {
    const wide = { ...quoteAtVolatility(80, "P", surfaceIvAt(80) + 0.5, "2026-09-24T15:00:00.000Z") };
    wide.ask = wide.bid * 3; // 100% spread
    const scored = scoreTicker(
      inputs({
        slices: [slice(expiry, years30)],
        quotes: strikes.map(([strike, right]) => quoteAt(strike, right, expiry, years30)),
        dayQuotes: [wide, { expiry, strike: 85, right: "P", bid: 1, ask: null, quotedAt: "2026-09-24T15:00:00.000Z" }, quoteAtVolatility(90, "C", 0.5, "2026-09-24T15:00:00.000Z")],
      }),
      account,
      permissiveSettings,
    );
    expect(scored.ivShiftByExpiry[expiry]).toBeUndefined();
  });
});
