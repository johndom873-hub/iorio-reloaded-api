import { calendarDaysUntilExpiry } from "./optionChainCaptureWindow.js";

// Layered fallback for the volatility that sizes a ticker's strike window
// (decided 2026-09-21): latest daily IV if at most ~5 days old, else the
// 21-day Yang-Zhang realized volatility, else the widest window (±50%).

/** How old (calendar days) the latest daily IV may be and still be used. */
export const maximumImpliedVolatilityAgeDays = 5;

export type ReferenceVolatilitySource = "implied_volatility" | "yang_zhang_21d" | "widest_window";

export interface ReferenceVolatilityInput {
  todayIso: string;
  latestImpliedVolatility: number | null;
  /** ISO date (YYYY-MM-DD) of that IV reading. */
  latestImpliedVolatilityDateIso: string | null;
  yangZhang21DayVolatility: number | null;
}

export interface ReferenceVolatility {
  /** Decimal (0.35 = 35%), or null when the widest window must be used. */
  volatility: number | null;
  source: ReferenceVolatilitySource;
}

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function chooseReferenceVolatility(input: ReferenceVolatilityInput): ReferenceVolatility {
  if (isUsable(input.latestImpliedVolatility) && input.latestImpliedVolatilityDateIso !== null) {
    const ageDays = -calendarDaysUntilExpiry(input.todayIso, input.latestImpliedVolatilityDateIso.replaceAll("-", ""));
    if (ageDays >= 0 && ageDays <= maximumImpliedVolatilityAgeDays) {
      return { volatility: input.latestImpliedVolatility, source: "implied_volatility" };
    }
  }
  if (isUsable(input.yangZhang21DayVolatility)) {
    return { volatility: input.yangZhang21DayVolatility, source: "yang_zhang_21d" };
  }
  return { volatility: null, source: "widest_window" };
}
