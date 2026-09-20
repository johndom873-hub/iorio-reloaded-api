import { db } from "../db/connection.js";
import { computeIvMetrics } from "./ivMetrics.js";
import { easternDateIso, lastCompletedSessionDate } from "./marketSessionStatus.js";
import { computePriceTrend, type PriceTrend } from "./priceTrends.js";

// Everything the Price Performance page shows except the live price: end-of-day
// facts computed from daily_price_bars alone — zero IBKR calls at request time
// (design: PROGRESS.md "Price Performance redesign"). Only COMPLETED session
// bars are used, so a partial in-progress bar left behind by a chart top-up or a
// trade-alert scan can never show up as a "last close".

interface RawRow {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  latestDate: string;
  latestClose: string;
  dailyLow: string;
  dailyHigh: string;
  close24hAgo: string | null;
  close48hAgo: string | null;
  close72hAgo: string | null;
  close1wAgo: string | null;
  close1mAgo: string | null;
  weeklyLow: string;
  weeklyHigh: string;
  monthlyLow: string;
  monthlyHigh: string;
  impliedVolatility: string | null;
  avgOptionVolume: string | null;
}

export interface ReferenceCloses {
  close24hAgo: number | null;
  close48hAgo: number | null;
  close72hAgo: number | null;
  close1wAgo: number | null;
  close1mAgo: number | null;
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
  change24h: number | null;
  change48h: number | null;
  change72h: number | null;
  change1w: number | null;
  change1m: number | null;
  /** The closes each change is measured against — delivered once so the browser can apply the live price itself. */
  referenceCloses: ReferenceCloses;
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
  /** Tickers a manual refresh would actually fetch: latest completed bar older than completedThroughDate. */
  refreshableSymbols: string[];
}

export interface PricePerformanceSnapshot {
  tickers: PricePerformanceRow[];
  meta: PricePerformanceMeta;
}

// The nightly capture runs at 9:00 PM UTC (~5 PM ET), about an hour after the
// close; data is not "behind" until that job has had a comfortable window.
const nightlyJobGraceMs = 90 * 60 * 1000;
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

/** Pure freshness rule, exported for tests: which tickers are behind, and which a refresh would fetch. */
export function classifyFreshness(
  latestDateBySymbol: Record<string, string>,
  completedThroughDate: string,
  expectedSessionDate: string,
): { behindSymbols: string[]; refreshableSymbols: string[] } {
  const symbols = Object.keys(latestDateBySymbol).sort();
  return {
    behindSymbols: symbols.filter((symbol) => latestDateBySymbol[symbol]! < expectedSessionDate),
    refreshableSymbols: symbols.filter((symbol) => latestDateBySymbol[symbol]! < completedThroughDate),
  };
}

// The old fragment, unchanged except that "latest" is now the newest bar AT OR
// BEFORE the completed-session cutoff (the one `?` binding), and every "N days
// back" join still hangs off that latest date.
const historicalCloseJoins = `
  JOIN LATERAL (
    SELECT trading_date, close_price, low_price, high_price
    FROM daily_price_bars WHERE ticker_id = t.id AND trading_date <= ?::date ORDER BY trading_date DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date < latest.trading_date
    ORDER BY trading_date DESC OFFSET 0 LIMIT 1
  ) d1 ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date < latest.trading_date
    ORDER BY trading_date DESC OFFSET 1 LIMIT 1
  ) d2 ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date < latest.trading_date
    ORDER BY trading_date DESC OFFSET 2 LIMIT 1
  ) d3 ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date <= latest.trading_date - INTERVAL '7 days'
    ORDER BY trading_date DESC LIMIT 1
  ) wk ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date <= latest.trading_date - INTERVAL '30 days'
    ORDER BY trading_date DESC LIMIT 1
  ) mo ON true
`;

async function computePricePerformanceSnapshot(now: Date): Promise<PricePerformanceSnapshot> {
  const completedThroughDate = await lastCompletedSessionDate(now);
  const expectedSessionDate = await lastCompletedSessionDate(new Date(now.getTime() - nightlyJobGraceMs));

  // 24hr/48hr/72hr use trading-day close deltas (1/2/3 trading days back), not
  // true rolling 24-hour windows — approved 2026-08-25. Weekly/monthly use a
  // rolling 7/30 calendar-day window, found via "closest available close
  // on/before N days back".
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
      d1.close_price AS "close24hAgo",
      d2.close_price AS "close48hAgo",
      d3.close_price AS "close72hAgo",
      wk.close_price AS "close1wAgo",
      mo.close_price AS "close1mAgo",
      wkrange.low AS "weeklyLow",
      wkrange.high AS "weeklyHigh",
      morange.low AS "monthlyLow",
      morange.high AS "monthlyHigh",
      m.implied_volatility AS "impliedVolatility",
      m.avg_option_volume AS "avgOptionVolume"
    FROM tickers t
    ${historicalCloseJoins}
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date <= latest.trading_date AND trading_date >= latest.trading_date - INTERVAL '7 days'
    ) wkrange ON true
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date <= latest.trading_date AND trading_date >= latest.trading_date - INTERVAL '30 days'
    ) morange ON true
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
    ORDER BY t.symbol
  `,
    [completedThroughDate],
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
    completedThroughDate,
    expectedSessionDate,
  );

  // IV Rank/Percentile mirror shortlist.ts's route exactly (same
  // computeIvMetrics call, same daily_price_bars source) so the numbers can't
  // drift between the two screens — see ivMetrics.ts.
  const tickers = await Promise.all(
    rawRows.map(async (row): Promise<PricePerformanceRow> => {
      const latestClose = Number(row.latestClose);
      const referenceCloses: ReferenceCloses = {
        close24hAgo: toNumberOrNull(row.close24hAgo),
        close48hAgo: toNumberOrNull(row.close48hAgo),
        close72hAgo: toNumberOrNull(row.close72hAgo),
        close1wAgo: toNumberOrNull(row.close1wAgo),
        close1mAgo: toNumberOrNull(row.close1mAgo),
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
        change24h: percentChange(latestClose, referenceCloses.close24hAgo),
        change48h: percentChange(latestClose, referenceCloses.close48hAgo),
        change72h: percentChange(latestClose, referenceCloses.close72hAgo),
        change1w: percentChange(latestClose, referenceCloses.close1wAgo),
        change1m: percentChange(latestClose, referenceCloses.close1mAgo),
        referenceCloses,
        ...computePriceTrend(closesByTickerId.get(row.tickerId) ?? []),
        impliedVolatility: row.impliedVolatility,
        avgOptionVolume: row.avgOptionVolume,
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
      refreshableSymbols: freshness.refreshableSymbols,
    },
  };
}

// Absorbs a burst (several tabs reloading at once share one computation) and
// caps the load at one database pass per minute; the underlying data changes
// once a day, so a minute of lag (including right after the 16:00 ET cutoff
// moves) is far below anything a user could notice. Explicitly dropped after a
// refresh completes, and never carried across an Eastern calendar date.
const snapshotTtlMs = 60_000;
let cachedSnapshot: { snapshot: PricePerformanceSnapshot; computedAtMs: number; sessionDateAtCompute: string } | null = null;
let snapshotInFlight: Promise<PricePerformanceSnapshot> | null = null;

export function invalidatePricePerformanceSnapshot(): void {
  cachedSnapshot = null;
}

export async function getPricePerformanceSnapshot(now: Date = new Date()): Promise<PricePerformanceSnapshot> {
  // A different Eastern date invalidates the cache even inside the TTL.
  const sessionDate = easternDateIso(now);
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
