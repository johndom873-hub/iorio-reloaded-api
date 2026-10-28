import { describe, expect, it } from "vitest";
import { blackScholesDelta, blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import { bandQuoteOwnImpliedVolatility, lastSeenImpliedVolatilities, nextListedExpiryAfter, optionQuoteBandDayUniverse, planOptionQuoteBand, type LadderClock } from "./optionQuoteBandPlan.js";

const clock: LadderClock = { todayIso: "2026-10-20", closeMinutesEt: 16 * 60, riskFreeRate: 0.04 };
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(clock.todayIso, expiry);
// Pluto's 10:00 fit: the 20 Nov forward 100.10 with the stock at 100.
const anchors = new Map([[expiry, { forward: 100.1, spotPrice: 100 }]]);
const ladderExpiryRule = { kind: "days_to_expiry_range", minDte: 1, maxDte: 45 } as const;
const callDeltaRange = { minAbsDelta: 0.05, maxAbsDelta: 0.3 };

/** A quote at 50% IV with the stock at `stockPrice`, the forward moved with it (100.10 × price ÷ 100). */
function quoteAt(strike: number, right: "C" | "P", stockPrice: number, impliedVolatility = 0.5): OptionQuoteBandQuote {
  const mid = blackScholesPriceOnForward(100.1 * (stockPrice / 100), strike, years, clock.riskFreeRate, impliedVolatility, right === "C");
  return { expiry, strike, right, bid: mid - 0.02, ask: mid + 0.02, stockPrice, errorCode: null, quotedAt: new Date("2026-10-20T15:00:00Z"), cycleNumber: 1 };
}

describe("optionQuoteBandDayUniverse", () => {
  const chain = { expirations: ["20261020", "20261120", "20261231", "20261023"], strikesByExpiry: new Map([["20261020", [100]], ["20261120", [90, 110]], ["20261231", [100]], ["20261023", [95]]]) };
  const volume = new Map([["2026-11-20|90|P", 5], ["2026-11-20|110|C", 4], ["2026-11-20|90|C", 500], ["2026-10-23|95|C", 40], ["2026-10-20|100|C", 900]]);

  it("the ladder: keeps the 1–45 DTE expiries' contracts that the previous session's volume can sell one of (5 or more under the 20% rule)", () => {
    // 20 Oct is 0 DTE and 31 Dec is 72 DTE: outside. Of 20 Nov: the $90 Put (5 → 1 contract) and $90 Call (500), not the $110 Call (4 → 0) or the unquoted ones; 23 Oct's $95 Call (40).
    expect(optionQuoteBandDayUniverse({ ...chain, sessionIso: clock.todayIso, expiryRule: ladderExpiryRule, previousSessionVolumeByContract: volume })).toEqual([
      { expiry, strike: 90, right: "C" },
      { expiry, strike: 90, right: "P" },
      { expiry: "2026-10-23", strike: 95, right: "C" },
    ]);
  });

  it("Vol Farmer v2: only the next listed expiry after the session, whatever the ladder's range", () => {
    // On Tue 20 Oct: 20 Oct expires that session, so the next listed expiry is Fri 23 Oct (the chain lists it last).
    expect(optionQuoteBandDayUniverse({ ...chain, sessionIso: clock.todayIso, expiryRule: { kind: "next_listed_expiry" }, previousSessionVolumeByContract: volume })).toEqual([{ expiry: "2026-10-23", strike: 95, right: "C" }]);
    expect(nextListedExpiryAfter(chain.expirations, "2026-10-20")).toBe("2026-10-23");
    expect(nextListedExpiryAfter(chain.expirations, "2026-12-31")).toBeNull();
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

describe("planOptionQuoteBand", () => {
  const putStrikes = [60, 70, 80, 85, 90, 95, 100];
  const callStrikes = [100, 105, 110, 120, 130, 140, 160];
  const universe = [...putStrikes.map((strike) => ({ expiry, strike, right: "P" as const })), ...callStrikes.map((strike) => ({ expiry, strike, right: "C" as const }))];
  const callAbsDeltaAt = (strike: number, forward = 100.1) => Math.abs(blackScholesDelta(forward, strike, years, clock.riskFreeRate, 0.5, true));
  const overnight = new Map(universe.map((contract) => [`${expiry}|${contract.strike}|${contract.right}`, 0.5]));
  const now = new Date("2026-10-20T16:00:00Z");
  const strikesOf = (contracts: { strike: number; right: "C" | "P" }[], right: "C" | "P") => contracts.filter((contract) => contract.right === right).map((contract) => contract.strike);

  it("the Calls' band: the first look of the day (no band quote yet) widens to 0.02–0.45, later looks 0.03–0.40; every Put below the price, any |delta|", () => {
    const first = planOptionQuoteBand({ universe, todaysQuotes: [], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 100, callDeltaRange });
    expect(first.firstLookOfDay).toBe(true);
    expect(strikesOf(first.contracts, "C")).toEqual(callStrikes.filter((strike) => callAbsDeltaAt(strike) >= 0.02 && callAbsDeltaAt(strike) <= 0.45));
    const later = planOptionQuoteBand({ universe, todaysQuotes: [quoteAt(60, "P", 100)], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 100, callDeltaRange });
    expect(later.firstLookOfDay).toBe(false);
    expect(strikesOf(later.contracts, "C")).toEqual(callStrikes.filter((strike) => callAbsDeltaAt(strike) >= 0.03 && callAbsDeltaAt(strike) <= 0.4));
    // The ladder's Puts have no |delta| range: the $60 Put (|delta| about 0.01) is quoted; the $100 Put, at the price, is not.
    expect(strikesOf(later.contracts, "P")).toEqual([60, 70, 80, 85, 90, 95]);
  });

  it("quotes every Call whose IV is unknown and every Put below the price, and follows the live price", () => {
    const unknown = planOptionQuoteBand({ universe, todaysQuotes: [], overnightImpliedVolatilityByContract: new Map(), anchors, clock, now, stockPrice: 100, callDeltaRange });
    expect(strikesOf(unknown.contracts, "C")).toEqual(callStrikes);
    expect(strikesOf(unknown.contracts, "P")).toEqual([60, 70, 80, 85, 90, 95]);
    expect(unknown.unknownImpliedVolatilityCount).toBe(universe.length);
    // The stock falls 10% to $90: the Puts at $90 and above leave, the Calls' band moves down with the forward.
    const fallen = planOptionQuoteBand({ universe, todaysQuotes: [quoteAt(60, "P", 100)], overnightImpliedVolatilityByContract: overnight, anchors, clock, now, stockPrice: 90, callDeltaRange });
    expect(strikesOf(fallen.contracts, "P")).toEqual([60, 70, 80, 85]);
    expect(strikesOf(fallen.contracts, "C")).toEqual(callStrikes.filter((strike) => callAbsDeltaAt(strike, 100.1 * 0.9) >= 0.03 && callAbsDeltaAt(strike, 100.1 * 0.9) <= 0.4));
  });
});
