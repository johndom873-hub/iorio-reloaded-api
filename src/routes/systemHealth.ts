import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { runIbkrHealthCheckJob } from "../ibkr/checkIbkrHealthJob.js";
import * as presenceTracker from "../lib/presenceTracker.js";
import { getStreamMultiplexerStats } from "../streams/streamMultiplexer.js";
import { respondWithStreamedResult } from "../lib/streamedResponse.js";
import { fetchPresenceOverview } from "../lib/userLastSeen.js";
import * as llmStats from "../genosuke/llmStats.js";
import { requestRateStats, processStartedAt } from "../lib/requestRateTracker.js";
import { computeMarketSessionStatus } from "../lib/marketSessionStatus.js";
import { dbQueryTimingStats } from "../lib/dbQueryTimingTracker.js";
import { requireEnvironmentVariable } from "../config/env.js";
import { daySignalsLoopStatus } from "../lib/daySignalsLoop.js";
import { loadDayQuotesStatus } from "../lib/daySignalsStore.js";
import { marketDataPoolSnapshot } from "../ibkr/marketDataPool.js";
import { loadMarketDataLineRestriction, currentMarketDataLineReservationTotal } from "../ibkr/marketDataLineBudget.js";

export const systemHealthRouter = Router();
systemHealthRouter.use(requireAuth);

const defaultJobsLimit = 50;

const jobRunSelect = `
  SELECT
    id,
    job_name AS "jobName",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    status,
    error_message AS "errorMessage",
    details
  FROM job_runs
`;

systemHealthRouter.get("/jobs", async (request, response) => {
  const limit = Math.min(Number(request.query.limit) || defaultJobsLimit, 200);
  const result = await db.raw(`${jobRunSelect} ORDER BY started_at DESC LIMIT ?`, [limit]);
  response.json(result.rows);
});

// Latest run per distinct job_name — the per-module status cards.
systemHealthRouter.get("/status", async (_request, response) => {
  const result = await db.raw(`
    SELECT DISTINCT ON (job_name)
      id,
      job_name AS "jobName",
      started_at AS "startedAt",
      finished_at AS "finishedAt",
      status,
      error_message AS "errorMessage",
      details
    FROM job_runs
    ORDER BY job_name, started_at DESC
  `);
  response.json(result.rows);
});

// Runs the health check and returns the resulting job_runs row. Streamed
// (2026-09-24, see streamedResponse.ts): a normal run takes ~60-90s (two SSH
// round trips, the historical probe, the reconciliation) and a Gateway
// restart minutes — far past Heroku's 30s router timeout.
systemHealthRouter.post("/check-ibkr", async (request, response) => {
  await respondWithStreamedResult(response, async () => {
    try {
      const marketState = (await computeMarketSessionStatus()).state;
      await runIbkrHealthCheckJob({ allowGatewayRestart: marketState !== "open", triggeredBy: "manual", triggeredByUserId: request.session.userId });
    } catch {
      // runIbkrHealthCheckJob (via runJob) already logged the failure to
      // job_runs and notified Telegram — swallow here so the response below
      // still returns the logged row instead of a 500.
    }
    const result = await db.raw(`${jobRunSelect} WHERE job_name = 'ibkr_health_check' ORDER BY started_at DESC LIMIT 1`);
    return { status: 200, body: result.rows[0] ?? null };
  });
});

// --- Iorio Pulse support routes (2026-09-13) ---

// One-shot initial snapshot for the Front End node's presence display — the
// live stream (a "presence" frame on /notifications/stream, see
// presenceTracker.ts) only reports *changes* after connecting, so a fresh
// page load needs this to know who's already online. Also carries each
// user's last-active time (userLastSeen.ts) so offline users still show.
systemHealthRouter.get("/presence", async (_request, response) => {
  response.json({ users: await fetchPresenceOverview() });
});

// Database node stats — no existing pg_stat_activity/pg_database_size usage
// anywhere else in the app; this is new but a single, cheap, self-contained
// query (Postgres tracks all of this itself, no app-level bookkeeping).
// Connections are the total open (not just currently-active) because that is
// what Heroku's plan cap counts; the cap is the role's own connection limit
// (20 on Essential-1), falling back to the server's max_connections where the
// role is unlimited (local dev). Postgres can't report the plan's storage
// limit, so that comes from DB_PLAN_MAX_SIZE_BYTES (see .env.example).
systemHealthRouter.get("/db", async (_request, response) => {
  const maxDatabaseSizeBytes = requireEnvironmentVariable("DB_PLAN_MAX_SIZE_BYTES");
  const result = await db.raw(`
    SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS "totalConnections",
      (SELECT CASE WHEN rolconnlimit > 0 THEN rolconnlimit ELSE current_setting('max_connections')::int END
         FROM pg_roles WHERE rolname = current_user) AS "maxConnections",
      pg_database_size(current_database()) AS "databaseSizeBytes"
  `);
  response.json({ ...result.rows[0], maxDatabaseSizeBytes, responseTime: dbQueryTimingStats() });
});

