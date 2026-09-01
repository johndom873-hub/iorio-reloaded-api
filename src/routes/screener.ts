import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchNewTickerData } from "../ibkr/fetchNewTickerData.js";
import { searchTickers } from "../ibkr/searchTickers.js";
import { connectToIbkrGateway } from "../ibkr/connectIbkr.js";
import { backfillOneYearOfDailyBars } from "../ibkr/priceBarCache.js";
import { captureTickerCalendarEvents } from "../lib/tradingviewCalendarService.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";

export const screenerRouter = Router();
screenerRouter.use(requireAuth);

// Live IBKR search-as-you-type — matches symbol or company name, US-listed
// optionable stocks only. Registered before "/" so it doesn't collide with
// the strategy-list route.
screenerRouter.get("/search", async (request, response) => {
  const query = (request.query.q as string | undefined)?.trim();
  if (!query || query.length < 1) {
    response.json([]);
    return;
  }

  const results = await searchTickers(query);
  response.json(results);
});

// One row per ticker currently monitored, carrying its latest
// market_data_snapshots row if one exists (LEFT JOIN LATERAL, not a plain
// join) — a just-added ticker with no capture yet still shows up, just with
// null IV/volume, filling in once the daily capture job runs. IV Rank/IV
// Percentile are computed separately (computeIvMetrics, daily_price_bars) —
// migrated off market_data_snapshots 2026-08-31 so both metrics, and both
// screens that show them (this one and Trade Alerts), read the same history
// and can't silently disagree with each other. impliedVolatility itself
// (the raw "as of" number, not the rank/percentile) stays on
// market_data_snapshots — it's the more frequently updated live capture,
// unrelated to which table backs the two history-based metrics.
screenerRouter.get("/", async (_request, response) => {
  const result = await db.raw(
    `
    SELECT
      se.id,
      se.added_at AS "addedAt",
      se.notes,
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      NULLIF(t.sector, '') AS sector,
      m.snapshot_date AS "snapshotDate",
      m.implied_volatility AS "impliedVolatility",
      m.avg_option_volume AS "avgOptionVolume",
      m.captured_at AS "capturedAt"
    FROM shortlist_entries se
    JOIN tickers t ON t.id = se.ticker_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    WHERE se.removed_at IS NULL
    ORDER BY t.symbol
    `,
  );

  const rows = await Promise.all(
    result.rows.map(async (row: { tickerId: string; [key: string]: unknown }) => ({
      ...row,
      ...(await computeIvMetrics(row.tickerId)),
    })),
  );
  response.json(rows);
});

screenerRouter.post("/", async (request, response) => {
  const { symbol, notes } = request.body as {
    symbol?: string;
    notes?: string;
  };

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();

  let ticker = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (!ticker) {
    const tickerData = await fetchNewTickerData(normalizedSymbol);
    [ticker] = await db("tickers")
      .insert({
        symbol: normalizedSymbol,
        company_name: tickerData.companyName,
        sector: tickerData.sector,
        ibkr_contract_id: tickerData.conId,
      })
      .returning("*");

    await db("market_data_snapshots")
      .insert({
        ticker_id: ticker.id,
        snapshot_date: new Date().toISOString().slice(0, 10),
        implied_volatility: tickerData.impliedVolatility,
        avg_option_volume: tickerData.avgOptionVolume,
      })
      .onConflict(["ticker_id", "snapshot_date"])
      .merge();

    // Fire-and-forget: a year of daily bars gets this ticker's MA99/RSI/MACD
    // usable immediately instead of waiting ~99 days for the nightly job's
    // one-row-a-day capture to accumulate it (see backfillOneYearOfDailyBars
    // in priceBarCache.ts for why the existing lazy chart-open backfill
    // doesn't already cover this). Not awaited — a second IBKR connect plus
    // historical-data fetch on top of fetchNewTickerData's own connect above
    // risks the Heroku router timeout on this interactive request, and
    // nothing shown to the user right now depends on it.
    void (async () => {
      const backfillConnection = await connectToIbkrGateway();
      try {
        const count = await backfillOneYearOfDailyBars(backfillConnection, ticker.id, ticker.symbol);
        console.log(`screener POST /: backfilled ${count} daily bar(s) for ${ticker.symbol}.`);
      } catch (error) {
        console.error(`screener POST /: daily bar backfill failed for ${ticker.symbol}`, error);
      } finally {
        backfillConnection.disconnect();
      }
    })();
  }

  const latestSnapshot = await db("market_data_snapshots")
    .where({ ticker_id: ticker.id })
    .orderBy("snapshot_date", "desc")
    .first();

  try {
    const [entry] = await db("shortlist_entries")
      .insert({
        ticker_id: ticker.id,
        added_by_user_id: request.session.userId,
        notes: notes ?? null,
      })
      .returning("*");

    try {
      await captureTickerCalendarEvents(ticker.id, ticker.symbol);
    } catch (error) {
      console.error(`screener POST /: calendar capture failed for ${ticker.symbol}`, error);
    }

    response.status(201).json({
      id: entry.id,
      addedAt: entry.added_at,
      notes: entry.notes,
      tickerId: ticker.id,
      symbol: ticker.symbol,
      companyName: ticker.company_name,
      sector: ticker.sector || null,
      snapshotDate: latestSnapshot?.snapshot_date ?? null,
      impliedVolatility: latestSnapshot?.implied_volatility ?? null,
      avgOptionVolume: latestSnapshot?.avg_option_volume ?? null,
      capturedAt: latestSnapshot?.captured_at ?? null,
    });
  } catch (error) {
    // Partial unique index on (ticker_id) WHERE removed_at IS NULL.
    if ((error as { code?: string }).code === "23505") {
      response.status(409).json({ error: `${normalizedSymbol} is already being monitored.` });
      return;
    }
    throw error;
  }
});

screenerRouter.patch("/:id", async (request, response) => {
  const { notes } = request.body as { notes?: string | null };

  const [entry] = await db("shortlist_entries")
    .where({ id: request.params.id })
    .whereNull("removed_at")
    .update({ notes: notes ?? null })
    .returning("*");

  if (!entry) {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  response.json({ notes: entry.notes });
});

screenerRouter.delete("/:id", async (request, response) => {
  const updatedCount = await db("shortlist_entries")
    .where({ id: request.params.id })
    .whereNull("removed_at")
    .update({ removed_at: db.fn.now() });

  if (updatedCount === 0) {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  response.status(204).end();
});
