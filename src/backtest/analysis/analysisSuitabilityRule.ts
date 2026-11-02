import { addCalendarDays, countExpiryWeeks, steadyWeekShare, wholeWeeksBetween } from "./analysisExpiryWeeks.js";

// Whether a ticker suits Vol Farmer v4 (the rule approved by Marcelo 2026-11-01, S3 and S4 amended the same day): over each
// of the last 12, 6 and 3 months of its analysis backtest, up to the backtest's last day, it passes four checks.
// - S1 options' income: the P&L of the Calls and Puts sold in the window, after commissions, ÷ the account's value at the
//   window's start × 365 ÷ the window's calendar days, at least 15% a year.
// - S2 expiry days sold: the window's days with a Call sold ÷ its expiry days, at least 70%.
// - S3 weeks with an expiry: whole weeks (Monday to Sunday, wholly inside the window) with an expiry day ÷ its whole weeks,
//   at least 90%.
// - S4 a lot fits: on every day of the window, 100 × the 10:00 price as traded + $0.50 at most the first position's share
//   (80%) of the pot the analysis starts with (its starting account × 1.2), shown as the lot ÷ that share of the pot.
// A window the backtest doesn't cover in full fails. The ticker suits v4 when every check passes in every window.

export const suitabilityWindowMonths = [12, 6, 3] as const;
export type SuitabilityWindowMonths = (typeof suitabilityWindowMonths)[number];

export const optionsIncomeMinimumYearlyShare = 0.15;
export const expiryDaysSoldMinimumShare = 0.7;
export const stockCommissionPerLotDollars = 0.5;
export const sharesPerLot = 100;

export type SuitabilityCheck = "options_income" | "expiry_days_sold" | "weeks_with_expiry" | "lot_fits";
export const suitabilityChecks: readonly SuitabilityCheck[] = ["options_income", "expiry_days_sold", "weeks_with_expiry", "lot_fits"];

export interface SuitabilityRuleInputs {
  /** The backtest's days, ascending, with the account's value at its 10:00 marks. */
  days: readonly { tradingDate: string; accountValue: number }[];
  /** The backtest's days whose 10:00 quotes list a Call expiring that day. */
  expiryDays: ReadonlySet<string>;
  /** The days a Call was sold. */
  callSaleDays: ReadonlySet<string>;
  /** Every Call and Put sold: the Eastern date of its sale and its P&L after commissions (an open one at its last mark). */
  optionsSold: readonly { saleDate: string; pnlDollars: number }[];
  /** The 10:00 price as traded; null on a day without one. */
  tenOclockPriceAsTraded: (dateIso: string) => number | null;
  /** The pot the analysis starts with: its starting account × 1.2. */
  startingPotDollars: number;
  /** The first position's share of the pot (v4's firstPositionPct ÷ 100: 0.8). */
  firstPositionShare: number;
}

export interface SuitabilityWindow {
  months: SuitabilityWindowMonths;
  /** The window runs from the day after `startDate` to `endDate`. */
  startDate: string;
  endDate: string;
  /** False when the backtest starts after `startDate`: the window fails. */
  covered: boolean;
  /** The last backtest day on or before `startDate`, whose account value the income is measured on; null when not covered. */
  startMarkDate: string | null;
  optionsIncome: { pnlDollars: number; accountAtStartDollars: number | null; calendarDays: number; yearlyShare: number | null; passes: boolean };
  expiryDaysSold: { expiryDays: number; daysSold: number; share: number | null; passes: boolean };
  weeksWithExpiry: { wholeWeeks: number; weeksWithExpiryDay: number; share: number | null; passes: boolean };
  /** The window's most expensive lot: on `date`, at `priceAsTraded`. */
  lotFits: { date: string | null; priceAsTraded: number | null; lotDollars: number | null; shareOfTarget: number | null; passes: boolean };
}

export interface SuitabilityVerdict {
  suits: boolean;
  /** The checks failing in at least one window, in the rule's order. */
  failedChecks: SuitabilityCheck[];
  /** The windows the backtest doesn't cover in full. */
  uncoveredWindows: SuitabilityWindowMonths[];
}

const dayMilliseconds = 86_400_000;
const calendarDaysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / dayMilliseconds);

/** The same calendar day `months` months before `dateIso`, or that month's last day when it is shorter (31 May less 3 months: 28 or 29 Feb). */
export function sameDayMonthsBefore(dateIso: string, months: number): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const monthIndex = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export const lotDollarsAt = (priceAsTraded: number) => sharesPerLot * priceAsTraded + stockCommissionPerLotDollars;

