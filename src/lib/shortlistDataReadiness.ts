import { db } from "../db/connection.js";
import { loadVolatilityForecast } from "./volatilityForecastStore.js";
import { loadDividendCadenceUnknown, loadEarningsDatesForForecastWindow, loadNextEarningsDate } from "./signalsStore.js";
import { easternDateIso } from "./marketSessionStatus.js";

// Backs the Shortlist screen's data-sanity-check columns (redesigned 2026-09-23, replacing the old
// IV/volume columns): per ticker, everything the Signals pipeline actually reads before it can score a
// candidate, so a gap here explains directly why a ticker is thin or unscored on the Signals screen.

export interface ShortlistDataReadiness {
  dailyBarCount: number;
  /** From the same split guard Signals itself uses (volatilityForecastStore.ts) -- independent of whether an option-chain snapshot exists yet. */
  suspectedSplitDateIso: string | null;
  earningsCount: number;
  nextEarningsDateIso: string | null;
  isEtf: boolean;
  /** Zero means no ex-dividend ever captured (not a payer, or not yet seen) -- distinct from "captured but irregular" (dividendCadenceUnknown). */
  dividendHistoryCount: number;
  dividendCadenceUnknown: boolean;
  chainSnapshotCount: number;
  /** Both null when there is no chain snapshot yet. */
  latestFittedSliceCount: number | null;
  latestTotalSliceCount: number | null;
}

export async function loadShortlistDataReadiness(tickerId: string, sector: string | null, now: Date = new Date()): Promise<ShortlistDataReadiness> {
  const todayIso = easternDateIso(now);

  const [barCountRow, forecastSelection, earningsDatesIso, nextEarningsDateIso, dividendHistoryCountRow, dividendCadenceUnknown, chainCountRow, latestSnapshot] = await Promise.all([
    db("daily_price_bars").where({ ticker_id: tickerId }).count<{ count: string }[]>("* as count"),
    loadVolatilityForecast(tickerId, todayIso),
    loadEarningsDatesForForecastWindow(tickerId),
    loadNextEarningsDate(tickerId, todayIso),
    db("ticker_calendar_events").where({ ticker_id: tickerId, event_type: "ex_dividend" }).count<{ count: string }[]>("* as count"),
    loadDividendCadenceUnknown(tickerId, todayIso),
    db("option_chain_snapshots").where({ ticker_id: tickerId }).count<{ count: string }[]>("* as count"),
    db("option_chain_snapshots").where({ ticker_id: tickerId }).orderBy("trading_date", "desc").first("id"),
  ]);

  let latestFittedSliceCount: number | null = null;
  let latestTotalSliceCount: number | null = null;
  if (latestSnapshot) {
    const fits = await db("option_surface_fits").where({ snapshot_id: latestSnapshot.id }).select("status");
    latestTotalSliceCount = fits.length;
    latestFittedSliceCount = fits.filter((fit) => fit.status === "ok").length;
  }

  return {
    dailyBarCount: Number(barCountRow[0]?.count ?? 0),
    suspectedSplitDateIso: forecastSelection.suspectedSplitDateIso,
    earningsCount: earningsDatesIso.length,
    nextEarningsDateIso,
    isEtf: sector === "ETF",
    dividendHistoryCount: Number(dividendHistoryCountRow[0]?.count ?? 0),
    dividendCadenceUnknown,
    chainSnapshotCount: Number(chainCountRow[0]?.count ?? 0),
    latestFittedSliceCount,
    latestTotalSliceCount,
  };
}
