import { describe, expect, it } from "vitest";
import { callDaysPerWeekAtTodaysPace, lotFitScale, tickerPartsFromWeeks, type BacktestWeek } from "./portfolioParts.js";

const week = (overrides: Partial<BacktestWeek>): BacktestWeek => ({ week: "2026-01-05", accountStart: 100_000, accountEnd: 100_000, premium: 0, callDays: 0, interest: 0, sharesShare: 0.8, stockReturn: 0, ...overrides });

describe("tickerPartsFromWeeks (P1, P3, shares held)", () => {
  it("measures k as the premium per account × IV × Call day", () => {
    // $520 on a $100,000 account at IV 26% over 2 Call days: 520 ÷ (100,000 × 0.26 × 2) = 0.01.
    const parts = tickerPartsFromWeeks([week({ week: "2026-01-05", premium: 520, callDays: 2, accountEnd: 100_520 })], () => 0.26);
    expect(parts.premiumRatio).toBeCloseTo(0.01, 10);
    expect(parts.highestIv).toBe(0.26);
  });

  it("sums the swings over rising and falling weeks separately", () => {
    // Rising weeks: +2% and +4% with swings +1.0% and +2.0% → up 3 ÷ 6 = 0.5. Falling week −5% with a swing of −4% → down 0.8.
    const weeks = [
      week({ week: "2026-01-05", stockReturn: 0.02, accountEnd: 101_000 }),
      week({ week: "2026-01-12", stockReturn: 0.04, accountEnd: 102_000 }),
      week({ week: "2026-01-19", stockReturn: -0.05, accountEnd: 96_000 }),
    ];
    const parts = tickerPartsFromWeeks(weeks, () => null);
    expect(parts.upCapture).toBeCloseTo(0.5, 10);
    expect(parts.downCapture).toBeCloseTo(0.8, 10);
  });

  it("takes the premium and the interest out of the swing", () => {
    // +$1,500 in a week with $400 of premium and $100 of interest: a swing of $1,000 on a 2% rise, up capture 0.5.
    const parts = tickerPartsFromWeeks([week({ stockReturn: 0.02, accountEnd: 101_500, premium: 400, interest: 100, callDays: 1 })], () => 0.2);
    expect(parts.upCapture).toBeCloseTo(0.5, 10);
  });

  it("averages the shares' share and the Call days over the weeks", () => {
    const parts = tickerPartsFromWeeks([week({ sharesShare: 0.6, callDays: 1 }), week({ week: "2026-01-12", sharesShare: 0.8, callDays: 2 })], () => 0.3);
    expect(parts.sharesHeldShare).toBeCloseTo(0.7, 10);
    expect(parts.backtestCallDaysPerWeek).toBeCloseTo(1.5, 10);
  });
});

describe("callDaysPerWeekAtTodaysPace (P2)", () => {
  it("multiplies expiry days a week by the share sold", () => {
    // 19.63 expiry days in 13 weeks (1.51 a week) × 86% sold = 1.30 Call days a week.
    expect(callDaysPerWeekAtTodaysPace({ expiryDaysLastThreeMonths: 19.63, weeksLastThreeMonths: 13, expiryDaysLastTwelveMonths: 100, callDaysLastTwelveMonths: 86 })).toBeCloseTo(1.2986, 3);
  });

  it("is null without expiries to measure", () => {
    expect(callDaysPerWeekAtTodaysPace({ expiryDaysLastThreeMonths: 3, weeksLastThreeMonths: 13, expiryDaysLastTwelveMonths: 0, callDaysLastTwelveMonths: 0 })).toBeNull();
  });
});

describe("lotFitScale", () => {
  it("is the share of the 80% target whole lots reach at the book's pot over that at the analysis pot", () => {
    // $300 a share, a lot $30,000.50. Analysis pot $120,000: 3 lots of the $96,000 target, 93.75%. Book pot $50,000: 1 lot of
    // $40,000, 75.0%. Scale 75.0 ÷ 93.75 = 0.80.
    expect(lotFitScale(50_000, 120_000, 300, 0.8)).toBeCloseTo((30_000.5 / 40_000) / ((3 * 30_000.5) / 96_000), 10);
  });

  it("is 0 when no lot fits the book's pot", () => {
    expect(lotFitScale(30_000, 120_000, 300, 0.8)).toBe(0);
  });
});
