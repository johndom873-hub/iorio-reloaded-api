import { db } from "../db/connection.js";
import { computeIvMetrics } from "./ivMetrics.js";
import { lastCompletedSessionDate } from "./marketSessionStatus.js";
import { computePriceTrend, type PriceTrend } from "./priceTrends.js";
import { easternIsoDate } from "./easternIsoDate.js";

// Everything the Price Performance page shows except the live price: end-of-day
// facts computed from daily_price_bars alone — zero IBKR calls at request time
// (design: PROGRESS.md "Price Performance redesign"). Only COMPLETED session
// bars are used, so a partial in-progress bar left behind by a chart top-up
// can never show up as a "last close".

interface RawRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  latestDate: string;
  latestClose: string;
  dailyLow: string;
  dailyHigh: string;
  close1dAgo: string | null;
  close2dAgo: string | null;
  close3dAgo: string | null;
  close1wAgo: string | null;
  close1mAgo: string | null;
  close3mAgo: string | null;
  close1yAgo: string | null;
  liveClose1dAgo: string | null;
  liveClose2dAgo: string | null;
  liveClose3dAgo: string | null;
  liveClose1wAgo: string | null;
  liveClose1mAgo: string | null;
  liveClose3mAgo: string | null;
  liveClose1yAgo: string | null;
  signalsEnabled: boolean;
  weeklyLow: string;
  weeklyHigh: string;
  monthlyLow: string;
  monthlyHigh: string;
  impliedVolatility: string | null;
  avgOptionVolume: string | null;
}

export interface ReferenceCloses {
  close1dAgo: number | null;
  close2dAgo: number | null;
  close3dAgo: number | null;
  close1wAgo: number | null;
  close1mAgo: number | null;
  close3mAgo: number | null;
  close1yAgo: number | null;
}

export interface PricePerformanceRow extends PriceTrend {
  symbol: string;
  companyName: string | null;
  latestDate: string;
  latestClose: string;
  dailyLow: string;
  dailyHigh: string;
  weeklyLow: string;
  weeklyHigh: string;
  monthlyLow: string;
  monthlyHigh: string;
  // vs. the latest completed close. The browser recomputes these against the
  // live price (same formula, same reference closes below) once one arrives.
  change1d: number | null;
  change2d: number | null;
  change3d: number | null;
  change1w: number | null;
  change1m: number | null;
  change3m: number | null;
  change1y: number | null;
  /** The closes each change above is measured against, counted back from the latest completed close. */
  referenceCloses: ReferenceCloses;
  /**
   * The closes a LIVE price is measured against (Marcelo, 2026-10-12): 1D is the live price vs this row's latest close, 2D / 3D
   * vs the one and two closes before it — at any hour, so pre-market and after-hours moves count from the last close too.
   * 1W / 1M / 3M / 1Y: the last close on or before 7 / 30 / 91 / 365 days before today's Eastern date (meta.liveReferenceDate).
   */
  liveReferenceCloses: ReferenceCloses;
  /** Off: the nightly IV snapshot is skipped, so impliedVolatility and avgOptionVolume are null rather than stale. */
  signalsEnabled: boolean;
  impliedVolatility: string | null;
  avgOptionVolume: string | null;
  ivRank: number | null;
  ivPercentile: number | null;
  ivWindowDays: number;
  /** This ticker's latest completed bar is older than the session the data should be current to. */
  isBehind: boolean;
}

export interface PricePerformanceMeta {
  /** Newest session a completed bar can exist for right now (market calendar aware). */
  completedThroughDate: string;
  /** The session the data should be current to, allowing the nightly job its normal window after the close. */
  expectedSessionDate: string;
  isDataCurrent: boolean;
  behindSymbols: string[];
  /** Today's Eastern date: what the live 1W / 1M / 3M / 1Y reference closes count back from. */
  liveReferenceDate: string;
}

export interface PricePerformanceSnapshot {
  tickers: PricePerformanceRow[];
  meta: PricePerformanceMeta;
}

// The nightly capture runs at 10:00 PM UTC (6 PM EDT / 5 PM EST), 1-2 hours after the
// close; data is not "behind" until that job has had a comfortable window —
// 2.5 h after the close is 6:30 PM ET, past the job's EDT start.
const nightlyJobGraceMs = 150 * 60 * 1000;
const trendHistoryYears = 1;

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// The same formula the old streaming route used (and the browser now uses for
// live prices): null when there is no reference or it is zero.
export function percentChange(current: number, reference: number | null): number | null {
  if (reference === null || reference === 0) return null;
  return ((current - reference) / reference) * 100;
}

/** Pure freshness rule, exported for tests: which tickers' latest completed bar predates the expected session. */
export function classifyFreshness(latestDateBySymbol: Record<string, string>, expectedSessionDate: string): { behindSymbols: string[] } {
  const symbols = Object.keys(latestDateBySymbol).sort();
  return { behindSymbols: symbols.filter((symbol) => latestDateBySymbol[symbol]! < expectedSessionDate) };
}

