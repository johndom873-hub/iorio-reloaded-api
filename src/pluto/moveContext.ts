import { computeYangZhangVolatility, type DailyOhlcvBar } from "../lib/realizedVolatility.js";

// Today's move measured against the stock's own normal, for the model (Marcelo, 2026-10-06): the division the
// prompt used to leave to the model is done here. Formulas approved the same day:
//   expected_daily_move_pct = forecast realized volatility (annualised) × 100 / √252
//   day_move_sigmas         = day_change_pct / expected_daily_move_pct
// The recent path (1 week, 1 month, 3 months of trading days) and the last month's realized volatility against the
// last six months come from the stored daily bars; IV rank is the Price Performance figure.

export interface MoveContext {
  dayMoveSigmas: number | null;
  expectedDailyMovePct: number | null;
  change1wPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  realizedVol21dPct: number | null;
  realizedVol126dPct: number | null;
  ivRank: number | null;
}

const tradingDaysPerYear = 252;
const oneWeekBars = 5;
const oneMonthBars = 21;
const threeMonthBars = 63;
const shortVolWindowDays = 21;
const longVolWindowDays = 126;

/** Percent change from the close `barsBack` sessions before the latest bar to the latest close; null without enough history. */
function changeOverBars(bars: DailyOhlcvBar[], barsBack: number): number | null {
  if (bars.length < barsBack + 1) return null;
  const latest = bars[bars.length - 1]!.close;
  const earlier = bars[bars.length - 1 - barsBack]!.close;
  if (!(earlier > 0)) return null;
  return ((latest - earlier) / earlier) * 100;
}

function realizedVolPct(bars: DailyOhlcvBar[], windowDays: number): number | null {
  const result = computeYangZhangVolatility(bars, windowDays);
  return result.available ? result.annualizedVolatility * 100 : null;
}

/**
 * `bars` in date order, ending at the last completed session (never today's partial bar). `forecastVolatility` is the
 * annualised realized-volatility forecast as a decimal; `dayChangePct` today's move so far.
 */
export function computeMoveContext(input: { bars: DailyOhlcvBar[]; forecastVolatility: number | null; dayChangePct: number | null; ivRank: number | null }): MoveContext {
  const expectedDailyMovePct = input.forecastVolatility !== null && input.forecastVolatility > 0 ? (input.forecastVolatility * 100) / Math.sqrt(tradingDaysPerYear) : null;
  const dayMoveSigmas = expectedDailyMovePct !== null && input.dayChangePct !== null ? input.dayChangePct / expectedDailyMovePct : null;
  return {
    dayMoveSigmas,
    expectedDailyMovePct,
    change1wPct: changeOverBars(input.bars, oneWeekBars),
    change1mPct: changeOverBars(input.bars, oneMonthBars),
    change3mPct: changeOverBars(input.bars, threeMonthBars),
    realizedVol21dPct: realizedVolPct(input.bars, shortVolWindowDays),
    realizedVol126dPct: realizedVolPct(input.bars, longVolWindowDays),
    ivRank: input.ivRank,
  };
}
