import { describe, expect, it } from "vitest";
import { expiryWeeksBy, mondayOf, steadyWeekliesStartMonth, wholeWeeksBetween } from "./analysisExpiryWeeks.js";
import { applySuitabilityRule, sameDayMonthsBefore, suitabilityVerdict, type SuitabilityRuleInputs } from "./analysisSuitabilityRule.js";

/** The weekdays from `from` to `to`, both included. */
function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = from; day <= to; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) dates.push(day);
  }
  return dates;
}
const fridays = (dates: readonly string[]) => new Set(dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 5));

describe("whole weeks with an expiry (S3, F1)", () => {
  it("counts a Monday-to-Sunday week only when it lies wholly inside the stretch", () => {
    expect(mondayOf("2026-10-29")).toBe("2026-10-26");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    // Wed 1 Oct to Thu 29 Oct 2026: the weeks of 29 Sep and 26 Oct are cut, so 3 whole weeks (5, 12 and 19 Oct).
    const sessions = weekdays("2026-10-01", "2026-10-29");
    const weeks = wholeWeeksBetween(sessions, fridays(sessions), "2026-10-01", "2026-10-29");
    expect(weeks.map((week) => week.monday)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(weeks.every((week) => week.hasExpiryDay)).toBe(true);
  });

  it("puts each week in the month and year of its last session", () => {
    // The week of Mon 29 Dec 2025 ends on Fri 2 Jan 2026: a 2026 week, a January one. The week of Mon 26 Jan runs to Sun
    // 1 Feb, past Sat 31 Jan: not whole. So January has the weeks of 29 Dec, 5, 12 and 19 Jan.
    const sessions = weekdays("2025-12-01", "2026-01-31");
    const weeks = wholeWeeksBetween(sessions, fridays(sessions), "2025-12-01", "2026-01-31");
    expect(expiryWeeksBy(weeks, "year").get("2026")).toEqual({ wholeWeeks: 4, weeksWithExpiryDay: 4 });
    expect(expiryWeeksBy(weeks, "month").get("2026-01")).toEqual({ wholeWeeks: 4, weeksWithExpiryDay: 4 });
    expect(expiryWeeksBy(weeks, "month").get("2025-12")).toEqual({ wholeWeeks: 4, weeksWithExpiryDay: 4 });
  });

  it("starts steady weeklies in the first month from which every month has an expiry in 90% of its whole weeks", () => {
    // Monthly expiries only until June 2024 (the third Friday), weekly from July.
    const sessions = weekdays("2024-01-01", "2024-12-31");
    const expiries = new Set([...fridays(sessions)].filter((date) => date >= "2024-07-01" || (Number(date.slice(8)) >= 15 && Number(date.slice(8)) <= 21)));
    expect(steadyWeekliesStartMonth(wholeWeeksBetween(sessions, expiries, "2024-01-01", "2024-12-31"))).toBe("2024-07");
    // Monthly expiries all year never start steady weeklies.
    const monthly = new Set([...fridays(sessions)].filter((date) => Number(date.slice(8)) >= 15 && Number(date.slice(8)) <= 21));
    expect(steadyWeekliesStartMonth(wholeWeeksBetween(sessions, monthly, "2024-01-01", "2024-12-31"))).toBeNull();
  });
});

describe("sameDayMonthsBefore", () => {
  it("steps back whole months, clamped to a shorter month's last day", () => {
    expect(sameDayMonthsBefore("2026-10-28", 12)).toBe("2025-10-28");
    expect(sameDayMonthsBefore("2026-10-28", 3)).toBe("2026-07-28");
    expect(sameDayMonthsBefore("2026-05-31", 3)).toBe("2026-02-28");
    expect(sameDayMonthsBefore("2024-05-31", 3)).toBe("2024-02-29");
    expect(sameDayMonthsBefore("2026-02-15", 6)).toBe("2025-08-15");
  });
});

describe("the suitability rule (S1–S4)", () => {
  // Two years of weekdays to Wed 28 Oct 2026, the account flat at $100,000, Fridays the expiry days, a Call sold on each
  // for $500 of P&L, the stock at $100 at 10:00: every check passes.
  const sessions = weekdays("2024-10-28", "2026-10-28");
  const expiryDays = fridays(sessions);
  const base: SuitabilityRuleInputs = {
    days: sessions.map((tradingDate) => ({ tradingDate, accountValue: 100_000 })),
    expiryDays,
    callSaleDays: new Set(expiryDays),
    optionsSold: [...expiryDays].map((saleDate) => ({ saleDate, pnlDollars: 500 })),
    tenOclockPriceAsTraded: () => 100,
    startingPotDollars: 120_000,
    firstPositionShare: 0.8,
  };

  it("S1: the options' P&L in the window ÷ the account at its start × 365 ÷ its calendar days", () => {
    const { windows, verdict } = applySuitabilityRule(base);
    const twelve = windows.find((window) => window.months === 12)!;
    expect(twelve.startDate).toBe("2025-10-28");
    expect(twelve.startMarkDate).toBe("2025-10-28");
    // 52 Fridays from 31 Oct 2025 to 23 Oct 2026 × $500 = $26,000 on $100,000 over 365 days: 26.0% a year.
    expect(twelve.optionsIncome.pnlDollars).toBe(26_000);
    expect(twelve.optionsIncome.calendarDays).toBe(365);
    expect(twelve.optionsIncome.yearlyShare).toBeCloseTo(0.26, 9);
    expect(verdict).toEqual({ suits: true, failedChecks: [], uncoveredWindows: [] });
    // At $250 a Friday it is 13.0% a year, under 15%.
    const low = applySuitabilityRule({ ...base, optionsSold: base.optionsSold.map((sale) => ({ ...sale, pnlDollars: 250 })) });
    expect(low.verdict.failedChecks).toEqual(["options_income"]);
  });

  it("S2: Calls sold on at least 70% of the window's expiry days", () => {
    const soldOnEveryOther = new Set([...expiryDays].filter((_, index) => index % 2 === 0));
    const { windows, verdict } = applySuitabilityRule({ ...base, callSaleDays: soldOnEveryOther });
    expect(windows[0]!.expiryDaysSold.share).toBeCloseTo(0.5, 1);
    expect(verdict.failedChecks).toEqual(["expiry_days_sold"]);
  });

  it("S3: an expiry day in at least 90% of the window's whole weeks", () => {
    const everyThirdWeekMissing = new Set([...expiryDays].filter((_, index) => index % 3 !== 0));
    const { windows, verdict } = applySuitabilityRule({ ...base, expiryDays: everyThirdWeekMissing, callSaleDays: everyThirdWeekMissing });
    // 3 months to Wed 28 Oct 2026: whole weeks from Mon 3 Aug to Sun 25 Oct, 12 of them.
    const three = windows.find((window) => window.months === 3)!;
    expect(three.weeksWithExpiry.wholeWeeks).toBe(12);
    expect(three.weeksWithExpiry.share).toBeLessThan(0.9);
    expect(verdict.failedChecks).toEqual(["weeks_with_expiry"]);
  });

  it("S4: every day's lot within 80% of the starting pot, shown as a share of that 80%", () => {
    // $120,000 pot: a lot fits up to $959.99 a share (100 × 959.99 + 0.50 = $95,999.50).
    const fits = applySuitabilityRule({ ...base, tenOclockPriceAsTraded: (date) => (date === "2026-10-06" ? 959.99 : 100) });
    expect(fits.windows[0]!.lotFits).toMatchObject({ date: "2026-10-06", priceAsTraded: 959.99, lotDollars: 95_999.5, passes: true });
    expect(fits.windows[0]!.lotFits.shareOfTarget).toBeCloseTo(95_999.5 / 96_000, 12);
    const tooDear = applySuitabilityRule({ ...base, tenOclockPriceAsTraded: (date) => (date === "2026-10-06" ? 960 : 100) });
    expect(tooDear.verdict.failedChecks).toEqual(["lot_fits"]);
  });

  it("fails a window the backtest doesn't cover in full", () => {
    const short = sessions.filter((date) => date >= "2026-01-05");
    const { windows, verdict } = applySuitabilityRule({ ...base, days: short.map((tradingDate) => ({ tradingDate, accountValue: 100_000 })) });
    expect(windows.find((window) => window.months === 12)!.covered).toBe(false);
    expect(verdict).toEqual({ suits: false, failedChecks: [], uncoveredWindows: [12] });
    expect(suitabilityVerdict([])).toEqual({ suits: false, failedChecks: [], uncoveredWindows: [] });
  });
});