// IBKR's primaryExch codes aren't the names traders actually say — captured
// verbatim from IBKR (see fetchNewTickerData.ts) since that's what the
// contract data gives us, translated to a display name here at read time.
const exchangeDisplayNames: Record<string, string> = { ISLAND: "NASDAQ" };

function displayExchangeName(primaryExchange: string | null): string {
  if (!primaryExchange) return "US Markets";
  return exchangeDisplayNames[primaryExchange] ?? primaryExchange;
}

// Every exchange any tracked ticker lists on (via tickers.primary_exchange,
// captured at ticker-creation time from IBKR's contract data), not just the
// ones with an open position right now, and not a hardcoded "NASDAQ · NYSE"
// label. One shared session-status computation
// serves all of them since NASDAQ/NYSE run identical hours — see
// marketSessionStatus.ts's header comment for when that would need to change.
systemHealthRouter.get("/market-status", async (_request, response) => {
  const rows: { primaryExchange: string | null }[] = await db("tickers")
    .whereNotNull("primary_exchange")
    .distinct("primary_exchange as primaryExchange");

  const exchangeNames = [...new Set(rows.map((row) => displayExchangeName(row.primaryExchange)))].sort();
  const status = await computeMarketSessionStatus();

  response.json({ exchanges: exchangeNames.length > 0 ? exchangeNames : ["US Markets"], state: status.state, label: status.label });
});

// Day Signals: the refresh loop's state (in-process; null when this process isn't running it),
// the day tables' contents, and the live market-data pool's budget standing.
systemHealthRouter.get("/day-signals", async (_request, response) => {
  const [quotes, restriction] = await Promise.all([loadDayQuotesStatus(), loadMarketDataLineRestriction()]);
  response.json({ loop: daySignalsLoopStatus(), quotes, marketDataPool: marketDataPoolSnapshot(), marketDataRestriction: restriction });
});

// Genosuke + LLM node stats. activeSessions will almost always read 0/1 in
// practice — auth is chat-level only (one shared Telegram chat, see
// genosuke/bot.ts's header comment), so there's genuinely only ever one
// chat_id in this deployment; not a bug.
systemHealthRouter.get("/genosuke", async (_request, response) => {
  const result = await db.raw(`
    SELECT
      (SELECT count(*) FROM genosuke_chat_messages WHERE role = 'assistant' AND created_at >= current_date) AS "messagesToday",
      (SELECT count(DISTINCT chat_id) FROM genosuke_chat_messages WHERE created_at >= now() - interval '24 hours') AS "activeSessions"
  `);
  response.json({
    ...result.rows[0],
    llm: { model: process.env.GENOSUKE_MODEL ?? null, ...llmStats.stats() },
  });
});

// Heroku web-dyno node stats — request rate (requestRateTracker.ts
// middleware, mounted in app.ts) and process uptime are real; "streams open"
// is deliberately scoped to /notifications/stream connections only (reusing
// presenceTracker's counter) and labeled as such below, not a true count of
// every SSE endpoint in the app (positions/greeks/pnl, risk-limits/exposure,
// ticker-detail streams are separate connections this doesn't see).
systemHealthRouter.get("/web-dyno", async (_request, response) => {
  response.json({
    requestsPerMinute: requestRateStats().requestsPerMinute,
    uptimeSeconds: Math.round(process.uptime()),
    processStartedAt,
    notificationStreamConnections: presenceTracker.totalConnectionCount(),
    // Stream multiplexer (streams/streamMultiplexer.ts): open tab connections and the live subscriptions on them, by kind.
    streamMultiplexer: getStreamMultiplexerStats(),
  });
});

// Gateway node stats — read from worker_health, upserted every ~45s by
// ibkrGatewayWorker.ts on the VPS (see that file and the worker_health
// migration for why this is a table the worker writes and the web dyno
// reads, not a pg_notify event). orderCount is NOT sourced from the worker
// at all — it's a plain web-dyno query against order_requests, no round
// trip needed.
systemHealthRouter.get("/gateway", async (_request, response) => {
  const [health, orderCountResult, reservedLineCount] = await Promise.all([
    db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first(),
    db("order_requests").whereIn("status", ["confirmed", "submitted", "cancel_requested"]).count("* as count").first(),
    currentMarketDataLineReservationTotal(),
  ]);

  if (!health) {
    response.json({ connected: false, staleOrMissing: true, inFlightOrderCount: Number(orderCountResult?.count ?? 0) });
    return;
  }

  response.json({
    connected: health.connected,
    uptimeMs: health.uptime_ms !== null ? Number(health.uptime_ms) : null,
    totalReconnects: health.total_reconnects,
    lastSystemStatusCode: health.last_system_status_code,
    clientId: health.client_id,
    updatedAt: health.updated_at,
    inFlightOrderCount: Number(orderCountResult?.count ?? 0),
    // Lines open on IBKR right now from the live market-data pool
    // (marketDataPool.ts, web dyno process: one reqMktData per subscribed
    // contract, however many screens share it; paused/unsubscribed entries
    // hold no line) — not a Gateway-worker stat, but the only live "IBKR
    // lines in use" number the app has, shown alongside it.
    marketDataLineCount: marketDataPoolSnapshot().openLineCount,
    reservedLineCount,
    staleOrMissing: false,
  });
});
