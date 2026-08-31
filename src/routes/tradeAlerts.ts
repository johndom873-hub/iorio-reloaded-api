import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { runTradeAlertGeneration } from "../ibkr/runTradeAlertGeneration.js";
import { refreshTradeAlert } from "../ibkr/refreshTradeAlert.js";
import { refreshTickerTradeAlerts } from "../ibkr/refreshTickerTradeAlerts.js";
import { runJob, JobAlreadyRunningError } from "../lib/runJob.js";

const tradeAlertSelect = `
  SELECT
    ta.id,
    ta.strategy_key AS "strategyKey",
    ta.alert_type AS "alertType",
    ta.related_position_id AS "relatedPositionId",
    ta.suggested_structure AS "suggestedStructure",
    ta.rationale,
    ta.status,
    ta.reviewed_at AS "reviewedAt",
    ta.resulting_position_id AS "resultingPositionId",
    ta.created_at AS "createdAt",
    ta.last_refreshed_at AS "lastRefreshedAt",
    u.display_name AS "reviewedByDisplayName",
    t.id AS "tickerId",
    t.symbol,
    t.company_name AS "companyName",
    NULLIF(t.sector, '') AS sector
  FROM trade_alerts ta
  JOIN tickers t ON t.id = ta.ticker_id
  LEFT JOIN users u ON u.id = ta.reviewed_by_user_id
`;

export const tradeAlertsRouter = Router();
tradeAlertsRouter.use(requireAuth);

// v1 strategy scope — matches positions.ts/screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];
const validStatuses = [
  "pending",
  "approved",
  "rejected",
  "modified",
  "expired",
];
const heartbeatIntervalMs = 20_000;

tradeAlertsRouter.get("/", async (request, response) => {
  const status = (request.query.status as string | undefined) ?? "pending";
  const strategyKey = request.query.strategy as string | undefined;
  const symbol = request.query.symbol as string | undefined;

  if (!validStatuses.includes(status)) {
    response.status(400).json({ error: "Unknown status." });
    return;
  }
  if (strategyKey && !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategy." });
    return;
  }

  const conditions = ["ta.status = ?"];
  const params: string[] = [status];
  if (strategyKey) {
    conditions.push("ta.strategy_key = ?");
    params.push(strategyKey);
  }
  if (symbol) {
    conditions.push("t.symbol = ?");
    params.push(symbol.toUpperCase());
  }

  const result = await db.raw(
    `
    ${tradeAlertSelect}
    WHERE ${conditions.join(" AND ")}
    ORDER BY t.symbol, (ta.suggested_structure->>'annualizedYield')::numeric DESC
    `,
    params,
  );
  response.json(result.rows);
});

// Rejects a pending alert with no order ever placed for it (approving an
// alert always goes through order confirm instead — see
// positions.ts:/orders/:id/confirm — so this is genuinely the only status
// change this route needs to support). Backs Genosuke's reject_trade_alert
// tool, which called this exact path before it existed — found dead (404 on
// every call) during the 2026-08-28 user-attribution audit.
tradeAlertsRouter.patch("/:id", async (request, response) => {
  const { status } = request.body as { status?: string };
  if (status !== "rejected") {
    response
      .status(400)
      .json({ error: "Only status: 'rejected' is supported." });
    return;
  }

  const [updated] = await db("trade_alerts")
    .where({ id: request.params.id, status: "pending" })
    .update({
      status: "rejected",
      reviewed_by_user_id: request.session.userId,
      reviewed_at: db.fn.now(),
    })
    .returning("id");
  if (!updated) {
    response
      .status(404)
      .json({ error: "No pending trade alert found with that id." });
    return;
  }

  const result = await db.raw(`${tradeAlertSelect} WHERE ta.id = ?`, [
    request.params.id,
  ]);
  response.json(result.rows[0]);
});

