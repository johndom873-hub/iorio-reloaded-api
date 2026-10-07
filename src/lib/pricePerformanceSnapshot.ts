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
  close24hAgo: string | null;
  close48hAgo: string | null;
  close72hAgo: string | null;
  close1wAgo: string | null;
  close1mAgo: string | null;
  close3mAgo: string | null;
  close1yAgo: string | null;
  signalsEnabled: boolean;
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
  change24h: number | null;
  change48h: number | null;
  change72h: number | null;
  change1w: number | null;
  change1m: number | null;
  change3m: number | null;
  change1y: number | null;
  /** The closes each change is measured against — delivered once so the browser can apply the live price itself. */
  referenceCloses: ReferenceCloses;
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
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date <= latest.trading_date - INTERVAL '91 days'
    ORDER BY trading_date DESC LIMIT 1
  ) q ON true
  LEFT JOIN LATERAL (
    SELECT close_price FROM daily_price_bars
    WHERE ticker_id = t.id AND trading_date <= latest.trading_date - INTERVAL '365 days'
    ORDER BY trading_date DESC LIMIT 1
  ) yr ON true
`;

async function computePricePerformanceSnapshot(now: Date): Promise<PricePerformanceSnapshot> {
  const completedThroughDate = await lastCompletedSessionDate(now);
  const expectedSessionDate = await lastCompletedSessionDate(new Date(now.getTime() - nightlyJobGraceMs));

  // 24hr/48hr/72hr use trading-day close deltas (1/2/3 trading days back), not
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
      d1.close_price AS "close24hAgo",
      d2.close_price AS "close48hAgo",
      d3.close_price AS "close72hAgo",
      wk.close_price AS "close1wAgo",
      mo.close_price AS "close1mAgo",
      q.close_price AS "close3mAgo",
      yr.close_price AS "close1yAgo",
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
        close3mAgo: toNumberOrNull(row.close3mAgo),
        close1yAgo: toNumberOrNull(row.close1yAgo),
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
        change3m: percentChange(latestClose, referenceCloses.close3mAgo),
        change1y: percentChange(latestClose, referenceCloses.close1yAgo),
        referenceCloses,
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
