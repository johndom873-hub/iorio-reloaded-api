import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { streamLivePrices, type PriceContract } from "../ibkr/fetchLivePrices.js";
import { fetchCachedPriceBars } from "../ibkr/priceBarCache.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";
import { computeMacd, computeMovingAverages, type MacdSignal } from "../lib/technicalIndicators.js";
import { buildTrendLabel } from "../ibkr/generateTradeAlertCandidates.js";

export const pricePerformanceRouter = Router();
pricePerformanceRouter.use(requireAuth);

// Shared by GET / and GET /current-prices/stream below -- both need each
// shortlisted ticker's reference closes (1/2/3 trading days back, ~7/~30
// calendar days back) to turn a price into a % change; GET / uses today's
// latest completed close as the "current" side of that math, the stream
// route uses the live streamed price instead. Kept as one fragment so the
// two routes can't quietly drift on what "N days back" means.
const historicalCloseJoins = `
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
`;

function percentChange(current: number, previous: string | number | null): number | null {
  if (previous === null) return null;
  const previousNum = Number(previous);
  if (previousNum === 0) return null;
  return ((current - previousNum) / previousNum) * 100;
}

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
      WHERE ticker_id = t.id AND trading_date >= latest.trading_date - INTERVAL '7 days'
    ) wkrange ON true
    LEFT JOIN LATERAL (
      SELECT MIN(low_price) AS low, MAX(high_price) AS high FROM daily_price_bars
      WHERE ticker_id = t.id AND trading_date >= latest.trading_date - INTERVAL '30 days'
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
  `);

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

  function percentChange(latest: string, previous: string | null): number | null {
    if (previous === null) return null;
    const latestNum = Number(latest);
    const previousNum = Number(previous);
    if (previousNum === 0) return null;
    return ((latestNum - previousNum) / previousNum) * 100;
  }

  // IV Rank/Percentile mirror shortlist.ts's route exactly (same
  // computeIvMetrics call, same daily_price_bars source) so the numbers can't
  // drift between the two screens -- see ivMetrics.ts.
  const rows = await Promise.all(
    (result.rows as RawRow[]).map(async (row) => ({
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
      impliedVolatility: row.impliedVolatility,
      avgOptionVolume: row.avgOptionVolume,
      ...(await computeIvMetrics(row.tickerId)),
    })),
  );

  response.json({ tickers: rows });
});

// MACD/MA trend, added alongside the columns above -- deliberately a separate
// endpoint from GET / for the same reason current-prices is: these read
// through fetchCachedPriceBars, which can fall through to a live IBKR
// historical-data call on a cold/stale cache, and GET / above is meant to
// stay an instant DB-only load regardless of Gateway state. Best-effort per
// symbol (null on failure or insufficient history), same
// instant-table-then-fill-in-async pattern the frontend already uses for
// current-prices.
pricePerformanceRouter.get("/trends", async (_request, response) => {
  const tickerRows = await db("tickers as t")
    .select("t.symbol")
    .whereExists(function () {
      this.select(1).from("shortlist_entries as se").whereRaw("se.ticker_id = t.id").andWhere("se.removed_at", null);
    });

  const result: Record<string, { macdTrend: MacdSignal | null; maTrend: "uptrend" | "downtrend" | "mixed" | null }> = {};

  async function fetchOne(symbol: string): Promise<void> {
    try {
      const bars = await fetchCachedPriceBars(symbol, "1Y");
      if (bars.length === 0) {
        result[symbol] = { macdTrend: null, maTrend: null };
        return;
      }
      const closes = bars.map((bar) => bar.close);
      const spotPrice = closes[closes.length - 1]!;
      result[symbol] = {
        macdTrend: computeMacd(closes),
        maTrend: buildTrendLabel(spotPrice, computeMovingAverages(closes)),
      };
    } catch (error) {
      console.warn(`price-performance/trends: failed for ${symbol} — ${error instanceof Error ? error.message : error}`);
      result[symbol] = { macdTrend: null, maTrend: null };
    }
  }

  // Batched, not one big Promise.all -- found 2026-09-11 that firing a
  // historical-data fetch for every shortlisted ticker at once (15+) starts
  // intermittently failing a handful of them (different ones each run, all
  // otherwise-healthy tickers, confirmed via repeated direct curl probes) now
  // that this runs alongside GET /current-prices/stream's own concurrent IBKR
  // connection on every page load. Small batches trade a few extra seconds
  // of total wall time (this is a best-effort background fill-in, not
  // blocking the table's initial render) for not bursting IBKR's pacing.
  const batchSize = 4;
  const symbols = (tickerRows as { symbol: string }[]).map((row) => row.symbol);
  for (let i = 0; i < symbols.length; i += batchSize) {
    await Promise.all(symbols.slice(i, i + batchSize).map(fetchOne));
  }

  response.json(result);
});

interface StreamedPriceRow {
  currentPrice: number | null;
  change24h: number | null;
  change48h: number | null;
  change72h: number | null;
  change1w: number | null;
  change1m: number | null;
}

// Live current price + the same % change columns as GET / above, but
// recomputed against the streaming price instead of the latest completed
// daily close -- approved 2026-09-11 specifically so the "Current" cell's
// red/green (vs. latest close) and these badges agree with each other,
// which they didn't when the badges were the DB-only, close-vs-close
// figures from GET / while Current moved live. Same SSE
// FROZEN-then-REALTIME mechanics as positions.ts's pnl/stream (see that
// route's comments) -- streamLivePrices opens its own one-shot IBKR Gateway
// connection from the web dyno, same read-only path Positions already uses,
// not the worker's persistent trading connection.
pricePerformanceRouter.get("/current-prices/stream", async (request, response) => {
  const result = await db.raw(`
    SELECT
      t.symbol,
      d1.close_price AS "close24hAgo",
      d2.close_price AS "close48hAgo",
      d3.close_price AS "close72hAgo",
      wk.close_price AS "close1wAgo",
      mo.close_price AS "close1mAgo"
    FROM tickers t
    ${historicalCloseJoins}
    WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
    ORDER BY t.symbol
  `);

  interface ReferenceCloseRow {
    symbol: string;
    close24hAgo: string | null;
    close48hAgo: string | null;
    close72hAgo: string | null;
    close1wAgo: string | null;
    close1mAgo: string | null;
  }
  const referenceCloseRows = result.rows as ReferenceCloseRow[];

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  if (referenceCloseRows.length === 0) {
    send({});
    clearInterval(heartbeat);
    response.end();
    return;
  }

  const priceContracts: PriceContract[] = referenceCloseRows.map((row) => ({ key: row.symbol, legType: "stock", symbol: row.symbol }));

  try {
    await streamLivePrices(
      priceContracts,
      (pricesBySymbol) => {
        const resultBySymbol: Record<string, StreamedPriceRow> = {};
        for (const row of referenceCloseRows) {
          const currentPrice = pricesBySymbol[row.symbol] ?? null;
          resultBySymbol[row.symbol] =
            currentPrice === null
              ? { currentPrice: null, change24h: null, change48h: null, change72h: null, change1w: null, change1m: null }
              : {
                  currentPrice,
                  change24h: percentChange(currentPrice, row.close24hAgo),
                  change48h: percentChange(currentPrice, row.close48hAgo),
                  change72h: percentChange(currentPrice, row.close72hAgo),
                  change1w: percentChange(currentPrice, row.close1wAgo),
                  change1m: percentChange(currentPrice, row.close1mAgo),
                };
        }
        send(resultBySymbol);
      },
      abortController.signal,
    );
  } catch (error) {
    console.error("price-performance/current-prices/stream: streamLivePrices failed", error);
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
});