// "latest" is the newest bar AT OR BEFORE the completed-session cutoff (the first `?` binding). The 1D/2D/3D closes are the
// closes before `sessionsBeforeSql`; 1W/1M/3M/1Y count calendar days back from `daysBackFromSql`. Stored changes: both are the
// latest bar's date. Live changes: the day after it (so 1D is the latest close itself) and today's Eastern date.
function referenceCloseJoins(prefix: string, sessionsBeforeSql: string, daysBackFromSql: string): string {
  const sessionsBack = (alias: string, offset: number) => `
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date < ${sessionsBeforeSql}
    ORDER BY trading_date DESC OFFSET ${offset} LIMIT 1
  ) ${prefix}${alias} ON true`;
  const daysBack = (alias: string, days: number) => `
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date <= ${daysBackFromSql} - INTERVAL '${days} days'
    ORDER BY trading_date DESC LIMIT 1
  ) ${prefix}${alias} ON true`;
  return [sessionsBack("d1", 0), sessionsBack("d2", 1), sessionsBack("d3", 2), daysBack("wk", 7), daysBack("mo", 30), daysBack("q", 91), daysBack("yr", 365)].join("");
}

const historicalCloseJoins = `
  JOIN LATERAL (
    SELECT trading_date, close_price, low_price, high_price
    FROM daily_price_bars WHERE ticker_id = t.id AND trading_date <= ?::date ORDER BY trading_date DESC LIMIT 1
  ) latest ON true
  ${referenceCloseJoins("", "latest.trading_date", "latest.trading_date")}
  CROSS JOIN (SELECT ?::date AS live_reference_date) live_reference
  ${referenceCloseJoins("live_", "latest.trading_date + 1", "live_reference.live_reference_date")}
`;

