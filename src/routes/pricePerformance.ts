import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchLivePrices } from "../ibkr/fetchLivePrices.js";

export const pricePerformanceRouter = Router();
pricePerformanceRouter.use(requireAuth);

// All figures are computed purely from daily_price_bars (already captured
// nightly by job:daily-market-data) -- no live IBKR calls, same instant-load
// pattern as the rest of the Shortlist tab. "Latest" means each ticker's own most
// recent trading_date, not literal calendar today, so this stays correct
// even before today's bar has landed.
//
// 24hr/48hr/72hr use trading-day close deltas (1/2/3 trading days back),
// not true rolling 24-hour windows -- approved 2026-08-25, see PROGRESS.md.
// Weekly/monthly use a rolling 7/30 calendar-day window (also approved
// 2026-08-25), found via "closest available close on/before N days back"
// since weekends/holidays have no bar.
pricePerformanceRouter.get("/", async (_request, response) => {
  const result = await db.raw(`
    SELECT
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
      morange.high AS "monthlyHigh"
    FROM tickers t
    JOIN LATERAL (
      SELECT trading_date, close_price, low_price, high_price
      FROM daily_price_bars WHERE ticker_id = t.id ORDER BY trading_date DESC LIMIT 1
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
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date >= latest.trading_date - INTERVAL '7 days'
    ) wkrange ON true
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date >= latest.trading_date - INTERVAL '30 days'
    ) morange ON true
    WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
    ORDER BY t.symbol
  `);

  interface RawRow {
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
  }

  function percentChange(latest: string, previous: string | null): number | null {
    if (previous === null) return null;
    const latestNum = Number(latest);
    const previousNum = Number(previous);
    if (previousNum === 0) return null;
    return ((latestNum - previousNum) / previousNum) * 100;
  }

  const rows = (result.rows as RawRow[]).map((row) => ({
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
    change24h: percentChange(row.latestClose, row.close24hAgo),
    change48h: percentChange(row.latestClose, row.close48hAgo),
    change72h: percentChange(row.latestClose, row.close72hAgo),
    change1w: percentChange(row.latestClose, row.close1wAgo),
    change1m: percentChange(row.latestClose, row.close1mAgo),
  }));

  response.json({ tickers: rows });
});

// Current price, added 2026-08-30 per Juan's request to see it alongside
// last close rather than only the prior trading day's number. Deliberately
// a separate endpoint from GET / above, not folded into it: that route's
// whole point (per its header comment) is loading instantly from
// daily_price_bars regardless of IBKR Gateway state, and fetchLivePrices
// has an inherent ~5s wait even when the Gateway is healthy (up to IBKR's
// own connect timeout, currently 15s, when it isn't) -- inlining it there
// would make every page load wait on IBKR. Frontend calls this
// second/async, same instant-table-then-fill-in-live-data pattern as
// PositionsPage's fetchUnrealizedPnl. Best-effort: null per symbol when
// live pricing is unavailable (outside market hours, IBKR pacing, Gateway
// unreachable), never an error for the caller.
pricePerformanceRouter.get("/current-prices", async (_request, response) => {
  const tickerRows = await db("tickers as t")
    .select("t.symbol")
    .whereExists(function () {
      this.select(1).from("shortlist_entries as se").whereRaw("se.ticker_id = t.id").andWhere("se.removed_at", null);
    });

  let pricesBySymbol: Record<string, number | null> = {};
  try {
    pricesBySymbol = await fetchLivePrices(
      tickerRows.map((row: { symbol: string }) => ({ key: row.symbol, legType: "stock" as const, symbol: row.symbol })),
    );
  } catch (error) {
    console.error("price-performance/current-prices: fetchLivePrices failed", error);
  }

  const result: Record<string, number | null> = {};
  for (const row of tickerRows as { symbol: string }[]) {
    result[row.symbol] = pricesBySymbol[row.symbol] ?? null;
  }
  response.json(result);
});
