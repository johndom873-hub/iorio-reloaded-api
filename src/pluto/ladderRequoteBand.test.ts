import { describe, expect, it } from "vitest";
import { isInLadderUniverse, ladderRequoteBand, selectLadderRequoteContracts, type LadderRequoteContract } from "./ladderRequoteBand.js";

const ladderRange = { ladderMinAbsDelta: 0.05, ladderMaxAbsDelta: 0.3 };
const spotForward = (stockPrice: number, rate: number) => (_expiry: string, years: number) => stockPrice * Math.exp(rate * years);

describe("ladderRequoteBand", () => {
  it("widens 0.05–0.30 to 0.03–0.40 at later looks and 0.02–0.45 at the first look", () => {
    const later = ladderRequoteBand(ladderRange, false);
    const first = ladderRequoteBand(ladderRange, true);
    expect(later.minAbsDelta).toBeCloseTo(0.03, 12);
    expect(later.maxAbsDelta).toBeCloseTo(0.4, 12);
    expect(first.minAbsDelta).toBeCloseTo(0.02, 12);
    expect(first.maxAbsDelta).toBeCloseTo(0.45, 12);
  });

  it("never goes below 0", () => {
    expect(ladderRequoteBand({ ladderMinAbsDelta: 0.01, ladderMaxAbsDelta: 0.3 }, true).minAbsDelta).toBe(0);
  });
});

describe("isInLadderUniverse", () => {
  const settings = { ladderMinDte: 1, ladderMaxDte: 45 };
  it("needs the ladder's days to expiry and a previous-session volume of at least 5 (one contract at 20%)", () => {
    expect(isInLadderUniverse({ expiry: "2026-10-16" }, 5, settings, "2026-10-15")).toBe(true);
    expect(isInLadderUniverse({ expiry: "2026-10-16" }, 4, settings, "2026-10-15")).toBe(false);
    expect(isInLadderUniverse({ expiry: "2026-10-16" }, null, settings, "2026-10-15")).toBe(false);
    expect(isInLadderUniverse({ expiry: "2026-10-15" }, 100, settings, "2026-10-15")).toBe(false);
    expect(isInLadderUniverse({ expiry: "2026-11-30" }, 100, settings, "2026-10-15")).toBe(false);
    expect(isInLadderUniverse({ expiry: "2026-11-29" }, 100, settings, "2026-10-15")).toBe(true);
  });
});

describe("selectLadderRequoteContracts", () => {
  it("quotes the design's HOOD example at 11:00: the $107 Put · 9 Oct (1DTE) predicted near −0.27 from its 63.3% IV", () => {
    const hoodPut: LadderRequoteContract = { expiry: "2026-10-09", strike: 107, right: "P", lastSeenImpliedVolatility: 0.633 };
    const inTheMoneyPut: LadderRequoteContract = { expiry: "2026-10-09", strike: 115, right: "P", lastSeenImpliedVolatility: 0.633 };
    const farCall: LadderRequoteContract = { expiry: "2026-10-09", strike: 140, right: "C", lastSeenImpliedVolatility: 0.633 };
    const neverQuoted: LadderRequoteContract = { expiry: "2026-10-16", strike: 150, right: "C", lastSeenImpliedVolatility: null };
    const result = selectLadderRequoteContracts({ universe: [hoodPut, inTheMoneyPut, farCall, neverQuoted], band: ladderRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(result.toQuote).toEqual([hoodPut, neverQuoted]);
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|107|P")).toBeCloseTo(0.27, 1);
    expect(result.predictedAbsDeltaByKey.has("2026-10-09|115|P")).toBe(false);
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|140|C")!).toBeLessThan(0.03);
  });

  it("quotes every Put below the price at any |delta| (the ladder's Puts have no range), the Calls only inside the band", () => {
    // HOOD at 109.15: the $80 Put is far below the band's 0.03 and the $105 Call inside it; an unknown IV is quoted only below the price.
    const farPut: LadderRequoteContract = { expiry: "2026-10-09", strike: 80, right: "P", lastSeenImpliedVolatility: 0.633 };
    const nearCall: LadderRequoteContract = { expiry: "2026-10-09", strike: 112, right: "C", lastSeenImpliedVolatility: 0.633 };
    const farCall: LadderRequoteContract = { expiry: "2026-10-09", strike: 80, right: "C", lastSeenImpliedVolatility: 0.633 };
    const unknownBelow: LadderRequoteContract = { expiry: "2026-10-16", strike: 100, right: "P", lastSeenImpliedVolatility: null };
    const unknownAbove: LadderRequoteContract = { expiry: "2026-10-16", strike: 120, right: "P", lastSeenImpliedVolatility: null };
    const result = selectLadderRequoteContracts({ universe: [farPut, nearCall, farCall, unknownBelow, unknownAbove], band: ladderRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|80|P")!).toBeLessThan(0.03);
    expect(result.toQuote).toEqual([farPut, nearCall, unknownBelow]);
  });

  it("prices a same-day expiry on the hours to today's close", () => {
    const sameDay: LadderRequoteContract = { expiry: "2026-10-08", strike: 108, right: "P", lastSeenImpliedVolatility: 0.6 };
    const withHoursLeft = selectLadderRequoteContracts({ universe: [sameDay], band: ladderRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    const atTheClose = selectLadderRequoteContracts({ universe: [sameDay], band: ladderRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 0, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(withHoursLeft.toQuote).toEqual([sameDay]);
    expect(atTheClose.toQuote).toEqual([]);
  });
});
