import { describe, expect, it } from "vitest";
import { hasPreviousSessionVolumeForOneContract, optionRequoteBand, selectOptionRequoteContracts, type OptionRequoteContract } from "./optionRequoteBand.js";

const ladderRange = { minAbsDelta: 0.05, maxAbsDelta: 0.3 };
const spotForward = (stockPrice: number, rate: number) => (_expiry: string, years: number) => stockPrice * Math.exp(rate * years);

describe("optionRequoteBand", () => {
  it("widens 0.05–0.30 to 0.03–0.40 at later looks and 0.02–0.45 at the first look", () => {
    const later = optionRequoteBand(ladderRange, false);
    const first = optionRequoteBand(ladderRange, true);
    expect(later.minAbsDelta).toBeCloseTo(0.03, 12);
    expect(later.maxAbsDelta).toBeCloseTo(0.4, 12);
    expect(first.minAbsDelta).toBeCloseTo(0.02, 12);
    expect(first.maxAbsDelta).toBeCloseTo(0.45, 12);
  });

  it("never goes below 0", () => {
    expect(optionRequoteBand({ minAbsDelta: 0.01, maxAbsDelta: 0.3 }, true).minAbsDelta).toBe(0);
  });
});

describe("hasPreviousSessionVolumeForOneContract", () => {
  it("needs a previous-session volume of at least 5 (one contract at 20%)", () => {
    expect(hasPreviousSessionVolumeForOneContract(5)).toBe(true);
    expect(hasPreviousSessionVolumeForOneContract(4)).toBe(false);
    expect(hasPreviousSessionVolumeForOneContract(null)).toBe(false);
  });
});

describe("selectOptionRequoteContracts", () => {
  it("quotes the design's HOOD example at 11:00: the $107 Put · 9 Oct (1DTE) predicted near −0.27 from its 63.3% IV", () => {
    const hoodPut: OptionRequoteContract = { expiry: "2026-10-09", strike: 107, right: "P", lastSeenImpliedVolatility: 0.633 };
    const inTheMoneyPut: OptionRequoteContract = { expiry: "2026-10-09", strike: 115, right: "P", lastSeenImpliedVolatility: 0.633 };
    const farCall: OptionRequoteContract = { expiry: "2026-10-09", strike: 140, right: "C", lastSeenImpliedVolatility: 0.633 };
    const neverQuoted: OptionRequoteContract = { expiry: "2026-10-16", strike: 150, right: "C", lastSeenImpliedVolatility: null };
    const result = selectOptionRequoteContracts({ universe: [hoodPut, inTheMoneyPut, farCall, neverQuoted], band: optionRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(result.toQuote).toEqual([hoodPut, neverQuoted]);
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|107|P")).toBeCloseTo(0.27, 1);
    expect(result.predictedAbsDeltaByKey.has("2026-10-09|115|P")).toBe(false);
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|140|C")!).toBeLessThan(0.03);
  });

  it("quotes every Put below the price at any |delta| (the ladder's Puts have no range), the Calls only inside the band", () => {
    // HOOD at 109.15: the $80 Put is far below the band's 0.03 and the $105 Call inside it; an unknown IV is quoted only below the price.
    const farPut: OptionRequoteContract = { expiry: "2026-10-09", strike: 80, right: "P", lastSeenImpliedVolatility: 0.633 };
    const nearCall: OptionRequoteContract = { expiry: "2026-10-09", strike: 112, right: "C", lastSeenImpliedVolatility: 0.633 };
    const farCall: OptionRequoteContract = { expiry: "2026-10-09", strike: 80, right: "C", lastSeenImpliedVolatility: 0.633 };
    const unknownBelow: OptionRequoteContract = { expiry: "2026-10-16", strike: 100, right: "P", lastSeenImpliedVolatility: null };
    const unknownAbove: OptionRequoteContract = { expiry: "2026-10-16", strike: 120, right: "P", lastSeenImpliedVolatility: null };
    const result = selectOptionRequoteContracts({ universe: [farPut, nearCall, farCall, unknownBelow, unknownAbove], band: optionRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(result.predictedAbsDeltaByKey.get("2026-10-09|80|P")!).toBeLessThan(0.03);
    expect(result.toQuote).toEqual([farPut, nearCall, unknownBelow]);
  });

  it("prices a same-day expiry on the hours to today's close", () => {
    const sameDay: OptionRequoteContract = { expiry: "2026-10-08", strike: 108, right: "P", lastSeenImpliedVolatility: 0.6 };
    const withHoursLeft = selectOptionRequoteContracts({ universe: [sameDay], band: optionRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 5 / 8760, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    const atTheClose = selectOptionRequoteContracts({ universe: [sameDay], band: optionRequoteBand(ladderRange, false), stockPrice: 109.15, todayIso: "2026-10-08", yearsToTodaysClose: 0, riskFreeRate: 0.04, forwardFor: spotForward(109.15, 0.04) });
    expect(withHoursLeft.toQuote).toEqual([sameDay]);
    expect(atTheClose.toQuote).toEqual([]);
  });
});
