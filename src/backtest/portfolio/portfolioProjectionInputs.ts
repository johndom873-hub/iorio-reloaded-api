import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { loadDailyBarsOf } from "../analysis/analysisFigures.js";
import { tenOclockPriceAsTraded } from "../analysis/analysisDayInputs.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { fileIntradayBarsExtendedStartDate, readFileIntradayPrices } from "../backtestFileStockBars.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { readSplitScheduleCache, splitFactorOn } from "../engine/splitFactors.js";
import type { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { loadObservedChainDay, loadTickerCalibration, type TickerCalibration } from "./portfolioCalibration.js";
import type { HistorySession } from "./portfolioDayHistory.js";
import { anchorCurveOf, anchorFactorAt, atMoneyRatioOf, observedAgainstAnchor, thirtyDayIvElevation, type AnchorCurve, type ObservedChainDay } from "./portfolioObservedChain.js";

// What the projection reads of a ticker (D1, D3, D4 as built 2026-11-03): its sessions from 2006 (IBKR's daily close and
// 10:00 price from its 30-minute bars, split-adjusted, with the daily 30-day IV), today's calibration (price, expiry
// weekdays, strike spacing, u), its anchor curve from its same-day expiries since 2020, and its last 60 sessions' chains
// read against their anchors. Kept in memory until the file's last complete day changes.

/** The sessions whose chains a projection draws from: about one earnings cycle. */
export const observedChainSessions = 60;
/** The same-day expiries the anchor curve is read from. */
export const anchorCurveFromIso = "2020-01-01";

export interface TickerProjectionSource {
  symbol: string;
  lastFileDay: string;
  sessions: HistorySession[];
  calibration: TickerCalibration;
  anchorCurve: AnchorCurve;
  /** The last 60 sessions' chains, each against its own anchor. */
  observedDays: ObservedChainDay[];
  /** The first session with a 10:00 price: 2006 for an extended file, else its first option year. */
  firstTenOclockDate: string | null;
  /** Each cash dividend as a share of the previous session's close as traded (0.0085 for 0.85%), oldest first; null when its file's dividends were never fetched. */
  dividendShares: { exDividendDate: string; share: number }[] | null;
  /** V3: the dividend yield, the sum of the last 12 months' shares (to its last file day); 0 without dividends, null when never fetched. */
  dividendYield: number | null;
}

/** The key a ticker's source is kept in memory under: its last file day and when its dividends were fetched. */
const sourceKeyOf = (lastFileDay: string, dividendsFetchedAt: string | null) => `${lastFileDay}|${dividendsFetchedAt ?? ""}`;

const sourceCache = new Map<string, { key: string; source: TickerProjectionSource }>();

/** The ticker's sessions, the IV of each, and their elevations: what the chains and the curve are read with. */
function elevationOfSession(sessions: readonly HistorySession[], position: number): { iv: number; elevation: number | null } | null {
  for (let back = position - 1; back >= Math.max(0, position - 5); back--) {
    const iv = sessions[back]!.impliedVolatility;
    if (iv !== null && iv > 0) return { iv, elevation: thirtyDayIvElevation(iv, sessions.slice(Math.max(0, back - 60), back).map((session) => session.impliedVolatility)) };
  }
  return null;
}

export async function loadTickerProjectionSource(symbol: string, rates: TreasuryBillRates, connection: Knex = db): Promise<TickerProjectionSource> {
  const file = BacktestSymbolFile.open(symbol);
  try {
    const completeDays = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
    const lastFileDay = completeDays.at(-1);
    if (lastFileDay === undefined) throw new Error(`${symbol}: its data file has no complete day.`);
    const key = sourceKeyOf(lastFileDay, file.loadDividendsFetchedAt());
    const cached = sourceCache.get(symbol);
    if (cached && cached.key === key) return cached.source;

    const { bars } = await loadDailyBarsOf(symbol, connection);
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`${symbol}: no data file.`);
    const intraday = (() => {
      try {
        return readFileIntradayPrices(database, fileIntradayBarsExtendedStartDate, lastFileDay);
      } finally {
        database.close();
      }
    })();
    const sessions: HistorySession[] = bars.map((bar) => ({ tradingDate: bar.tradingDate, tenOclock: intraday?.priceAt(bar.tradingDate, "10:00") ?? null, close: bar.close, impliedVolatility: bar.impliedVolatility }));
    const positionByDate = new Map(sessions.map((session, position) => [session.tradingDate, position]));
    const schedule = readSplitScheduleCache(requireBacktestDataDirectory(), symbol)?.schedule ?? null;
    const previousFileDayOf = new Map(completeDays.map((day, index) => [day, index > 0 ? completeDays[index - 1]! : null]));

    /** A complete file day's chain on the 30-day IV, with its elevation; null without a 10:00 price, an IV or the chain. */
    const observedOn = (date: string): { day: ObservedChainDay; elevation: number | null } | null => {
      const position = positionByDate.get(date);
      if (position === undefined || intraday === null) return null;
      const known = elevationOfSession(sessions, position);
      const stockPrice = tenOclockPriceAsTraded(date, intraday, schedule);
      if (known === null || stockPrice === null) return null;
      const day = loadObservedChainDay(file, { dateIso: date, previousFileDay: previousFileDayOf.get(date) ?? null, stockPrice, impliedVolatility: known.iv, riskFreeRate: (rates.ratePercentOnOrBefore(date) ?? 0) / 100 });
      return day === null ? null : { day, elevation: known.elevation };
    };

    // The anchor curve: every same-day expiry since 2020, its at-the-money IV ratio against its elevation.
    const samples: { elevation: number; atMoneyRatio: number }[] = [];
    for (const date of completeDays) {
      if (date < anchorCurveFromIso || !file.loadCallExpiries(date).includes(date)) continue;
      const observed = observedOn(date);
      const ratio = observed === null ? null : atMoneyRatioOf(observed.day);
      if (observed !== null && observed.elevation !== null && ratio !== null) samples.push({ elevation: observed.elevation, atMoneyRatio: ratio });
    }
    const anchorCurve = anchorCurveOf(samples);
    const observedDays = completeDays.slice(-observedChainSessions).flatMap((date) => {
      const observed = observedOn(date);
      return observed === null ? [] : [observedAgainstAnchor(observed.day, anchorFactorAt(anchorCurve, observed.elevation))];
    });
    const calibration = await loadTickerCalibration(symbol, connection);
    // A dividend's share of the close before its ex-date, both as traded (the file's split schedule; SPY, whose shares
    // the neutral drift reads back to 2006, has not split since).
    const dividends = file.loadDividends();
    const closeAsTradedBefore = (dateIso: string): number | null => {
      for (let position = sessions.length - 1; position >= 0; position--) {
        const session = sessions[position]!;
        if (session.tradingDate >= dateIso || session.close === null) continue;
        return session.close * (schedule === null ? 1 : (splitFactorOn(schedule, session.tradingDate) ?? 1));
      }
      return null;
    };
    const dividendShares =
      dividends === null
        ? null
        : dividends.flatMap((dividend) => {
            const close = closeAsTradedBefore(dividend.exDividendDate);
            return close === null || close <= 0 ? [] : [{ exDividendDate: dividend.exDividendDate, share: dividend.amount / close }];
          });
    const yearBefore = new Date(Date.parse(`${lastFileDay}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    const source: TickerProjectionSource = {
      symbol,
      lastFileDay,
      sessions,
      calibration,
      anchorCurve,
      observedDays,
      firstTenOclockDate: sessions.find((session) => session.tenOclock !== null)?.tradingDate ?? null,
      dividendShares,
      dividendYield: dividendShares === null ? null : dividendShares.filter((dividend) => dividend.exDividendDate > yearBefore && dividend.exDividendDate <= lastFileDay).reduce((sum, dividend) => sum + dividend.share, 0),
    };
    sourceCache.set(symbol, { key, source });
    return source;
  } finally {
    file.close();
  }
}
