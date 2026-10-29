import { describe, expect, it } from "vitest";
import { gradeForEdgeMargin, valueContract, type ContractValuation, type ContractValuationInput } from "./contractValuation.js";
import { enableExactInputCaches, exactInputCachesAreEnabled } from "./exactInputCaches.js";
import { calibratedEdgeMargin, standardizedReturnBucketsFor, type VolatilityModelTables } from "./volatilityModelTables.js";
import { volatilityModelTables } from "./volatilityModelTables.generated.js";
import { blackScholesPriceOnForward } from "./impliedVolatilitySurface.js";

function tablesWith(buckets: number[], calibration: VolatilityModelTables["calibration"] = []): VolatilityModelTables {
  return { builtAtIso: "", source: "test", sampleFromIso: "", sampleToIso: "", bucketCount: buckets.length, maxHorizon: 2, standardizedReturnBuckets: { etf: [buckets, buckets], stock: [buckets, buckets] }, sampleCounts: { etf: [0, 0], stock: [0, 0] }, calibration };
}
const base: ContractValuationInput = { isCall: false, strike: 100, forward: 100, mid: 2, frictionDollars: 0, perSessionVariance: 0.0004, varianceSessions: 1, calendarYears: 0, sessionsHeld: 1, riskFreeRate: 0, group: "stock", spot: 100 };