async function computePricePerformanceSnapshot(now: Date): Promise<PricePerformanceSnapshot> {
  const completedThroughDate = await lastCompletedSessionDate(now);
  const liveReferenceDate = easternIsoDate(now);
  const expectedSessionDate = await lastCompletedSessionDate(new Date(now.getTime() - nightlyJobGraceMs));

  // 1D/2D/3D use trading-day close deltas (1/2/3 trading days back), not
  // true rolling 24-hour windows — approved 2026-08-25. 1W/1M/3M/1Y use a
  // rolling 7/30/91/365 calendar-day window (3M and 1Y approved 2026-10-07),
  // found via "closest available close on/before N days back".
  const result = await db.raw(
    `
    SELECT
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      to_char(latest.trading_date, 'YYYY-MM-DD') AS "latestDate",
      latest.close_price AS "latestClose",
      latest.low_price AS "dailyLow",
      latest.high_price AS "dailyHigh",
      d1.close_price AS "close1dAgo",
      d2.close_price AS "close2dAgo",
      d3.close_price AS "close3dAgo",
      wk.close_price AS "close1wAgo",
      mo.close_price AS "close1mAgo",
      q.close_price AS "close3mAgo",
      yr.close_price AS "close1yAgo",
      live_d1.close_price AS "liveClose1dAgo",
      live_d2.close_price AS "liveClose2dAgo",
      live_d3.close_price AS "liveClose3dAgo",
      live_wk.close_price AS "liveClose1wAgo",
      live_mo.close_price AS "liveClose1mAgo",
      live_q.close_price AS "liveClose3mAgo",
      live_yr.close_price AS "liveClose1yAgo",
      se.signals_enabled AS "signalsEnabled",
      wkrange.low AS "weeklyLow",
      wkrange.high AS "weeklyHigh",
      morange.low AS "monthlyLow",
      morange.high AS "monthlyHigh",
      m.implied_volatility AS "impliedVolatility",
      m.avg_option_volume AS "avgOptionVolume"
    FROM tickers t
    JOIN shortlist_entries se ON se.ticker_id = t.id AND se.removed_at IS NULL
    ${historicalCloseJoins}
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date <= latest.trading_date AND trading_date >= latest.trading_date - INTERVAL '7 days'
    ) wkrange ON true
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date <= latest.trading_date AND trading_date >= latest.trading_date - INTERVAL '30 days'
    ) morange ON true
    -- The IV snapshot of the ticker's latest bar only: one left from before Signals was last switched off is weeks old.
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id AND snapshot_date = latest.trading_date
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    ORDER BY t.symbol
  `,
    [completedThroughDate, liveReferenceDate],
  );
  const rawRows = result.rows as RawRow[];

  // ONE query for every ticker's trend history (was: one IBKR historical call
  // per ticker per page load). Completed bars only, ascending.
  const closesByTickerId = new Map<string, number[]>();
  if (rawRows.length > 0) {
    const barRows: { ticker_id: string; close_price: string }[] = await db("daily_price_bars")
      .whereIn("ticker_id", rawRows.map((row) => row.tickerId))
      .andWhere("trading_date", "<=", completedThroughDate)
      .andWhereRaw(`trading_date >= ?::date - INTERVAL '${trendHistoryYears} year'`, [completedThroughDate])
      .orderBy([{ column: "ticker_id" }, { column: "trading_date", order: "asc" }])
      .select("ticker_id", "close_price");
    for (const bar of barRows) {
      const closes = closesByTickerId.get(bar.ticker_id) ?? [];
      closes.push(Number(bar.close_price));
      closesByTickerId.set(bar.ticker_id, closes);
    }
  }

  const freshness = classifyFreshness(
    Object.fromEntries(rawRows.map((row) => [row.symbol, row.latestDate])),
    expectedSessionDate,
  );

  // IV Rank/Percentile mirror shortlist.ts's route exactly (same
  // computeIvMetrics call, same daily_price_bars source) so the numbers can't
  // drift between the two screens — see ivMetrics.ts.
  const tickers = await Promise.all(
    rawRows.map(async (row): Promise<PricePerformanceRow> => {
      const latestClose = Number(row.latestClose);
      const referenceCloses: ReferenceCloses = {
        close1dAgo: toNumberOrNull(row.close1dAgo),
        close2dAgo: toNumberOrNull(row.close2dAgo),
        close3dAgo: toNumberOrNull(row.close3dAgo),
        close1wAgo: toNumberOrNull(row.close1wAgo),
        close1mAgo: toNumberOrNull(row.close1mAgo),
        close3mAgo: toNumberOrNull(row.close3mAgo),
        close1yAgo: toNumberOrNull(row.close1yAgo),
      };
      const liveReferenceCloses: ReferenceCloses = {
        close1dAgo: toNumberOrNull(row.liveClose1dAgo),
        close2dAgo: toNumberOrNull(row.liveClose2dAgo),
        close3dAgo: toNumberOrNull(row.liveClose3dAgo),
        close1wAgo: toNumberOrNull(row.liveClose1wAgo),
        close1mAgo: toNumberOrNull(row.liveClose1mAgo),
        close3mAgo: toNumberOrNull(row.liveClose3mAgo),
        close1yAgo: toNumberOrNull(row.liveClose1yAgo),
      };
      return {
        symbol: row.symbol,
        companyName: row.companyName,
        latestDate: row.latestDate,
        latestClose: row.latestClose,
        dailyLow: row.dailyLow,
        dailyHigh: row.dailyHigh,
        weeklyLow: row.weeklyLow,
        weeklyHigh: row.weeklyHigh,
        monthlyLow: row.monthlyLow,
        monthlyHigh: row.monthlyHigh,
        change1d: percentChange(latestClose, referenceCloses.close1dAgo),
        change2d: percentChange(latestClose, referenceCloses.close2dAgo),
        change3d: percentChange(latestClose, referenceCloses.close3dAgo),
        change1w: percentChange(latestClose, referenceCloses.close1wAgo),
        change1m: percentChange(latestClose, referenceCloses.close1mAgo),
        change3m: percentChange(latestClose, referenceCloses.close3mAgo),
        change1y: percentChange(latestClose, referenceCloses.close1yAgo),
        referenceCloses,
        liveReferenceCloses,
        ...computePriceTrend(closesByTickerId.get(row.tickerId) ?? []),
        signalsEnabled: row.signalsEnabled,
        impliedVolatility: row.signalsEnabled ? row.impliedVolatility : null,
        avgOptionVolume: row.signalsEnabled ? row.avgOptionVolume : null,
        ...(await computeIvMetrics(row.tickerId)),
        isBehind: freshness.behindSymbols.includes(row.symbol),
      };
    }),
  );

  return {
    tickers,
    meta: {
      completedThroughDate,
      expectedSessionDate,
      isDataCurrent: freshness.behindSymbols.length === 0,
      behindSymbols: freshness.behindSymbols,
      liveReferenceDate,
    },
  };
}

// Absorbs a burst (several tabs reloading at once share one computation) and
// caps the load at one database pass per minute; the underlying data changes
// once a day, so a minute of lag (including right after the 16:00 ET cutoff
// moves) is far below anything a user could notice. Explicitly dropped after a
// populate-daily-bars run, and never carried across an Eastern calendar date.
const snapshotTtlMs = 60_000;
let cachedSnapshot: { snapshot: PricePerformanceSnapshot; computedAtMs: number; sessionDateAtCompute: string } | null = null;
let snapshotInFlight: Promise<PricePerformanceSnapshot> | null = null;

export function invalidatePricePerformanceSnapshot(): void {
  cachedSnapshot = null;
}

export async function getPricePerformanceSnapshot(now: Date = new Date()): Promise<PricePerformanceSnapshot> {
  // A different Eastern date invalidates the cache even inside the TTL.
  const sessionDate = easternIsoDate(now);
  if (cachedSnapshot && cachedSnapshot.sessionDateAtCompute === sessionDate && now.getTime() - cachedSnapshot.computedAtMs < snapshotTtlMs) {
    return cachedSnapshot.snapshot;
  }
  if (snapshotInFlight) return snapshotInFlight;
  snapshotInFlight = computePricePerformanceSnapshot(now)
    .then((snapshot) => {
      cachedSnapshot = { snapshot, computedAtMs: now.getTime(), sessionDateAtCompute: sessionDate };
      return snapshot;
    })
    .finally(() => {
      snapshotInFlight = null;
    });
  return snapshotInFlight;
}
