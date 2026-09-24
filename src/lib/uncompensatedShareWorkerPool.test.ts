import { afterAll, describe, expect, it } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { buildSignalCandidates, gradeSignalCandidates, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { candidateContractKey, computeUncompensatedByContract } from "./signalsLiveScoring.js";
import { computeUncompensatedSharesInWorker, shutdownUncompensatedShareWorker } from "./uncompensatedShareWorkerPool.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years = 30 / 365;
const slices: SignalSurfaceSlice[] = [
  {
    expiry: "2026-10-21",
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
  },
];
function quoteAt(strike: number, right: "C" | "P"): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry: "2026-10-21", strike, right, bid: mid * 0.98, ask: mid * 1.02 };
}
const candidates = gradeSignalCandidates(buildSignalCandidates({ spotPrice: forward, riskFreeRate: rate, forecast: { volatility: 0.15, windowDays: 63 }, slices, quotes: [quoteAt(90, "P"), quoteAt(95, "P"), quoteAt(105, "C"), quoteAt(110, "C")], earningsDatesIso: [], earningsCalendarResolved: true, snapshotDateIso: "2026-09-21", freeShares: 0, freeCash: 1e6, maxNetDelta: 1, minAnnualizedYieldPct: 0 }));

afterAll(() => shutdownUncompensatedShareWorker());

describe("computeUncompensatedSharesInWorker", () => {
  it("returns exactly what the synchronous computation returns (same seed, same paths)", async () => {
    const fromWorker = await computeUncompensatedSharesInWorker(candidates, forward, slices, 1000);
    const direct = computeUncompensatedByContract(candidates, forward, slices, 1000);
    expect(fromWorker.size).toBe(candidates.length);
    for (const candidate of candidates) {
      const key = candidateContractKey(candidate);
      expect(fromWorker.get(key)).toBe(direct.get(key));
    }
  });

  it("serves concurrent jobs, each with its own answer", async () => {
    const [atSpot, atHigherSpot] = await Promise.all([computeUncompensatedSharesInWorker(candidates, forward, slices, 500), computeUncompensatedSharesInWorker(candidates, forward * 1.03, slices, 500)]);
    const key = candidateContractKey(candidates[0]!);
    expect(atSpot.get(key)).toBe(computeUncompensatedByContract(candidates, forward, slices, 500).get(key));
    expect(atHigherSpot.get(key)).toBe(computeUncompensatedByContract(candidates, forward * 1.03, slices, 500).get(key));
    expect(atSpot.get(key)).not.toBe(atHigherSpot.get(key));
  });

  it("skips contracts whose expiry has no slice and resolves an empty map when nothing is computable", async () => {
    expect((await computeUncompensatedSharesInWorker(candidates, forward, [], 500)).size).toBe(0);
  });
});
