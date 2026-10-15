import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { LadderBandQuote } from "./ladderBandQuotes.js";
import { bandQuoteOwnImpliedVolatility, ladderDayUniverse, lastSeenImpliedVolatilities, planLadderBand, type LadderClock } from "./ladderBandPlan.js";

const clock: LadderClock = { todayIso: "2026-10-20", closeMinutesEt: 16 * 60, riskFreeRate: 0.04 };
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(clock.todayIso, expiry);
// Pluto's 10:00 fit: the 20 Nov forward 100.10 with the stock at 100.
const anchors = new Map([[expiry, { forward: 100.1, spotPrice: 100 }]]);
const settings = { ladderMinDte: 1, ladderMaxDte: 45, ladderMinAbsDelta: 0.05, ladderMaxAbsDelta: 0.3 };

/** A quote at 50% IV with the stock at `stockPrice`, the forward moved with it (100.10 × price ÷ 100). */
function quoteAt(strike: number, right: "C" | "P", stockPrice: number, impliedVolatility = 0.5): LadderBandQuote {
  const mid = blackScholesPriceOnForward(100.1 * (stockPrice / 100), strike, years, clock.riskFreeRate, impliedVolatility, right === "C");
  return { expiry, strike, right, bid: mid - 0.02, ask: mid + 0.02, stockPrice, errorCode: null, quotedAt: new Date("2026-10-20T15:00:00Z"), cycleNumber: 1 };
}

describe("ladderDayUniverse", () => {
  it("keeps the 1–45 DTE expiries' contracts that the previous session's volume can sell one of (5 or more under the 20% rule)", () => {
    const chain = { expirations: ["20261020", "20261120", "20261231"], strikesByExpiry: new Map([["20261020", [100]], ["20261120", [90, 110]], ["20261231", [100]]]) };
    const volume = new Map([["2026-11-20|90|P", 5], ["2026-11-20|110|C", 4], ["2026-11-20|90|C", 500]]);
    // 20 Oct is 0 DTE and 31 Dec is 72 DTE: outside. Of 20 Nov: the $90 Put (5 → 1 contract) and $90 Call (500), not the $110 Call (4 → 0) or the unquoted ones.
    expect(ladderDayUniverse({ ...chain, todayIso: clock.todayIso, settings, previousSessionVolumeByContract: volume })).toEqual([
      { expiry, strike: 90, right: "C" },
      { expiry, strike: 90, right: "P" },
    ]);
  });
});

describe("the last-seen implied volatility", () => {
  it("a quote's own IV is its mid's IV on Pluto's forward moved to the quote's stock price", () => {
    expect(bandQuoteOwnImpliedVolatility(quoteAt(90, "P", 102), anchors, clock)).toBeCloseTo(0.5, 3);
    expect(bandQuoteOwnImpliedVolatility({ ...quoteAt(90, "P", 102), stockPrice: null }, anchors, clock)).toBeNull();
    expect(bandQuoteOwnImpliedVolatility({ ...quoteAt(90, "P", 102), bid: null }, anchors, clock)).toBeNull();
  });

  it("today's own IV first; else last night's IBKR IV plus the expiry's median shift; else unknown", () => {
    const universe = [
      { expiry, strike: 90, right: "P" as const },
      { expiry, strike: 85, right: "P" as const },
      { expiry, strike: 80, right: "P" as const },
    ];
    // The $90 Put quoted today at 50%, IBKR said 49.5% last night: the 20 Nov shift is +0.5 points. The $85 Put, not quoted
    // today, was 52% last night → 52.5%. The $80 Put has neither.
    const lastSeen = lastSeenImpliedVolatilities({ universe, todaysQuotes: [quoteAt(90, "P", 100)], overnightImpliedVolatilityByContract: new Map([[`${expiry}|90|P`, 0.495], [`${expiry}|85|P`, 0.52]]), anchors, clock });
    expect(lastSeen.get(`${expiry}|90|P`)).toBeCloseTo(0.5, 3);
    expect(lastSeen.get(`${expiry}|85|P`)).toBeCloseTo(0.525, 3);
    expect(lastSeen.get(`${expiry}|80|P`)).toBeNull();
  });
});

describe("planLadderBand", () => {
  const strikes = [60, 70, 80, 85, 90, 95, 100];
  const universe = strikes.map((strike) => ({ expiry, strike, right: "P" as const }));
  const absDeltaAt = (strike: number) => Math.abs(blackScholesDelta(100.1, strike, years, clock.riskFreeRate, 0.5, false));
  const overnight = new Map(strikes.map((strike) => [`${expiry}|${strike}|P`, 0.5]));
  const now = new Date("2026-10-20T16:00:00Z");

  it("the first look of the day (no band quote yet) widens to 0.02–0.45; later looks 0.03–0.40", () => {
    const first = planLadderBand({ universe, todaysQuotes: [], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 100, deltaRange: settings });
    expect(first.firstLookOfDay).toBe(true);
    expect(first.contracts.map((contract) => contract.strike)).toEqual(strikes.filter((strike) => absDeltaAt(strike) >= 0.02 && absDeltaAt(strike) <= 0.45));
    const later = planLadderBand({ universe, todaysQuotes: [quoteAt(60, "P", 100)], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 100, deltaRange: settings });
    expect(later.firstLookOfDay).toBe(false);
    expect(later.contracts.map((contract) => contract.strike)).toEqual(strikes.filter((strike) => absDeltaAt(strike) >= 0.03 && absDeltaAt(strike) <= 0.4));
    // The at-the-money $100 Put (|delta| about 0.46) is never quoted; the $60 Put (about 0.01) neither.
    expect(later.contracts.some((contract) => contract.strike === 100 || contract.strike === 60)).toBe(false);
  });

  it("quotes every contract whose IV is unknown, and follows the live price", () => {
    const unknown = planLadderBand({ universe, todaysQuotes: [], overnightImpliedVolatilityByContract: new Map(), anchors, clock, now, stockPrice: 100, deltaRange: settings });
    expect(unknown.contracts).toHaveLength(strikes.length);
    expect(unknown.unknownImpliedVolatilityCount).toBe(strikes.length);
    // The stock falls 10% to $90: the $100 Put is now deep in the money (out of the band) and the $70 Put comes into it.
    const fallen = planLadderBand({ universe, todaysQuotes: [quoteAt(60, "P", 100)], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 90, deltaRange: settings });
    const fallenDelta = (strike: number) => Math.abs(blackScholesDelta(100.1 * 0.9, strike, years, clock.riskFreeRate, 0.5, false));
    expect(fallen.contracts.map((contract) => contract.strike)).toEqual(strikes.filter((strike) => fallenDelta(strike) >= 0.03 && fallenDelta(strike) <= 0.4));
    expect(fallen.contracts.map((contract) => contract.strike)).toContain(70);
    expect(fallen.contracts.map((contract) => contract.strike)).not.toContain(100);
  });
});
