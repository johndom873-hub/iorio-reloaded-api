import { describe, expect, it } from "vitest";
import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { anchorCurveOf, anchorFactorAt, impliedVolatilityRatioNear, nearestObservedContract, observedAgainstAnchor, observedChainDayOf, observedDaysNearest, quoteLikeObserved, standardDeviationsOf, thirtyDayIvElevation } from "./portfolioObservedChain.js";
import { syntheticExpiryChain } from "./portfolioSyntheticChain.js";

const sixHours = 6 / 8_760;

describe("an observed chain day", () => {
  it("places EEM's $66.50 Call 1.44 standard deviations out at $66.00, 20% IV and 6 hours to a same-day expiry", () => {
    expect(standardDeviationsOf(66.5, 66, 0.2, sixHours)).toBeCloseTo(Math.log(66.5 / 66) / (0.2 * Math.sqrt(sixHours)), 12);
    expect(standardDeviationsOf(66.5, 66, 0.2, sixHours)).toBeCloseTo(1.44, 2);
  });

  it("keeps each contract's IV ratio, half-spread share and previous-session volume, none for a contract with no bid", () => {
    const day = observedChainDayOf({
      dateIso: "2026-10-30",
      expiry: "2026-10-30",
      quotes: [
        { expiry: "2026-10-30", strike: 66.5, right: "C", bid: 0.01, ask: 0.04, bidSize: 10, askSize: 10 },
        { expiry: "2026-10-30", strike: 67, right: "C", bid: 0, ask: 0.02, bidSize: 0, askSize: 10 },
        { expiry: "2026-11-06", strike: 66.5, right: "C", bid: 0.3, ask: 0.35, bidSize: 10, askSize: 10 },
      ],
      previousEndOfDay: [{ expiry: "2026-10-30", strike: 66.5, right: "C", close: 0.03, volume: 120, bid: 0.01, ask: 0.04 }],
      stockPrice: 66,
      impliedVolatility: 0.2,
      yearsToExpiry: sixHours,
      riskFreeRate: 0.04,
    })!;
    expect(day.daysToExpiry).toBe(0);
    expect(day.calls.map((contract) => [contract.halfSpreadShare, contract.previousSessionVolume])).toEqual([
      [0.6, 120],
      [null, 0],
    ]);
    expect(day.puts).toEqual([]);
    // The $66.50 Call's mid 0.025 on the forward, 6 hours out: its own IV ÷ the 30-day 20%.
    const ownVolatility = day.calls[0]!.impliedVolatilityRatio! * 0.2;
    expect(blackScholesPriceOnForward(66 * Math.exp(0.04 * sixHours), 66.5, sixHours, 0.04, ownVolatility, true)).toBeCloseTo(0.025, 6);
    expect(day.calls[1]!.impliedVolatilityRatio).toBeNull();
  });

  it("draws among the days with the same days to expiry, else the nearest", () => {
    const day = (dateIso: string, daysToExpiry: number) => ({ dateIso, daysToExpiry, calls: [], puts: [] });
    const days = [day("a", 0), day("b", 2), day("c", 0), day("d", 4)];
    expect(observedDaysNearest(days, 0).map((entry) => entry.dateIso)).toEqual(["a", "c"]);
    expect(observedDaysNearest(days, 3).map((entry) => entry.dateIso)).toEqual(["b", "d"]);
  });
});

