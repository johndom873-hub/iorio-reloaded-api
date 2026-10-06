import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { searchTickers } from "../ibkr/searchTickers.js";
import { findOrCreateTicker, addTickerToShortlist, UnknownSymbolError } from "../ibkr/findOrCreateTicker.js";
import { fetchAndStoreFiveYearHistory, getLatestBackfillRun, startTickerBackfill } from "../ibkr/tickerBackfillPipeline.js";
import { topUpDailyBars } from "../ibkr/priceBarCache.js";
import { loadDailyBarsStatus } from "../lib/dailyBarsStatus.js";
import { borrowSharedConnectionOrConnect, nextReqIdFor, sharedReadConnection } from "../ibkr/sharedReadConnection.js";
import { staleBackfillRunMinutes } from "../lib/tickerBackfillSteps.js";
import { loadShortlistDataReadiness } from "../lib/shortlistDataReadiness.js";
import { captureHistoricalEarnings } from "../lib/apiNinjasEarningsService.js";
import { respondWithStreamedResult } from "../lib/streamedResponse.js";
import { refreshStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { invalidatePricePerformanceSnapshot } from "../lib/pricePerformanceSnapshot.js";
import { countOpenPositionsForTicker, describeOpenPositionsBlockingRemoval } from "../lib/positionQueries.js";

export const shortlistRouter = Router();
shortlistRouter.use(requireAuth);

// Live IBKR search-as-you-type — matches symbol or company name, US-listed
// optionable stocks only. Registered before "/" so it doesn't collide with
// the strategy-list route.
shortlistRouter.get("/search", async (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q.trim() : undefined;
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
      -- Remove is disabled in the Actions menu while this is above zero (DELETE below enforces the same).
      op.open_position_count::int AS "openPositionCount"
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
      SELECT count(*) AS open_position_count
      FROM positions
      WHERE ticker_id = t.id AND status = 'open'
    ) op ON true
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

// Manual re-trigger for the Shortlist Actions dropdown's "Populate Earnings" item -- same
// captureHistoricalEarnings the new-ticker pipeline calls automatically, exposed here for an
// already-shortlisted ticker whose earnings history is thin. No-ops (written: 0, skippedEtf: true) for
// an ETF; the frontend also greys the menu item out so this is a defense-in-depth check, not the only one.
shortlistRouter.post("/:tickerId/populate-earnings", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  const result = await captureHistoricalEarnings(ticker.id, ticker.symbol);
  response.json(result);
});

// The Shortlist Actions dropdown's "Populate Daily Bars" item: looks at what is stored and does what is
// needed (see dailyBarsStatus.ts) -- the full five years when history is missing or incomplete, only the
// missing sessions when the newest bar is behind, nothing when current. Scoped to daily bars: deliberately
// NOT startTickerBackfill/retryTickerBackfill, whose full 4-step new-ticker pipeline (history +
// calendar/dividends + chain-strike warmup + first snapshot) is right for onboarding but wrong for a
// single-purpose action. The plan is re-decided here from the database, not taken from the client.
// Streamed (see streamedResponse.ts): two sequential historical requests can pass Heroku's 30 s router timeout.
shortlistRouter.post("/:tickerId/populate-daily-bars", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  await respondWithStreamedResult(response, async () => {
    const { dailyBarsPlan } = await loadDailyBarsStatus(ticker.id);
    if (dailyBarsPlan === "none") return { status: 200, body: { plan: dailyBarsPlan } };
    const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, "populate-daily-bars");
    try {
      const reqId = nextReqIdFor(connection.ib, () => 1);
      const result =
        dailyBarsPlan === "full"
          ? await fetchAndStoreFiveYearHistory(connection, ticker.id, ticker.symbol, { reqId })
          : await topUpDailyBars(connection, ticker.id, ticker.symbol, reqId);
      invalidatePricePerformanceSnapshot();
      return { status: 200, body: { plan: dailyBarsPlan, ...result } };
    } finally {
      connection.disconnect();
    }
  });
});

// Manual re-trigger for the Shortlist Actions dropdown's "Populate Option Chain" item -- re-runs
// refreshStoredOptionChain for this ticker only, same expiries+strikes fetch the nightly capture
// does, without touching history/earnings/calendar. Returns the updated per-expiry strike counts so
// the row can update without a full list reload. Streamed (2026-09-24, see
// streamedResponse.ts): one wildcard contract-details request per expiry at
// ~4.5s each, sequential, passes Heroku's 30s router timeout past 6 expiries.
shortlistRouter.post("/:tickerId/populate-option-chain", async (request, response) => {
  const ticker = await db("tickers").where({ id: request.params.tickerId as string }).first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }
  if (ticker.ibkr_contract_id === null) {
    response.status(400).json({ error: "Ticker has no IBKR contract id stored." });
    return;
  }
  await respondWithStreamedResult(response, async () => {
    const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, "populate-option-chain");
    try {
      const refresh = await refreshStoredOptionChain(
        connection.ib,
        { tickerId: ticker.id, symbol: ticker.symbol, contractId: ticker.ibkr_contract_id },
        easternDateIso(new Date()),
      );
      const optionChainExpiries = Array.from(refresh.strikesByExpiry.entries())
        .map(([expiry, strikes]) => ({ expiry, strikeCount: strikes.length }))
        .sort((a, b) => a.expiry.localeCompare(b.expiry));
      return { status: 200, body: { optionChainExpiries } };
    } finally {
      connection.disconnect();
    }
  });
});

shortlistRouter.post("/", async (request, response) => {
  const { symbol, notes } = (request.body ?? {}) as {
    symbol?: string;
    notes?: string;
  };

  if (typeof symbol !== "string" || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  let ticker: Awaited<ReturnType<typeof findOrCreateTicker>>["ticker"];
  try {
    ({ ticker } = await findOrCreateTicker(normalizedSymbol));
  } catch (error) {
    if (error instanceof UnknownSymbolError) {
      response.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }

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
      openPositionCount: await countOpenPositionsForTicker(ticker.id),
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
  // Refused while the ticker has an open position; the UI greys Remove out
  // for the same reason, this covers Genosuke and stale tabs. Checked in the
  // same transaction as the removal so a position opening in between can't slip past.
  const outcome = await db.transaction(async (trx): Promise<"removed" | "not_found" | { openPositionCount: number }> => {
    const entry = await trx("shortlist_entries").where({ id: request.params.id }).whereNull("removed_at").first(["ticker_id"]);
    if (!entry) return "not_found";
    const openPositionCount = await countOpenPositionsForTicker(entry.ticker_id, trx);
    if (openPositionCount > 0) return { openPositionCount };
    await trx("shortlist_entries").where({ id: request.params.id }).update({ removed_at: trx.fn.now() });
    return "removed";
  });

  if (outcome === "not_found") {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  if (outcome !== "removed") {
    response.status(409).json({ error: describeOpenPositionsBlockingRemoval(outcome.openPositionCount) });
    return;
  }
  // Price Performance caches its table for a minute; its live stream reads the shortlist directly.
  invalidatePricePerformanceSnapshot();
  response.status(204).end();
});