export function suitabilityWindow(inputs: SuitabilityRuleInputs, months: SuitabilityWindowMonths): SuitabilityWindow {
  const sessionDates = inputs.days.map((day) => day.tradingDate);
  const endDate = sessionDates.at(-1)!;
  const startDate = sameDayMonthsBefore(endDate, months);
  const startMark = [...inputs.days].reverse().find((day) => day.tradingDate <= startDate) ?? null;
  const covered = startMark !== null;
  const inWindow = sessionDates.filter((date) => date > startDate);

  const pnlDollars = inputs.optionsSold.filter((sale) => sale.saleDate > startDate && sale.saleDate <= endDate).reduce((sum, sale) => sum + sale.pnlDollars, 0);
  const calendarDays = calendarDaysBetween(startDate, endDate);
  const accountAtStartDollars = startMark?.accountValue ?? null;
  const yearlyShare = accountAtStartDollars === null || !(accountAtStartDollars > 0) ? null : (pnlDollars / accountAtStartDollars) * (365 / calendarDays);

  const expiryDays = inWindow.filter((date) => inputs.expiryDays.has(date));
  const daysSold = expiryDays.filter((date) => inputs.callSaleDays.has(date)).length;
  const soldShare = expiryDays.length === 0 ? null : daysSold / expiryDays.length;

  const weeks = countExpiryWeeks(wholeWeeksBetween(sessionDates, inputs.expiryDays, addCalendarDays(startDate, 1), endDate));
  const weekShare = weeks.wholeWeeks === 0 ? null : weeks.weeksWithExpiryDay / weeks.wholeWeeks;

  const target = inputs.firstPositionShare * inputs.startingPotDollars;
  let worst: { date: string; price: number } | null = null;
  for (const date of inWindow) {
    const price = inputs.tenOclockPriceAsTraded(date);
    if (price !== null && (worst === null || price > worst.price)) worst = { date, price };
  }
  const lotDollars = worst === null ? null : lotDollarsAt(worst.price);

  return {
    months,
    startDate,
    endDate,
    covered,
    startMarkDate: startMark?.tradingDate ?? null,
    optionsIncome: { pnlDollars, accountAtStartDollars, calendarDays, yearlyShare, passes: covered && yearlyShare !== null && yearlyShare >= optionsIncomeMinimumYearlyShare },
    expiryDaysSold: { expiryDays: expiryDays.length, daysSold, share: soldShare, passes: covered && soldShare !== null && soldShare >= expiryDaysSoldMinimumShare },
    weeksWithExpiry: { ...weeks, share: weekShare, passes: covered && weekShare !== null && weekShare >= steadyWeekShare },
    lotFits: { date: worst?.date ?? null, priceAsTraded: worst?.price ?? null, lotDollars, shareOfTarget: lotDollars === null ? null : lotDollars / target, passes: covered && lotDollars !== null && lotDollars <= target },
  };
}

export function suitabilityVerdict(windows: readonly SuitabilityWindow[]): SuitabilityVerdict {
  const passesOf: Record<SuitabilityCheck, (window: SuitabilityWindow) => boolean> = {
    options_income: (window) => window.optionsIncome.passes,
    expiry_days_sold: (window) => window.expiryDaysSold.passes,
    weeks_with_expiry: (window) => window.weeksWithExpiry.passes,
    lot_fits: (window) => window.lotFits.passes,
  };
  const failedChecks = suitabilityChecks.filter((check) => windows.some((window) => window.covered && !passesOf[check](window)));
  const uncoveredWindows = windows.filter((window) => !window.covered).map((window) => window.months);
  return { suits: windows.length > 0 && uncoveredWindows.length === 0 && failedChecks.length === 0, failedChecks, uncoveredWindows };
}

/** The three windows and the verdict. */
export function applySuitabilityRule(inputs: SuitabilityRuleInputs): { windows: SuitabilityWindow[]; verdict: SuitabilityVerdict } {
  if (inputs.days.length === 0) return { windows: [], verdict: { suits: false, failedChecks: [], uncoveredWindows: [...suitabilityWindowMonths] } };
  const windows = suitabilityWindowMonths.map((months) => suitabilityWindow(inputs, months));
  return { windows, verdict: suitabilityVerdict(windows) };
}