describe("valueContract (P4/P5, approved 2026-10-10)", () => {
  it("prices from the buckets, normalized so the mean outcome is the forward", () => {
    // two outcomes z = ±1, s = 0.02: S = 100·e^{±0.02}/m, m = cosh(0.02)
    const tables = tablesWith([-1, 1]);
    const valuation = valueContract(tables, { ...base, mid: 1 })!;
    const m = Math.cosh(0.02);
    const low = (100 * Math.exp(-0.02)) / m;
    expect(valuation.fairPrice).toBeCloseTo((100 - low) / 2, 10);
    expect(valuation.edgeMargin).toBeCloseTo(1 - valuation.fairPrice / 1, 12);
    expect(valuation.expectedPnlDollars).toBeCloseTo(100 - valuation.fairPrice * 100, 8);
    // the up outcome keeps the $1 premium; the down one pays (100 − low) ≈ $1.98 a share
    expect(valuation.probabilityOfProfit).toBe(0.5);
    expect(valuation.averageWinDollars).toBeCloseTo(100, 8);
    expect(valuation.averageLossDollars).toBeCloseTo(100 - (100 - low) * 100, 8);
    expect(valuation.expectedShortfallDollars).toBeCloseTo(100 - (100 - low) * 100, 8);
  });

  it("matches Black-Scholes when the buckets are a normal distribution", () => {
    const tables = volatilityModelTablesNormal();
    for (const strike of [95, 100, 105]) {
      const isCall = strike >= 100;
      const valuation = valueContract(tables, { ...base, strike, isCall, mid: 3 })!;
      const blackScholes = blackScholesPriceOnForward(100, strike, base.varianceSessions / 252, 0, Math.sqrt(base.perSessionVariance * 252), isCall);
      expect(valuation.fairPrice).toBeCloseTo(blackScholes, 2);
    }
  });

  it("charges friction once, in every outcome", () => {
    const tables = tablesWith([-1, 1]);
    const free = valueContract(tables, base)!;
    const charged = valueContract(tables, { ...base, frictionDollars: 5 })!;
    expect(charged.expectedPnlDollars).toBeCloseTo(free.expectedPnlDollars - 5, 8);
    expect(charged.premiumAfterCostsDollars).toBeCloseTo(195, 8);
    expect(charged.edgeMargin).toBeCloseTo(free.edgeMargin, 12); // margin is before friction
  });

  it("annualizes over the sessions held against capital at risk net of the premium, whatever the variance or calendar time", () => {
    // Friday → Monday: 1.3 trading days of variance and 3 calendar days (discounting only), but the capital is held 2
    // sessions, Friday's and Monday's: × 252 ÷ 2.
    // A $100 put sold at $2: $10,000 reserved less the $200 received = $9,800 at risk.
    const valuation = valueContract(tablesWith([-1, 1]), { ...base, varianceSessions: 1.3, calendarYears: 3 / 365, sessionsHeld: 2 })!;
    expect(valuation.capitalAtRiskDollars).toBeCloseTo(9_800, 9);
    expect(valuation.sessionsHeld).toBe(2);
    expect(valuation.expectedAnnualizedReturn).toBeCloseTo((valuation.expectedPnlDollars / 9_800) * (252 / 2), 10);
    expect(valuation.premiumYield).toBeCloseTo((200 / 9_800) * (252 / 2), 10);
    // Never annualized over less than one session.
    expect(valueContract(tablesWith([-1, 1]), { ...base, sessionsHeld: 0 })!.premiumYield).toBeCloseTo((200 / 9_800) * 252, 10);
    // A covered call: 100 shares at the $104 spot less the premium.
    expect(valueContract(tablesWith([-1, 1]), { ...base, isCall: true, spot: 104 })!.capitalAtRiskDollars).toBeCloseTo(10_200, 9);
  });

  it("stresses both a put and a covered call with the stock down two standard deviations", () => {
    const tables = tablesWith([-1, 1]);
    const put = valueContract(tables, base)!;
    expect(put.stressPnlDollars).toBeCloseTo(200 - (100 - 100 * Math.exp(-0.04)) * 100, 8);
    // The call expires worthless; the shares lose the same 3.9% the put's strike is breached by.
    const call = valueContract(tables, { ...base, isCall: true })!;
    expect(call.stressPnlDollars).toBeCloseTo(200 + (100 * Math.exp(-0.04) - 100) * 100, 8);
    expect(call.coveredPositionPnlVarianceDollars).not.toBeNull();
    expect(put.coveredPositionPnlVarianceDollars).toBeNull();
  });

  it("judges a covered call's risk on the shares and the call together: at the forward strike, exactly a cash-secured put's", () => {
    // Put-call parity at K = F with no interest: 100 shares + a short call pay what a short put pays, outcome by outcome.
    const tables = tablesWith([-2.1, -1.2, -0.4, 0.1, 0.5, 0.9, 1.3, 1.8]);
    const put = valueContract(tables, base)!;
    const call = valueContract(tables, { ...base, isCall: true })!;
    for (const key of ["probabilityOfProfit", "averageWinDollars", "averageLossDollars", "expectedShortfallDollars", "stressPnlDollars", "expectedPnlDollars"] as const) expect(call[key]).toBeCloseTo(put[key], 9);
    // The call alone would never lose on a fall; with the shares, its worst outcomes are the falls.
    expect(call.expectedShortfallDollars).toBeLessThan(0);
    expect(call.pnlVarianceDollars).not.toBeCloseTo(call.coveredPositionPnlVarianceDollars!, 3);
  });

  it("refuses inputs it cannot value", () => {
    const tables = tablesWith([-1, 1]);
    expect(valueContract(tables, { ...base, mid: 0 })).toBeNull();
    expect(valueContract(tables, { ...base, varianceSessions: 0 })).toBeNull();
    expect(valueContract(tables, { ...base, perSessionVariance: 0 })).toBeNull();
    // A premium at or above the strike (put) or the spot (call) leaves nothing at risk to annualize on.
    expect(valueContract(tables, { ...base, mid: 100 })).toBeNull();
    expect(valueContract(tables, { ...base, isCall: true, mid: 100 })).toBeNull();
  });

  it("grades on the edge margin at 20 / 10 / 0 %", () => {
    expect(gradeForEdgeMargin(0.2)).toBe("strong");
    expect(gradeForEdgeMargin(0.1999)).toBe("good");
    expect(gradeForEdgeMargin(0.1)).toBe("good");
    expect(gradeForEdgeMargin(0.0999)).toBe("weak");
    expect(gradeForEdgeMargin(0)).toBe("weak");
    expect(gradeForEdgeMargin(-0.0001)).toBe("avoid");
  });
});

describe("calibratedEdgeMargin", () => {
  const tables = tablesWith([0], [
    { horizon: 1, points: [{ predictedMargin: 0, realizedMargin: 0, rawRealizedMargin: 0, realizedLow: 0, realizedHigh: 0, count: 1 }, { predictedMargin: 0.4, realizedMargin: 0.2, rawRealizedMargin: 0.2, realizedLow: 0.2, realizedHigh: 0.2, count: 1 }] },
    { horizon: 3, points: [{ predictedMargin: 0, realizedMargin: -0.1, rawRealizedMargin: -0.1, realizedLow: -0.1, realizedHigh: -0.1, count: 1 }, { predictedMargin: 0.4, realizedMargin: 0.1, rawRealizedMargin: 0.1, realizedLow: 0.1, realizedHigh: 0.1, count: 1 }] },
  ]);
  it("interpolates within a row and holds flat beyond its ends", () => {
    expect(calibratedEdgeMargin(tables, 0.2, 1)).toBeCloseTo(0.1, 12);
    expect(calibratedEdgeMargin(tables, 0.8, 1)).toBeCloseTo(0.2, 12);
    expect(calibratedEdgeMargin(tables, -0.5, 1)).toBeCloseTo(0, 12);
  });
  it("interpolates between horizons and clamps outside them", () => {
    expect(calibratedEdgeMargin(tables, 0.2, 2)).toBeCloseTo((0.1 + 0) / 2, 12);
    expect(calibratedEdgeMargin(tables, 0.2, 0.3)).toBeCloseTo(0.1, 12);
    expect(calibratedEdgeMargin(tables, 0.2, 9)).toBeCloseTo(0, 12);
  });
});