describe("a synthetic contract quoted like an observed one", () => {
  const observed = { standardDeviations: 1.44, impliedVolatilityRatio: 1.6, halfSpreadShare: 0.6, previousSessionVolume: 120 };

  it("quotes a $0.05 mid at 0.02 / 0.08 and a $0.20 mid at 0.08 / 0.32, with the observed volume", () => {
    expect(quoteLikeObserved(0.05, observed)).toEqual({ bid: 0.02, ask: 0.08, previousSessionVolume: 120 });
    expect(quoteLikeObserved(0.2, observed)).toEqual({ bid: 0.08, ask: 0.32, previousSessionVolume: 120 });
  });

  it("has no bid where the observed contract had none, and keeps the ask a cent above a bid rounded onto it", () => {
    expect(quoteLikeObserved(0.2, { ...observed, halfSpreadShare: null })?.bid).toBeNull();
    expect(quoteLikeObserved(0.3, { ...observed, halfSpreadShare: 0.001 })).toEqual({ bid: 0.3, ask: 0.31, previousSessionVolume: 120 });
  });

  it("takes the nearest observed contract, and none past the outermost gap beyond the listed strikes", () => {
    const contracts = [-1, 0, 1].map((standardDeviations) => ({ standardDeviations, impliedVolatilityRatio: null, halfSpreadShare: 0.1, previousSessionVolume: standardDeviations + 10 }));
    expect(nearestObservedContract(contracts, 0.4)?.previousSessionVolume).toBe(10);
    expect(nearestObservedContract(contracts, 0.6)?.previousSessionVolume).toBe(11);
    expect(nearestObservedContract(contracts, 1.9)?.previousSessionVolume).toBe(11);
    expect(nearestObservedContract(contracts, 2.1)).toBeNull();
    expect(nearestObservedContract(contracts, -2.1)).toBeNull();
  });

  // $65.50 (in the money, −1.45 standard deviations on the 30-day IV) is past the observed strikes.
  it("lists only the strikes the observed day reaches, each priced at the 30-day IV × its observed IV ratio", () => {
    const day = { dateIso: "2026-10-30", daysToExpiry: 0, calls: [0, 1.44].map((standardDeviations, index) => ({ standardDeviations, impliedVolatilityRatio: [1.5, 3.0][index]!, halfSpreadShare: 0.2, previousSessionVolume: 500 })), puts: [] };
    const chain = syntheticExpiryChain({ expiry: "2026-10-30", stockPrice: 66, yearsToExpiry: sixHours, riskFreeRate: 0.04, volatility: 0.3, strikeSpacing: 0.5, observed: { day, thirtyDayVolatility: 0.2 } });
    expect(chain.quotes.every((quote) => quote.right === "C")).toBe(true);
    expect(chain.quotes.map((quote) => quote.strike).sort((a, b) => a - b)).toEqual([66, 66.5, 67]);
    const forward = 66 * Math.exp(0.04 * sixHours);
    const midOf = (strike: number, ratio: number) => Math.round(blackScholesPriceOnForward(forward, strike, sixHours, 0.04, 0.2 * ratio, true) * 100) / 100;
    const sixtySix = chain.quotes.find((quote) => quote.strike === 66)!;
    expect(Math.round(((sixtySix.bid! + sixtySix.ask!) / 2) * 100) / 100).toBeCloseTo(midOf(66, 1.5), 2);
    // $67 stands 2.88 standard deviations out: within the outermost gap past $66.50, priced on its ratio of 3.0 (a mid of about $0.09).
    const sixtySeven = chain.quotes.find((quote) => quote.strike === 67)!;
    expect(sixtySeven.bid).toBeCloseTo(Math.round(midOf(67, 3.0) * 0.8 * 100) / 100, 2);
    expect([...chain.previousSessionVolumeByContract.values()].every((volume) => volume === 500)).toBe(true);
  });

  it("prices at the nearest observed contract with an IV ratio when the nearest has none", () => {
    const contracts = [
      { standardDeviations: 0, impliedVolatilityRatio: 1.5, halfSpreadShare: 0.1, previousSessionVolume: 10 },
      { standardDeviations: 1, impliedVolatilityRatio: null, halfSpreadShare: null, previousSessionVolume: 0 },
      { standardDeviations: 3, impliedVolatilityRatio: 2.2, halfSpreadShare: 0.5, previousSessionVolume: 1 },
    ];
    expect(impliedVolatilityRatioNear(contracts, 1.2)).toBe(1.5);
    expect(impliedVolatilityRatioNear(contracts, 2.2)).toBe(2.2);
  });
});

describe("the volatility anchor", () => {
  it("reads the 30-day IV against the median of the sessions before it, from 40 of them", () => {
    const before = Array.from({ length: 60 }, (_, index) => 0.2 + (index % 2) * 0.1);
    expect(thirtyDayIvElevation(0.5, before)).toBeCloseTo(0.5 / 0.25, 12);
    expect(thirtyDayIvElevation(0.5, before.slice(0, 39))).toBeNull();
  });

  it("gives CSCO-like factors: 1 in the normal band, 0.74 when the 30-day IV runs 1.37× its median", () => {
    const normal = Array.from({ length: 30 }, () => ({ elevation: 1.0, atMoneyRatio: 1.7 }));
    const runUp = Array.from({ length: 12 }, () => ({ elevation: 1.37, atMoneyRatio: 1.25 }));
    const sparse = Array.from({ length: 5 }, () => ({ elevation: 2.0, atMoneyRatio: 3 }));
    const curve = anchorCurveOf([...normal, ...runUp, ...sparse]);
    expect(curve).toEqual([
      { elevation: 1.0, factor: 1 },
      { elevation: 1.37, factor: 1.25 / 1.7 },
    ]);
    expect(anchorFactorAt(curve, 1.185)).toBeCloseTo((1 + 1.25 / 1.7) / 2, 12);
    expect(anchorFactorAt(curve, 0.5)).toBe(1);
    expect(anchorFactorAt(curve, 3)).toBeCloseTo(1.25 / 1.7, 12);
    expect(anchorFactorAt(curve, null)).toBe(1);
    expect(anchorFactorAt([], 1.4)).toBe(1);
  });

  it("reads a day against its anchor: positions and IV ratios ÷ the factor", () => {
    const day = { dateIso: "2026-10-30", daysToExpiry: 0, calls: [{ standardDeviations: 1.48, impliedVolatilityRatio: 1.25, halfSpreadShare: 0.1, previousSessionVolume: 5 }], puts: [] };
    const anchored = observedAgainstAnchor(day, 0.74);
    expect(anchored.calls[0]!.standardDeviations).toBeCloseTo(2, 12);
    expect(anchored.calls[0]!.impliedVolatilityRatio).toBeCloseTo(1.25 / 0.74, 12);
    expect(anchored.calls[0]!.previousSessionVolume).toBe(5);
  });
});
