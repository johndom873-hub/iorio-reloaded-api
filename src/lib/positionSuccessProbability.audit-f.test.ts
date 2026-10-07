import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeLegSuccessProbabilities, type SuccessProbabilityLeg } from "./positionSuccessProbability.js";
import { computeSuccessProbability } from "./blackScholesPop.js";
import { formatSignedPercent } from "./formatSignedPercent.js";

// Audit F (2026-10-07): todayInEasternIso() was replaced by easternIsoDate() (no argument = now). The day count must follow the
// Eastern date at the evening hours when the UTC date is already tomorrow, and across the fall-back night.

const shortPut: SuccessProbabilityLeg = { side: "short", optionType: "put", strike: 100, expiryIsoDate: "2026-11-06", stockCostBasisPerShare: null };
const greeks = { delta: -0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 105 };
const expectedFor = (daysToExpiry: number) => computeSuccessProbability({ spotPrice: 105, thresholdPrice: 100, impliedVolatility: 0.4, daysToExpiry, riskFreeRate: 0.04 });

describe("computeLegSuccessProbabilities days to expiry from the Eastern date", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2026-10-30T23:30:00Z", 7], // 19:30 EDT Fri 10-30
    ["2026-10-31T03:30:00Z", 7], // 23:30 EDT Fri 10-30 (UTC already 10-31)
    ["2026-10-31T04:00:00Z", 6], // 00:00 EDT Sat 10-31
    ["2026-11-02T04:59:00Z", 5], // 23:59 EST Sun 11-01 (UTC already 11-02)
    ["2026-11-02T05:00:00Z", 4], // 00:00 EST Mon 11-02
  ])("at %s the leg has %i days", (now, days) => {
    vi.setSystemTime(new Date(now));
    expect(computeLegSuccessProbabilities(shortPut, greeks, 0.04).probabilityByD2).toBe(expectedFor(days));
  });
});

describe("formatSignedPercent", () => {
  it("signs like formatSignedDollars and never shows a negative zero", () => {
    expect(formatSignedPercent(0.5, 2)).toBe("+0.50%");
    expect(formatSignedPercent(-1.25, 2)).toBe("−1.25%");
    expect(formatSignedPercent(-0.004, 2)).toBe("0.00%");
    expect(formatSignedPercent(0.004, 2)).toBe("0.00%");
    expect(formatSignedPercent(-0, 1)).toBe("0.0%");
    expect(formatSignedPercent(12.345, 0)).toBe("+12%");
  });
});