describe("the committed tables", () => {
  it("cover both groups and every horizon, ascending", () => {
    for (const group of ["etf", "stock"] as const) {
      expect(volatilityModelTables.standardizedReturnBuckets[group]).toHaveLength(volatilityModelTables.maxHorizon);
      for (const buckets of volatilityModelTables.standardizedReturnBuckets[group]) {
        expect(buckets).toHaveLength(volatilityModelTables.bucketCount);
        expect([...buckets].sort((a, b) => a - b)).toEqual(buckets);
      }
    }
    expect(standardizedReturnBucketsFor(volatilityModelTables, "stock", 99)).toBe(volatilityModelTables.standardizedReturnBuckets.stock.at(-1));
    expect(standardizedReturnBucketsFor(volatilityModelTables, "stock", 0.2)).toBe(volatilityModelTables.standardizedReturnBuckets.stock[0]);
  });
  it("carry the at-the-money calibration rows", () => {
    expect(volatilityModelTables.calibration.map((row) => row.horizon)).toEqual([1, 2, 3, 5, 10, 21]);
  });
});

/** 4,000 bucket means of a standard normal (midpoint rule on a fine quantile grid). */
function volatilityModelTablesNormal(): VolatilityModelTables {
  const buckets: number[] = [];
  const count = 4_000;
  for (let bucket = 0; bucket < count; bucket++) {
    let sum = 0;
    const steps = 20;
    for (let step = 0; step < steps; step++) sum += inverseStandardNormal((bucket + (step + 0.5) / steps) / count);
    buckets.push(sum / steps);
  }
  return tablesWith(buckets);
}

/** Acklam's rational approximation of the inverse standard normal CDF (relative error < 1.2e-9). */
function inverseStandardNormal(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

describe("valueContract answers the same in any order", () => {
  // Valuations are kept by their exact inputs (where the exact-input caches are on) and the strikes of an expiry share
  // their outcome prices: the answer may not depend on what was valued before, and each caller gets its own copy.
  const inputs: ContractValuationInput[] = [];
  for (const varianceSessions of [3.5, 12.25, 30]) {
    for (const strike of [80, 95, 100, 105, 120]) {
      for (const isCall of [true, false]) inputs.push({ isCall, strike, forward: 101, mid: 1.5 + strike / 100, frictionDollars: 3, perSessionVariance: 0.0006, varianceSessions, calendarYears: varianceSessions / 252, sessionsHeld: Math.ceil(varianceSessions), riskFreeRate: 0.04, group: "stock", spot: 100.5 });
    }
  }
  function valuedInAnyOrder(): (ContractValuation | null)[] {
    const inOrder = inputs.map((input) => valueContract(volatilityModelTables, input));
    const reversed = [...inputs].reverse().map((input) => valueContract(volatilityModelTables, input)).reverse();
    const interleaved = inputs.map((_, index) => inputs[(index * 7) % inputs.length]!).map((input) => [input, valueContract(volatilityModelTables, input)] as const);
    expect(reversed).toStrictEqual(inOrder);
    for (const [input, valuation] of interleaved) expect(valuation).toStrictEqual(inOrder[inputs.indexOf(input)]);
    const first = valueContract(volatilityModelTables, inputs[0]!)!;
    first.fairPrice = -1;
    expect(valueContract(volatilityModelTables, inputs[0]!)).toStrictEqual(inOrder[0]);
    return inOrder;
  }

  // Off first: switching the caches on lasts for the rest of this file.
  it("caches off, as in the API and Pluto's agent: valued fresh, interleaved and again", () => {
    expect(exactInputCachesAreEnabled()).toBe(false);
    valuedInAnyOrder();
  });

  it("caches on, as in a backtest: the same answers as with them off", () => {
    const uncached = inputs.map((input) => valueContract(volatilityModelTables, input));
    enableExactInputCaches();
    expect(valuedInAnyOrder()).toStrictEqual(uncached);
  });
});
