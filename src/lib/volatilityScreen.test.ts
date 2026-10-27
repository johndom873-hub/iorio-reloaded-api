import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward } from "./impliedVolatilitySurface.js";
import { selectBandEdgeCallStrikes } from "./volatilityConsumer.js";
import type { LiveCallQuote } from "./volatilityLive.js";
import { bestCallYieldsByWindow, callQuoteMaxAgeMs } from "./volatilityScreen.js";

const todayIso = "2026-10-27";
const nowMs = new Date("2026-10-27T15:00:00Z").getTime();
const riskFreeRate = 0.04;
const volatility = 0.5;
const spot = 100;

/** A Call priced at a 50% IV, with a 0.10 spread around the model price. */
function quote(strike: number, expiry: string, daysToExpiry: number, extra: Partial<LiveCallQuote> = {}): LiveCallQuote {
  const years = daysToExpiry / 365;
  const price = blackScholesPriceOnForward(spot * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, volatility, true);
  return { expiry, strike, bid: Math.round((price - 0.05) * 100) / 100, ask: Math.round((price + 0.05) * 100) / 100, stockPrice: spot, quotedAt: new Date(nowMs - 60_000), ...extra };
}

const context = { todayIso, nowMs, band: { min: 0.1, max: 0.5 }, spreadShareCharged: 0, riskFreeRate, yearsToTodaysClose: 0.0005, nextEarningsDateIso: null };

describe("selectBandEdgeCallStrikes", () => {
  it("picks, per band, the highest-delta strike at or under Delta max and the next strike below it", () => {
    const strikes = [90, 95, 100, 105, 110, 115, 120];
    const years = 10 / 365;
    const forward = spot * Math.exp(riskFreeRate * years);
    const picked = selectBandEdgeCallStrikes({ strikes, forward, yearsToExpiry: years, riskFreeRate, impliedVolatility: volatility, bands: [{ min: 0.1, max: 0.5 }, { min: 0.1, max: 0.3 }] });
    const deltaAt = (strike: number) => blackScholesDelta(forward, strike, years, riskFreeRate, volatility, true);
    // 0.50 edge: the first strike whose delta is ≤ 0.50, and the one below it.
    const edge50 = strikes.find((strike) => deltaAt(strike) <= 0.5)!;
    const edge30 = strikes.find((strike) => deltaAt(strike) <= 0.3)!;
    expect(picked).toEqual([...new Set([edge50 - 5, edge50, edge30 - 5, edge30])].sort((a, b) => a - b));
  });
});

describe("bestCallYieldsByWindow", () => {
  it("takes the highest yield per expiry window among quotes whose own delta is inside the band", () => {
    const quotes = [quote(102, "2026-10-30", 3), quote(105, "2026-10-30", 3), quote(103, "2026-11-06", 10), quote(110, "2026-11-20", 24)];
    const best = bestCallYieldsByWindow(quotes, context);
    expect(best.upTo7?.strike).toBe(102); // nearer the money, higher yield
    expect(best.from8To21?.strike).toBe(103);
    expect(best.from22To45?.strike).toBe(110);
    expect(best.upTo7!.delta).toBeLessThanOrEqual(0.5);
    expect(best.upTo7!.yield).toBeGreaterThan(best.from8To21!.yield);
  });

  it("leaves out quotes outside the band, stale quotes and quotes past 45 days", () => {
    const inTheMoney = quote(95, "2026-10-30", 3); // delta above 0.50
    const stale = quote(104, "2026-11-06", 10, { quotedAt: new Date(nowMs - callQuoteMaxAgeMs - 1) });
    const tooFar = quote(110, "2026-12-18", 52);
    expect(bestCallYieldsByWindow([inTheMoney, stale, tooFar], context)).toEqual({ upTo7: null, from8To21: null, from22To45: null });
  });

  it("flags a contract whose expiry is on or after the next earnings date", () => {
    const best = bestCallYieldsByWindow([quote(103, "2026-11-06", 10), quote(110, "2026-11-20", 24)], { ...context, nextEarningsDateIso: "2026-11-06" });
    expect(best.from8To21?.earningsBeforeExpiry).toBe(true);
    expect(best.from22To45?.earningsBeforeExpiry).toBe(true);
    expect(bestCallYieldsByWindow([quote(103, "2026-11-06", 10)], { ...context, nextEarningsDateIso: "2026-11-07" }).from8To21?.earningsBeforeExpiry).toBe(false);
  });
});