// Manual "Run Now" trigger for the same scan as run-trade-alert-generation-job.ts
// (Heroku Scheduler). SSE rather than a blocking POST — the scan makes
// multiple sequential IBKR calls per shortlisted ticker per strategy (same
// shape as tickerDetail.ts's option-chain lookup) and can easily run past
// Heroku's ~30s router timeout once there's more than a handful of tickers.
// GET (not POST) because EventSource only supports GET — same tradeoff
// tickerDetail.ts's stream route made; the button click is still an
// explicit, user-initiated action, not something that could fire twice by
// accident (browsers don't prefetch EventSource requests).
//
// Wrapped in the same runJob() the scheduled script uses, so a manual run
// shows up in System Health's job history/status exactly like a scheduled
// one. Deliberately does not notify Telegram (per Marcelo, 2026-08-27) —
// this is a foreground run with live progress already visible in the
// browser via the SSE stream below, so a Telegram ping would just be noise.
// The scheduled job (run-trade-alert-generation-job.ts) is the one that
// notifies.
tradeAlertsRouter.get("/run-stream", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  try {
    await runJob(
      "trade_alert_generation",
      async () => {
        const { tickersScanned, totalNewAlerts } =
          await runTradeAlertGeneration((event) => send(event));
        return { details: { tickersScanned, totalNewAlerts } };
      },
      { triggeredBy: "manual", triggeredByUserId: request.session.userId },
    );
    send({ type: "done" });
  } catch (error) {
    if (error instanceof JobAlreadyRunningError) {
      send({
        type: "alreadyRunning",
        message:
          "A trade alert scan is already in progress — check back shortly instead of running another.",
      });
    } else {
      send({
        type: "streamError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

// Re-quotes one pending alert's exact contract(s) against live IBKR data —
// built 2026-08-24 so Juan (EU timezone, reviewing the 10pm UTC nightly
// scan the next morning) can validate a specific alert right as the US
// market opens without re-running the whole shortlist scan. See
// refreshTradeAlert.ts for why this is a couple of small IBKR calls, not
// the multi-strike scan "Run Alerts Now" does. Blocking POST, not SSE —
// one contract (or two, for a roll) is fast enough not to risk Heroku's
// router timeout the way the full scan can.
tradeAlertsRouter.post("/:id/refresh", async (request, response) => {
  const result = await refreshTradeAlert(request.params.id);
  if (!result.ok) {
    response
      .status(result.error === "Trade alert not found." ? 404 : 422)
      .json({ error: result.error });
    return;
  }

  const updated = await db.raw(`${tradeAlertSelect} WHERE ta.id = ?`, [
    request.params.id,
  ]);
  response.json(updated.rows[0]);
});

// Per-ticker equivalent of "Run Alerts Now" for new_trade alerts only (roll
// alerts are refreshed independently via their own per-alert refresh) —
// backs the Trade Alerts page's per-ticker "Refresh" button and the Ticker
// Detail modal's "Scan for Alerts"/"Refresh" button, both calling this same
// endpoint. Blocking POST, not SSE: a single ticker's two-strategy scan is
// fast enough not to risk Heroku's router timeout the way the full
// shortlist scan can (same reasoning as /:id/refresh above).
tradeAlertsRouter.post("/refresh-ticker", async (request, response) => {
  const { symbol } = request.body as { symbol?: string };
  if (!symbol) {
    response.status(400).json({ error: "symbol is required." });
    return;
  }

  const ticker = await db("tickers")
    .where({ symbol: symbol.toUpperCase() })
    .first();
  if (!ticker) {
    response.status(404).json({ error: "Ticker not found." });
    return;
  }

  try {
    await refreshTickerTradeAlerts(ticker.id, ticker.symbol);
  } catch (error) {
    response
      .status(502)
      .json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const updated = await db.raw(
    `
    ${tradeAlertSelect}
    WHERE ta.ticker_id = ? AND ta.alert_type = 'new_trade' AND ta.status = 'pending'
    ORDER BY (ta.suggested_structure->>'annualizedYield')::numeric DESC
    `,
    [ticker.id],
  );
  response.json(updated.rows);
});
