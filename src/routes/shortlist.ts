import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { searchTickers } from "../ibkr/searchTickers.js";
import { findOrCreateTicker, addTickerToShortlist } from "../ibkr/findOrCreateTicker.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";
import { getLatestBackfillRun, startTickerBackfill } from "../ibkr/tickerBackfillPipeline.js";
import { staleBackfillRunMinutes } from "../lib/tickerBackfillSteps.js";

export const shortlistRouter = Router();
shortlistRouter.use(requireAuth);

// Live IBKR search-as-you-type — matches symbol or company name, US-listed
// optionable stocks only. Registered before "/" so it doesn't collide with
// the strategy-list route.
shortlistRouter.get("/search", async (request, response) => {
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
shortlistRouter.get("/", async (_request, response) => {
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
      m.captured_at AS "capturedAt",
      CASE WHEN b.status = 'running' AND b.started_at > now() - make_interval(mins => ${staleBackfillRunMinutes}) THEN 'preparing' ELSE NULL END AS "backfillStatus",
      b.progress_percent AS "backfillProgressPercent",
      hb.first_bar::text AS "historyStartDate",
      -- Flagged when there is less than ~5 years of daily bars AND no pipeline run has ever completed the
      -- history step (a ticker that IPO'd recently can never reach 5 years, so a successful run clears the flag).
      CASE
        WHEN hb.first_bar IS NULL OR hb.first_bar > (current_date - interval '5 years' + interval '14 days')
          THEN NOT EXISTS (
            SELECT 1 FROM ticker_backfill_runs r
            WHERE r.ticker_id = t.id AND r.steps @> '[{"key":"history","status":"done"}]'::jsonb
          )
        ELSE false
      END AS "historyIncomplete"
    FROM shortlist_entries se
    JOIN tickers t ON t.id = se.ticker_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT status, started_at, progress_percent
      FROM ticker_backfill_runs
      WHERE ticker_id = t.id
      ORDER BY started_at DESC
      LIMIT 1
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT min(trading_date) AS first_bar
      FROM daily_price_bars
      WHERE ticker_id = t.id
    ) hb ON true
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

shortlistRouter.post("/", async (request, response) => {
  const { symbol, notes } = request.body as {
    symbol?: string;
    notes?: string;
  };

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  const { ticker } = await findOrCreateTicker(normalizedSymbol);

  const latestSnapshot = await db("market_data_snapshots")
    .where({ ticker_id: ticker.id })
    .orderBy("snapshot_date", "desc")
    .first();

  try {
    const entry = await addTickerToShortlist(ticker.id, ticker.symbol, request.session.userId, notes);

    response.status(201).json({
      id: entry.id,
      addedAt: entry.addedAt,
      notes: entry.notes,
      backfillRun: entry.backfillRun,
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

// New-ticker backfill progress (design agreed 2026-09-21). JSON snapshot of the
// latest run for a ticker (null if it never had one), and an SSE stream of the
// same that ends when the run finishes — the progress modal uses the stream,
// so closing the modal or refreshing never loses the run (it lives server-side).
shortlistRouter.get("/:tickerId/backfill", async (request, response) => {
  response.json(await getLatestBackfillRun(request.params.tickerId as string));
});

// Retry from the progress modal after a failed step. Idempotent: an in-progress
// run is returned as-is instead of starting a second one.
shortlistRouter.post("/:tickerId/backfill", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  response.status(202).json(await startTickerBackfill(ticker.id, ticker.symbol));
});

const backfillStreamPollMs = 1_000;
const backfillStreamHeartbeatMs = 20_000;

shortlistRouter.get("/:tickerId/backfill/stream", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const tickerId = request.params.tickerId as string;
  let closed = false;
  request.on("close", () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, backfillStreamHeartbeatMs);

  let lastSent = "";
  try {
    while (!closed) {
      const run = await getLatestBackfillRun(tickerId);
      const payload = JSON.stringify(run);
      if (payload !== lastSent) {
        response.write(`data: ${payload}\n\n`);
        lastSent = payload;
      }
      if (!run || run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, backfillStreamPollMs));
    }
  } catch (error) {
    console.error("shortlist backfill stream failed", error);
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

shortlistRouter.patch("/:id", async (request, response) => {
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

shortlistRouter.delete("/:id", async (request, response) => {
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
