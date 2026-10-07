import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { recordPlutoEvent } from "../pluto/ledger.js";
import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { searchTickers } from "../ibkr/searchTickers.js";
import { findOrCreateTicker, addTickerToShortlist, UnknownSymbolError } from "../ibkr/findOrCreateTicker.js";
import { fetchAndStoreFiveYearHistory, getLatestBackfillRun, startTickerBackfill, type TickerBackfillRun } from "../ibkr/tickerBackfillPipeline.js";
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
      se.signals_enabled AS "signalsEnabled",
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      NULLIF(t.sector, '') AS sector,
      se.bot_enabled AS "botEnabled",
      se.bot_enabled_changed_at AS "botEnabledChangedAt",
      bu.display_name AS "botEnabledChangedBy",
      CASE WHEN b.status = 'running' AND b.started_at > now() - make_interval(mins => ${staleBackfillRunMinutes}) THEN 'preparing' ELSE NULL END AS "backfillStatus",
      b.progress_percent AS "backfillProgressPercent",
      -- A 'partial' run means some pipeline step (calendar/chain-strikes/snapshot) failed -- surfaced so
      -- the Actions menu can offer a full-pipeline retry, not just the narrower price-history-only one.
      CASE WHEN b.status = 'partial' THEN true ELSE false END AS "backfillNeedsRetry",
      -- Remove is disabled in the Actions menu while this is above zero (DELETE below enforces the same).
      op.open_position_count::int AS "openPositionCount"
    FROM shortlist_entries se
    JOIN tickers t ON t.id = se.ticker_id
    LEFT JOIN users bu ON bu.id = se.bot_enabled_changed_by_user_id
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

// Signals defaults to off (Marcelo, 2026-10-07): the ticker is price-only until Signals is turned on.
shortlistRouter.post("/", async (request, response) => {
  const { symbol, signalsEnabled } = (request.body ?? {}) as {
    symbol?: string;
    signalsEnabled?: unknown;
  };

  if (typeof symbol !== "string" || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }
  if (signalsEnabled !== undefined && typeof signalsEnabled !== "boolean") {
    response.status(400).json({ error: "signalsEnabled must be true or false." });
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
    const entry = await addTickerToShortlist(ticker.id, ticker.symbol, request.session.userId, signalsEnabled ?? false);
    const sector = ticker.sector || null;

    response.status(201).json({
      id: entry.id,
      addedAt: entry.addedAt,
      signalsEnabled: entry.signalsEnabled,
      botEnabled: false,
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

// Per-ticker Signals flag (Marcelo, 2026-10-07). Turning it on starts the option-chain setup (strikes) in the
// background; turning it off also turns Pluto off for the ticker in the same update, since Pluto only trades
// Signals tickers (the shortlist_entries_bot_requires_signals constraint holds the same rule).
shortlistRouter.patch("/:id/signals-enabled", async (request, response) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== "boolean") {
    response.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  const userId = request.session.userId as string;
  const result = await db.transaction(async (trx) => {
    const entry = await trx("shortlist_entries as se")
      .join("tickers as t", "t.id", "se.ticker_id")
      .where("se.id", request.params.id)
      .whereNull("se.removed_at")
      .forUpdate("se")
      .first("se.id", "se.signals_enabled", "se.bot_enabled", "t.id as tickerId", "t.symbol");
    if (!entry) return null;
    const turnsPlutoOff = !enabled && Boolean(entry.bot_enabled);
    if (Boolean(entry.signals_enabled) !== enabled) {
      await trx("shortlist_entries")
        .where({ id: entry.id })
        .update({ signals_enabled: enabled, ...(turnsPlutoOff ? { bot_enabled: false, bot_enabled_changed_by_user_id: userId, bot_enabled_changed_at: trx.fn.now() } : {}) });
    }
    return { tickerId: entry.tickerId as string, symbol: entry.symbol as string, changed: Boolean(entry.signals_enabled) !== enabled, turnsPlutoOff, botEnabled: Boolean(entry.bot_enabled) && !turnsPlutoOff };
  });
  if (!result) {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  if (result.turnsPlutoOff) {
    const user = await db("users").where({ id: userId }).first("display_name");
    await recordPlutoEvent("ticker_disabled", { symbol: result.symbol, by: `${user?.display_name ?? "an operator"} (turned Signals off)` });
  }
  // The entry is already saved; a setup that cannot start must not read as "toggle failed" (same as an add).
  let backfillRun: TickerBackfillRun | null = null;
  if (enabled && result.changed) {
    try {
      backfillRun = await startTickerBackfill(result.tickerId, result.symbol, undefined, "option_chain");
    } catch (error) {
      console.warn(`signals-enabled: option-chain setup for ${result.symbol} could not start — ${error instanceof Error ? error.message : error}`);
    }
  }
  response.json({ signalsEnabled: enabled, botEnabled: result.botEnabled, backfillRun });
});

// Pluto's per-ticker allow flag (design 2026-09-28): default off, any user may flip it, audited on
// the row, capped by pluto_settings.max_enabled_tickers because every enabled ticker costs one
// IBKR market-data line on Pluto's own connection.
shortlistRouter.patch("/:id/bot-enabled", async (request, response) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== "boolean") {
    response.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  const userId = request.session.userId as string;
  const result = await db.transaction(async (trx) => {
    const entry = await trx("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").where("se.id", request.params.id).whereNull("se.removed_at").forUpdate("se").first("se.id", "se.bot_enabled", "se.signals_enabled", "t.symbol");
    if (!entry) return { status: 404 as const, error: "Entry not found or already removed." };
    if (Boolean(entry.bot_enabled) === enabled) return { status: 200 as const, symbol: entry.symbol as string, changed: false };
    if (enabled && !entry.signals_enabled) return { status: 409 as const, error: `Turn Signals on for ${entry.symbol} first: Pluto only trades Signals tickers.` };
    if (enabled) {
      const settings = await loadPlutoSettings(trx);
      const enabledCount = await trx("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0));
      if (enabledCount >= settings.maxEnabledTickers) return { status: 409 as const, error: `Pluto already has ${enabledCount} enabled tickers, the maximum (${settings.maxEnabledTickers}). Disable one first or raise the cap on the Pluto screen.` };
    }
    await trx("shortlist_entries").where({ id: entry.id }).update({ bot_enabled: enabled, bot_enabled_changed_by_user_id: userId, bot_enabled_changed_at: trx.fn.now() });
    return { status: 200 as const, symbol: entry.symbol as string, changed: true };
  });
  if (result.status !== 200) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  if (result.changed) {
    const user = await db("users").where({ id: userId }).first("display_name");
    await recordPlutoEvent(enabled ? "ticker_enabled" : "ticker_disabled", { symbol: result.symbol, by: user?.display_name ?? "an operator" });
  }
  response.json({ botEnabled: enabled });
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
