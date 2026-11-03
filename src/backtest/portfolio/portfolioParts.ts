import { targetReachedAt } from "../analysis/analysisPotSizing.js";

// What a ticker brings to the portfolio simulator, measured on its latest analysis backtest (P1–P4, approved by Marcelo
// 2026-11-03), week by week (Monday to Sunday; the account and the buy-and-hold line marked at 10:00):
// - P1 options' income per Call day = k × IV, k = Σ premium collected ÷ Σ (account at the week's start × IV at the week's
//   start × Call days in the week), over the weeks with a Call day and an IV. Example: XLE k 0.00926 at an IV of 28.3%:
//   0.26% of the account per Call day.
// - P2 Call days a week = expiry days a week over the data file's last 3 months × the share of its last 12 months' expiry
//   days with a Call sold. Example: 1.51 expiry days a week × 86% = 1.30 Call days, 0.34% of the account a week.
// - P3 swing capture: up = Σ the week's swing ÷ Σ the stock's rises over the weeks it rose, down likewise over the weeks it
//   fell, the swing being the week's change of the account less the premium collected and the interest, ÷ the account
//   at the week's start. Example: XLE up 0.59, down 0.72: a 3% rise adds 1.76%, a 3% fall takes 2.15%.
// - P4 cash: (1 − the shares' average share of the account) × the T-bill now. Example: XLE 36.5% × 3.99% = 1.46% a year.
// A book whose pot holds whole lots differently from the analysis pot scales P1, P3 and the shares' share by the share of
// the 80% target whole lots reach at the book's pot ÷ that at the analysis pot (F3), at today's price.

export interface BacktestWeek {
  /** The week's Monday. */
  week: string;
  accountStart: number;
  accountEnd: number;
  /** Premium collected from options sold that week (Calls and Puts), net of commission. */
  premium: number;
  /** Days a Call was sold that week. */
  callDays: number;
  interest: number;
  /** The average of the shares' value ÷ the account over the week's days. */
  sharesShare: number;
  /** The buy-and-hold line's change over the week (the stock at 10:00). */
  stockReturn: number;
}

export interface TickerParts {
  /** k (P1). */
  premiumRatio: number;
  upCapture: number;
  downCapture: number;
  sharesHeldShare: number;
  /** Call days a week over the backtest (P2 replaces it with today's pace when the file's expiries are known). */
  backtestCallDaysPerWeek: number;
  /** The highest IV at a week's start in the backtest: the IV cap. */
  highestIv: number | null;
  weeks: number;
}

/** P1, P3 and the shares' share from a backtest's weeks; `ivAtWeekStart` the ticker's IV at the end of the week before. */
export function tickerPartsFromWeeks(weeks: readonly BacktestWeek[], ivAtWeekStart: (week: string) => number | null): TickerParts {
  let premium = 0;
  let premiumBase = 0;
  let upSwing = 0;
  let upMove = 0;
  let downSwing = 0;
  let downMove = 0;
  let sharesShare = 0;
  let callDays = 0;
  let highestIv: number | null = null;
  for (const week of weeks) {
    sharesShare += week.sharesShare;
    callDays += week.callDays;
    const iv = ivAtWeekStart(week.week);
    if (iv !== null) highestIv = highestIv === null ? iv : Math.max(highestIv, iv);
    if (iv !== null && week.callDays > 0 && week.accountStart > 0) {
      premium += week.premium;
      premiumBase += week.accountStart * iv * week.callDays;
    }
    if (week.accountStart <= 0) continue;
    const swing = (week.accountEnd - week.accountStart - week.premium - week.interest) / week.accountStart;
    if (week.stockReturn > 0) {
      upSwing += swing;
      upMove += week.stockReturn;
    } else if (week.stockReturn < 0) {
      downSwing += swing;
      downMove += week.stockReturn;
    }
  }
  const count = weeks.length;
  return {
    premiumRatio: premiumBase > 0 ? premium / premiumBase : 0,
    upCapture: upMove > 0 ? upSwing / upMove : 0,
    downCapture: downMove < 0 ? downSwing / downMove : 0,
    sharesHeldShare: count > 0 ? sharesShare / count : 0,
    backtestCallDaysPerWeek: count > 0 ? callDays / count : 0,
    highestIv,
    weeks: count,
  };
}

/** P2: expiry days a week over the last 3 months × the share of the last 12 months' expiry days with a Call sold (at most 1). */
export function callDaysPerWeekAtTodaysPace(input: { expiryDaysLastThreeMonths: number; weeksLastThreeMonths: number; expiryDaysLastTwelveMonths: number; callDaysLastTwelveMonths: number }): number | null {
  if (input.weeksLastThreeMonths <= 0 || input.expiryDaysLastTwelveMonths <= 0) return null;
  const expiryDaysAWeek = input.expiryDaysLastThreeMonths / input.weeksLastThreeMonths;
  const soldShare = Math.min(1, input.callDaysLastTwelveMonths / input.expiryDaysLastTwelveMonths);
  return expiryDaysAWeek * soldShare;
}

/** F3's share of the 80% target whole lots reach at the book's pot ÷ at the analysis pot; 0 when no lot fits the book's pot. */
export function lotFitScale(bookPotDollars: number, analysisPotDollars: number, priceAsTraded: number, firstPositionShare: number): number {
  if (!(priceAsTraded > 0) || !(bookPotDollars > 0) || !(analysisPotDollars > 0)) return 1;
  const atAnalysis = targetReachedAt(analysisPotDollars, priceAsTraded, firstPositionShare).shareOfTarget;
  const atBook = targetReachedAt(bookPotDollars, priceAsTraded, firstPositionShare).shareOfTarget;
  return atAnalysis > 0 ? atBook / atAnalysis : 1;
}
