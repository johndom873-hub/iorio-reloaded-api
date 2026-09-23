import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { searchTickers } from "../ibkr/searchTickers.js";
import { findOrCreateTicker, addTickerToShortlist } from "../ibkr/findOrCreateTicker.js";
import { fetchAndStoreFiveYearHistory, getLatestBackfillRun, startTickerBackfill } from "../ibkr/tickerBackfillPipeline.js";
import { connectToIbkrGateway } from "../ibkr/connectIbkr.js";
import { staleBackfillRunMinutes } from "../lib/tickerBackfillSteps.js";
import { loadShortlistDataReadiness } from "../lib/shortlistDataReadiness.js";
import { captureHistoricalEarnings } from "../lib/apiNinjasEarningsService.js";
import { refreshStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";

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

// One row per ticker currently monitored. Redesigned 2026-09-23 (Marcelo): the old IV/volume columns
// (sourced from market_data_snapshots) are gone -- this is now a per-ticker Signals data-readiness check,
// not a price/vol screen (Price Performance already covers that). Each row instead carries exactly the
// facts loadShortlistDataReadiness computes: the same data Signals reads before it can score a candidate,
// so a gap here is the direct explanation for why that ticker is thin or unscored there.
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
      CASE WHEN b.status = 'running' AND b.started_at > now() - make_interval(mins => ${staleBackfillRunMinutes}) THEN 'preparing' ELSE NULL END AS "backfillStatus",
      b.progress_percent AS "backfillProgressPercent",
      -- A 'partial' run means some pipeline step (calendar/chain-strikes/snapshot) failed -- surfaced so
      -- the Actions menu can offer a full-pipeline retry, not just the narrower price-history-only one.
      CASE WHEN b.status = 'partial' THEN true ELSE false END AS "backfillNeedsRetry",
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
    result.rows.map(async (row: { tickerId: string; sector: string | null; [key: string]: unknown }) => ({
      ...row,
      ...(await loadShortlistDataReadiness(row.tickerId, row.sector)),
    })),
  );
  response.json(rows);
});

// Manual re-trigger for the Shortlist Actions dropdown's "Backfill Earnings" item -- same
// captureHistoricalEarnings the new-ticker pipeline calls automatically, exposed here for an
// already-shortlisted ticker whose earnings history is thin. No-ops (written: 0, skippedEtf: true) for
// an ETF; the frontend also greys the menu item out so this is a defense-in-depth check, not the only one.
shortlistRouter.post("/:tickerId/backfill-earnings", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  const result = await captureHistoricalEarnings(ticker.id, ticker.symbol);
  response.json(result);
});

// Manual re-trigger for the Shortlist Actions dropdown's "Backfill Price History" item. Scoped to just
// the history step -- fetchAndStoreFiveYearHistory only, its own IBKR connection opened and closed here.
// Deliberately NOT startTickerBackfill/retryTickerBackfill: that runs the full 4-step new-ticker pipeline
// (history + calendar/dividends + chain-strike warmup + first snapshot), which is correct for onboarding
// a brand-new ticker but was wrong here -- clicking "Backfill Price History" on an existing ticker was
// silently also re-fetching its calendar and warming its option-chain strikes, neither of which the
// button claims to do (Marcelo caught this live, 2026-09-23: the progress modal it opened showed all 4
// steps running). Matches "Backfill Earnings" above in being a single-purpose action with no side effects
// outside its own name.
shortlistRouter.post("/:tickerId/backfill-price-history", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  const connection = await connectToIbkrGateway();
  try {
    const result = await fetchAndStoreFiveYearHistory(connection, ticker.id, ticker.symbol);
    response.json(result);
  } finally {
    connection.disconnect();
  }
});

// Manual re-trigger for the Shortlist Actions dropdown's "Refresh Option Chain" item -- re-runs
// refreshStoredOptionChain for this ticker only, same expiries+strikes fetch the nightly capture
// does, without touching history/earnings/calendar. Returns the updated per-expiry strike counts so
// the row can update without a full list reload.
shortlistRouter.post("/:tickerId/refresh-option-chain", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  if (ticker.ibkr_contract_id === null) {
    response.status(400).json({ error: "Ticker has no IBKR contract id stored." });
    return;
  }
  const connection = await connectToIbkrGateway();
  try {
    const refresh = await refreshStoredOptionChain(
      connection.ib,
      { tickerId: ticker.id, symbol: ticker.symbol, contractId: ticker.ibkr_contract_id },
      easternDateIso(new Date()),
    );
    const optionChainExpiries = Array.from(refresh.strikesByExpiry.entries())
      .map(([expiry, strikes]) => ({ expiry, strikeCount: strikes.length }))
      .sort((a, b) => a.expiry.localeCompare(b.expiry));
    response.json({ optionChainExpiries });
  } finally {
    connection.disconnect();
  }
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

  try {
    const entry = await addTickerToShortlist(ticker.id, ticker.symbol, request.session.userId, notes);
    const sector = ticker.sector || null;

    response.status(201).json({
      id: entry.id,
      addedAt: entry.addedAt,
      notes: entry.notes,
      backfillRun: entry.backfillRun,
      tickerId: ticker.id,
      symbol: ticker.symbol,
      companyName: ticker.company_name,
      sector,
      ...(await loadShortlistDataReadiness(ticker.id, sector)),
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
