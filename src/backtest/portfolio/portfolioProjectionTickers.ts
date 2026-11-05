import type { Knex } from "knex";
import type { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { defaultIvHalfLifeSessions, tickerDayHistoryOf, tradingDaysPerYear, withFilledDaysIvMatched, type MarketDayHistory, type TickerDayHistory } from "./portfolioDayHistory.js";
import type { ProjectionTicker } from "./portfolioDayProjection.js";
import { loadMacroEventDates, loadTickerProjectionSource, type TickerProjectionSource } from "./portfolioProjectionInputs.js";
import { standInOf } from "./portfolioStandIns.js";

// One ticker as a projection and the suggestions' library run it (Marcelo 2026-11-04): its day history, with its stand-in's
// moves before its own (portfolioStandIns.ts), and the ProjectionTicker fields read from its source: the volatility start
// (today's IV, its half-life, else its stand-in's, else 25 sessions) and the anchor's event factor on each history day.

export interface TickerWithHistory {
  source: TickerProjectionSource;
  history: TickerDayHistory;
  /** Its stand-in's source, when it has one. */
  standIn: TickerProjectionSource | null;
}

/** Its source, its stand-in's, and its day history on the market's dates. */
export async function loadTickerWithHistory(symbol: string, market: MarketDayHistory, rates: TreasuryBillRates, riskFree: { nowPct: number; averagePct: number }, connection: Knex): Promise<TickerWithHistory> {
  const source = await loadTickerProjectionSource(symbol, rates, connection);
  const standInSymbol = standInOf(symbol);
  const standIn = standInSymbol === null ? null : await loadTickerProjectionSource(standInSymbol, rates, connection);
  const nowDay = riskFree.nowPct / 100 / tradingDaysPerYear;
  const meanDay = riskFree.averagePct / 100 / tradingDaysPerYear;
  const standInHistory = standIn === null ? null : tickerDayHistoryOf(standIn.symbol, standIn.sessions, market, nowDay, meanDay, standIn.dividendYield ?? 0);
  return { source, standIn, history: tickerDayHistoryOf(symbol, source.sessions, market, nowDay, meanDay, source.dividendYield ?? 0, standInHistory) };
}

/** The anchor's event factor on each of the market's dates: macro event days × its macro factor, its reaction days × its earnings one. */
export function eventAnchorFactorsOf(source: TickerProjectionSource, market: MarketDayHistory): Float64Array {
  const macroDates = loadMacroEventDates();
  const reactionDates = new Set(source.earningsReactionDates);
  return Float64Array.from(market.dates, (date) => (macroDates.has(date) ? source.eventFactors.macro : 1) * (reactionDates.has(date) ? source.eventFactors.earningsReaction : 1));
}

/** Today's IV against its median over the last 4 years of sessions (1,008), the screen's "IV30 now ÷ normal"; null without today's IV. */
export function ivNowAgainstNormalOf(source: TickerProjectionSource): number | null {
  if (source.ivNow === null) return null;
  const ivs = source.sessions
    .slice(-4 * tradingDaysPerYear)
    .flatMap((session) => (session.impliedVolatility !== null && session.impliedVolatility > 0 ? [session.impliedVolatility] : []))
    .sort((a, b) => a - b);
  return ivs.length === 0 ? null : source.ivNow / ivs[Math.floor(ivs.length / 2)]!;
}

/** The half-life today's IV fades back over: its own, else its stand-in's, else 25 sessions. */
export function ivHalfLifeOf(ticker: TickerWithHistory): number {
  return ticker.source.ivHalfLifeSessions ?? ticker.standIn?.ivHalfLifeSessions ?? defaultIvHalfLifeSessions;
}

export function projectionTickerOf(ticker: TickerWithHistory, market: MarketDayHistory, leftoverDays: Int32Array): ProjectionTicker {
  const { source } = ticker;
  return {
    symbol: source.symbol,
    // Its filled days' IV matched to their moves with these leftovers (withFilledDaysIvMatched).
    history: withFilledDaysIvMatched(ticker.history, leftoverDays),
    todaysPrice: source.calibration.price,
    strikeSpacing: source.calibration.strikeSpacing,
    expiryWeekdays: source.calibration.expiryWeekdays,
    sameDayVolatilityUplift: source.calibration.sameDayVolatilityUplift ?? 1,
    observedDays: source.observedDays,
    anchorCurve: source.anchorCurve,
    leftoverDays,
    dividendYield: source.dividendYield ?? 0,
    volatilityStart: source.ivNow === null ? null : { ivNow: source.ivNow, halfLifeSessions: ivHalfLifeOf(ticker) },
    eventAnchorFactor: eventAnchorFactorsOf(source, market),
  };
}
