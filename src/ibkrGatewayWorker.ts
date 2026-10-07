import "dotenv/config";
import { Client as PgClient } from "pg";
import { EventName } from "@stoqey/ib";
import { db } from "./db/connection.js";
import { environment } from "./config/env.js";
import { postgresSslOption } from "./config/databaseSsl.js";
import { detectTradingModeFromAccountIds } from "./lib/detectTradingModeFromAccountIds.js";
import { readAppEnvironment } from "./lib/appEnvironment.js";
import { readGitSha } from "./lib/readGitSha.js";
import { getCurrentAccountBinding, getExpectedAccountId, initializeAccountBinding, startAccountBindingWatch } from "./ibkr/ibkrGatewayAccountBinding.js";
import { readExpirySettlementMode } from "./lib/expirySettlementAudit.js";
import { persistentIbkrConnection } from "./ibkr/ibkrGatewayPersistentConnection.js";
import { cancelSubmittedOrder, placeConfirmedOrder, type OrderPlacementDependencies } from "./ibkr/ibkrGatewayOrderPlacement.js";
import { createExecutionRecorder, handleOrderErrorEvent, handleOrderStatusEvent, reconcileStaleOrderRequests as reconcileStaleOrders } from "./ibkr/ibkrGatewayOrderTracking.js";
import { resolveContractId } from "./ibkr/ibkrGatewayResolveContractId.js";
import { allocateContractResolutionRequestId } from "./ibkr/contractResolutionRequestIds.js";
import { fetchIbkrHeldPositions } from "./ibkr/ibkrGatewayFetchHeldPositions.js";
import { reconcileHeldPositions, type ReconciliationDependencies } from "./ibkr/ibkrGatewayReconcilePositions.js";
import { sendDuePositionTelegramNotices } from "./lib/positionTelegramNotices.js";
import { replayRecentIbkrExecutions } from "./ibkr/ibkrGatewayReplayRecentExecutions.js";
import { fetchIbkrOpenOrders } from "./ibkr/ibkrGatewayFetchOpenOrders.js";
import { fetchIbkrCompletedOrders } from "./ibkr/ibkrGatewayFetchCompletedOrders.js";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { notifyTelegram } from "./lib/notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./lib/throttledAlert.js";
import { formatDurationHuman } from "./lib/formatDurationHuman.js";
import { publishNotification, publishPulse } from "./lib/notificationChannel.js";
import { endOrderIfPlacementBlocked } from "./lib/orderPlacementEnforcement.js";
import { endOrderIfLimitPriceUnsafe } from "./ibkr/ibkrGatewayLimitPriceCheck.js";
import { captureExecutionQuote } from "./ibkr/ibkrGatewayExecutionQuotes.js";
import { requestCancelOfUnfilledOrders } from "./ibkr/ibkrGatewayUnfilledOrderSweep.js";
import { alertOnStaleOrderRequests } from "./ibkr/ibkrGatewayStaleOrderAlert.js";
import { waitUntilDrained } from "./lib/waitUntilDrained.js";
import { computeSourceClosureHash } from "./lib/computeSourceClosureHash.js";

installCrashHandlers("worker");

// Graceful shutdown for a deploy/restart (Phase B: atomic release-phase worker deploy needs this —
// a bare SIGTERM/systemctl-restart kill mid-order-placement or mid-reconciliation is the exact risk
// that design is meant to close). Once SIGTERM arrives: stop starting NEW order/cancel handling and
// reconciliation passes (anything not yet started is safely picked up by the next process's own 30s
// poll fallback / initial reconciliation — both already exist for other outage cases), wait a bounded
// time for whatever's already running to finish, then exit. Module-scoped (not a separate lib file,
// like reconciliationInFlight below) because it needs direct access to this file's own in-flight state.
let shuttingDown = false;
let activeOrderRequestHandlers = 0;
const shutdownDrainTimeoutMs = 25_000;
const shutdownDrainPollIntervalMs = 250;

function installWorkerShutdownHandler(): void {
  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("SIGTERM received — no longer starting new order/cancel handling or reconciliation passes; draining in-flight work...");

    waitUntilDrained(() => activeOrderRequestHandlers === 0 && !reconciliationInFlight, shutdownDrainTimeoutMs, shutdownDrainPollIntervalMs).then(
      ({ drained, elapsedMs }) => {
        if (drained) {
          console.log(`SIGTERM: drained cleanly in ${elapsedMs}ms, exiting.`);
          process.exit(0);
          return;
        }
        const message = `⚠️ iorio-worker: shutting down (deploy/restart) with work still in flight after waiting ${Math.round(elapsedMs / 1000)}s (orderRequestHandlers=${activeOrderRequestHandlers}, reconciliationInFlight=${reconciliationInFlight}). Any interrupted DB write resolves itself on the next process's poll/reconcile pass — check job_runs/order_requests only if something looks stuck.`;
        console.error(message);
        notifyTelegramWithTimeout(message).finally(() => process.exit(0));
      },
    );
  });
}

installWorkerShutdownHandler();

/**
 * The persistent worker process — see PROGRESS.md's "IBKR is the source of
 * truth" decision (2026-08-24) and the plan at
 * ~/.claude/plans/purring-tumbling-lemur.md for the full design.
 *
 * Deployment (Phase B WP4): on staging, the Heroku release phase deploys this file's built commit
 * to the VPS automatically whenever it (or anything it imports) changes — see
 * scripts/run-release-phase-worker-deploy.ts and computeSourceClosureHash.ts for how "changes" is
 * decided, and scripts/deploy-worker-to-vps.sh / /opt/ibkr/deploy-worker-staging.sh for the actual
 * atomic build-then-swap. Manual deploys (`npm run deploy:worker:staging`) still work too.
 *
 * Owns the one long-lived IBKR connection in this app. Does two jobs:
 *  1. Places orders queued by the web dyno (order_requests table, picked up
 *     via Postgres LISTEN/NOTIFY) and tracks their status.
 *  2. Continuously reconciles IBKR's own reported positions/executions into
 *     positions/position_legs/trades, so those tables are always a mirror
 *     of IBKR, never an independently-maintained ledger.
 *
 * The web dyno never writes positions/position_legs/trades directly anymore
 * — only this process does, and only from data IBKR itself reported.
 */

const orderRequestsChannel = "order_requests_channel";
const reconciliationIntervalMs = 60_000;
const positionReqId = 1;

const telegramNotifyTimeoutMs = 5_000;

/** Never lets a hung Telegram call block startup/shutdown paths that must proceed regardless. */
function notifyTelegramWithTimeout(message: string): Promise<void> {
  return Promise.race([notifyTelegram(message).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, telegramNotifyTimeoutMs))]);
}

/** Whether the message was delivered within the timeout: a slow Telegram counts as undelivered (so it may arrive twice). */
function notifyTelegramDeliveredWithinTimeout(message: string): Promise<boolean> {
  return Promise.race([notifyTelegram(message), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), telegramNotifyTimeoutMs))]);
}

// Order placement lives in ibkr/ibkrGatewayOrderPlacement.ts (testable without this process); this wires in the real collaborators.
const orderPlacementDependencies: OrderPlacementDependencies = {
  db,
  getIb: () => persistentIbkrConnection.getIb(),
  getNextOrderId: () => persistentIbkrConnection.getNextOrderId(),
  getCurrentAccountBinding,
  getExpectedAccountId,
  endOrderIfPlacementBlocked,
  endOrderIfLimitPriceUnsafe: (orderRequest, ib) => endOrderIfLimitPriceUnsafe(orderRequest, ib),
  notify: notifyTelegramWithTimeout,
  publishPulse,
  resolveContractId,
  allocateContractResolutionRequestId,
};

function processCancelRequest(orderRequestId: string): Promise<void> {
  return cancelSubmittedOrder(orderRequestId, orderPlacementDependencies);
}

function processOrderRequest(orderRequestId: string): Promise<void> {
  return placeConfirmedOrder(orderRequestId, orderPlacementDependencies);
}

/**
 * The web dyno NOTIFYs the same channel for both a fresh confirm and a
 * cancel request, distinguished by the row's current status — dispatches to
 * whichever this row actually needs.
 */
async function handleOrderRequestNotification(orderRequestId: string, knownStatus?: string): Promise<void> {
  // Don't start new order/cancel handling once a SIGTERM is draining the process for a deploy/restart
  // — the row stays confirmed/cancel_requested and is picked up by the next process's own 30s poll
  // fallback, the same safety net that already covers a missed NOTIFY or a LISTEN outage.
  if (shuttingDown) {
    console.log(`handleOrderRequestNotification(${orderRequestId}): shutting down — deferring to the next process.`);
    return;
  }
  activeOrderRequestHandlers += 1;
  try {
    const status = knownStatus ?? (await db("order_requests").where({ id: orderRequestId }).first())?.status;
    if (status === "cancel_requested") {
      await processCancelRequest(orderRequestId);
    } else {
      await processOrderRequest(orderRequestId);
    }
  } finally {
    activeOrderRequestHandlers -= 1;
  }
}

// Root-caused 2026-09-08: a startup DB blip made the old single unguarded
// `await client.connect()` throw, which crashed main()'s promise chain but
// left the process alive (see main()'s comment below) with NO LISTEN, NO
// poll fallback, and NO periodic reconciliation ever registered — 3 days of
// confirmed orders silently never processed, with a healthy-looking IBKR
// connection the whole time. This retries the LISTEN connection forever with
// backoff instead of ever giving up, and alerts once the outage has gone on
// long enough to matter (rather than on every routine retry).
const listenConnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const listenOutageAlertThresholdMs = 3 * 60_000;

async function connectOrderRequestsListener(): Promise<PgClient> {
  const outageStartedAt = Date.now();
  let attempt = 0;
  let alertedThisOutage = false;

  for (;;) {
    const client = new PgClient({
      connectionString: environment.databaseUrl,
      ssl: postgresSslOption(),
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${orderRequestsChannel}`);
      const downForMs = Date.now() - outageStartedAt;
      if (attempt > 0) console.log(`order_requests LISTEN: reconnected after ${attempt} failed attempt(s), ${Math.round(downForMs / 1000)}s down.`);
      if (alertedThisOutage) {
        await notifyTelegramWithTimeout(`✅ order_requests LISTEN reconnected after being down for ${Math.round(downForMs / 60_000)}+ minute(s). Order processing (via NOTIFY) has resumed — the 30s poll fallback covered orders during the outage.`);
      }
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      const downForMs = Date.now() - outageStartedAt;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`order_requests LISTEN: connect attempt ${attempt + 1} failed (${message}), ${Math.round(downForMs / 1000)}s down so far.`);
      if (!alertedThisOutage && downForMs >= listenOutageAlertThresholdMs) {
        alertedThisOutage = true;
        await notifyTelegramWithTimeout(`⚠️ order_requests LISTEN has been down for ${Math.round(downForMs / 60_000)}+ minute(s) (${message}). Worker is retrying automatically; the 30s poll fallback is still processing confirmed orders in the meantime.`);
      }
      const delay = listenConnectDelaysMs[Math.min(attempt, listenConnectDelaysMs.length - 1)]!;
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

let listenerReattaching = false;

/** Establishes the LISTEN client and rewires it in place on drop — a dead LISTEN connection no longer takes down the whole worker (and its live IBKR session) to recover. */
async function attachOrderRequestsListener(): Promise<void> {
  const client = await connectOrderRequestsListener();
  client.on("notification", (message) => {
    if (message.channel !== orderRequestsChannel || !message.payload) return;
    handleOrderRequestNotification(message.payload).catch((error) => console.error(`Order request processing failed: ${error}`));
  });
  client.on("error", (error) => {
    console.error(`order_requests LISTEN connection error: ${error.message} — reattaching (worker itself stays up; 30s poll covers orders meanwhile).`);
    if (listenerReattaching) return;
    listenerReattaching = true;
    client.removeAllListeners();
    client.end().catch(() => {});
    attachOrderRequestsListener().finally(() => {
      listenerReattaching = false;
    });
  });
  console.log("order_requests LISTEN: connected and subscribed.");
}

/** Postgres LISTEN/NOTIFY — the web dyno NOTIFYs this channel with the order_requests.id on confirm. */
async function listenForOrderRequests(): Promise<void> {
  // Registered synchronously, independent of whether the LISTEN client below
  // ever manages to connect — this is the durable safety net (a missed
  // NOTIFY, a reconnect window, or a LISTEN outage of any length all still
  // get swept within 30s) and must never itself depend on the thing it's a
  // fallback for.
  setInterval(async () => {
    try {
      const stuck = await db("order_requests").whereIn("status", ["confirmed", "cancel_requested"]).select("id", "status");
      for (const row of stuck) await handleOrderRequestNotification(row.id, row.status);
      for (const id of await requestCancelOfUnfilledOrders()) {
        console.log(`Order ${id} has rested unfilled at IBKR past the Risk & Limits limit — cancelling.`);
        await publishNotification({ type: "order_status", orderId: id }).catch(() => {});
        await handleOrderRequestNotification(id, "cancel_requested");
      }
      await alertOnStaleOrderRequests({ notify: notifyTelegramWithTimeout, now: () => new Date() });
    } catch (error) {
      console.error(`order_requests poll fallback failed: ${error instanceof Error ? error.message : error}`);
    }
  }, 30_000);

  // Deliberately not awaited to completion here — connectOrderRequestsListener
  // retries forever on failure, and main() must not block startup (or the
  // periodic reconciliation/heartbeat intervals registered after this call)
  // on a LISTEN connection that may take a while to come up.
  attachOrderRequestsListener().catch((error) =>
    console.error(`order_requests LISTEN: attach failed unexpectedly: ${error instanceof Error ? error.message : error}`),
  );
}

// Truly final statuses only — partially_filled deliberately excluded, since
// that order can still receive further fills or a cancellation.
function setupOrderTrackingListeners(): void {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  ib.on(EventName.orderStatus, (orderId, status, filled, remaining, _avgFillPrice, permId) => {
    publishPulse("ibkr-gateway").catch(() => {});
    void handleOrderStatusEvent({ orderId, status, filled, remaining, permId }, orderTrackingDependencies);
  });

  ib.on(EventName.execDetails, (_reqId, contract, execution) => {
    executionRecorder.recordExecution(contract, execution).catch((error) => console.error(`Failed to record execution: ${error}`));
    captureExecutionQuote(ib, contract, execution).catch((error) => console.error(`Failed to capture the quote at execution ${execution.execId}: ${error}`));
  });

  // Commissions arrive on their own event, keyed by execId, usually right after execDetails; also fired for replayed
  // executions after a reconnect, which backfills whatever IBKR still returns.
  ib.on(EventName.commissionReport, (report) => {
    executionRecorder.recordCommission(report).catch((error) => console.error(`Failed to record commission: ${error}`));
  });

  // A rejected/errored order surfaces only as an error event keyed by the order id (see handleOrderErrorEvent).
  ib.on(EventName.error, (error, code, reqId) => {
    void handleOrderErrorEvent(error, code, reqId, orderTrackingDependencies);
  });
}

// The trades ledger: executions and commissions, plus what the position reconciliation drains into it (ibkr/ibkrGatewayOrderTracking.ts).
const executionRecorder = createExecutionRecorder({
  db,
  isAccountBindingMismatch: () => getCurrentAccountBinding().status === "mismatch",
  requestReconciliation: () => {
    reconcilePositionsFromIbkr().catch((error) => console.error(`Post-execution reconciliation failed: ${error}`));
  },
});

const orderTrackingDependencies = { db, publishNotification };

// Real bug found 2026-08-25 in a full-repo review: reconcilePositionsFromIbkr
// is fired-and-forgotten from three places (post-execution twice, plus a 60s
// setInterval) with nothing preventing two passes from running concurrently.
// IBKR's reqPositions() has no per-request id, so two in-flight calls to
// fetchIbkrHeldPositions would cross wires on the same position/positionEnd
// events — and even without that, two concurrent passes could both read
// "no existing leg yet" for a brand-new contract and both insert one,
// double-counting quantity and P&L. This mutex ensures only one pass's body
// ever runs at a time; a call that arrives mid-pass doesn't run a second
// reqPositions() — it just queues exactly one rerun for right after the
// current pass finishes, so nothing triggering a reconciliation is ever
// silently dropped.
let reconciliationInFlight = false;
let reconciliationRerunQueued = false;
let reconciliationPassCounter = 0;

const reconciliationDependencies: ReconciliationDependencies = {
  notifyTelegram: notifyTelegramDeliveredWithinTimeout,
  drainPendingOpeningExecutions: (conId, newLegId) => executionRecorder.drainPendingOpeningExecutions(conId, newLegId),
};

async function reconcilePositionsFromIbkr(): Promise<void> {
  // Don't start a new pass while draining for a shutdown (Phase B: atomic worker deploy) — anything
  // that would have triggered this gets a fresh reconciliation for free from the next process's own
  // initial-reconciliation-on-connect.
  if (shuttingDown) {
    console.log("Reconciliation skipped: shutting down for a deploy/restart.");
    return;
  }
  // Never sync positions from an account this environment is not bound to (Phase B WP2).
  const binding = getCurrentAccountBinding();
  if (binding.status !== "ok") {
    console.log(`Reconciliation skipped: account binding ${binding.status} — ${binding.reason}`);
    return;
  }
  if (reconciliationInFlight) {
    reconciliationRerunQueued = true;
    console.log("Reconciliation: a pass is already in flight — queuing exactly one rerun after it finishes.");
    return;
  }
  reconciliationInFlight = true;
  const passId = ++reconciliationPassCounter;
  const startedAt = Date.now();
  try {
    const ib = persistentIbkrConnection.getIb();
    if (!ib) {
      console.log(`Reconciliation #${passId}: no IBKR connection — skipping this pass.`);
      return;
    }
    const reqPositionsStartedAt = Date.now();
    const held = await fetchIbkrHeldPositions(ib);
    console.log(`Reconciliation #${passId}: reqPositions returned ${held.length} held contract(s) in ${Date.now() - reqPositionsStartedAt}ms.`);
    publishPulse("ibkr-gateway").catch(() => {});

    await reconcileHeldPositions(held, passId, reconciliationDependencies);
    // Inside the pass's lock, so the notices never read positions a concurrent pass is still changing.
    await sendDuePositionTelegramNotices(notifyTelegramDeliveredWithinTimeout);
    console.log(`Reconciliation #${passId}: pass completed in ${Date.now() - startedAt}ms.`);
  } catch (error) {
    console.error(`Reconciliation #${passId}: pass threw after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.stack ?? error.message : error}`);
    throw error;
  } finally {
    reconciliationInFlight = false;
    if (reconciliationRerunQueued) {
      reconciliationRerunQueued = false;
      console.log(`Reconciliation #${passId}: running the queued rerun now.`);
      reconcilePositionsFromIbkr().catch((error) => console.error(`Queued reconciliation rerun failed: ${error}`));
    }
  }
}


/**
 * Closes the window that let a fill for reused ibkr_order_id 5 match two
 * different order_requests rows (see the orderStatus listener's permId
 * comment above): any local row still
 * non-terminal (submitted/partially_filled/cancel_requested) that IBKR's own
 * reqAllOpenOrders() no longer reports as open almost certainly belongs to a
 * prior Gateway/worker session — its order id is free for IBKR to hand to a
 * genuinely different order next. Flags it for manual review and clears its
 * ibkr_order_id so it can never again be matched by a future reused id.
 * Run once at startup (awaited, before order-request processing begins) and
 * again on every reconnect, since a reused-id collision is only possible
 * right after a fresh session starts.
 */
function reconcileStaleOrderRequests(): Promise<void> {
  return reconcileStaleOrders({ db, publishNotification, getIb: () => persistentIbkrConnection.getIb(), fetchIbkrOpenOrders, fetchIbkrCompletedOrders });
}

// A failed connect no longer crashes the worker (see start()'s comment), so a
// Gateway outage -- IBKR maintenance, most often -- is reported here instead:
// one alert once it has lasted disconnectedAlertThresholdMs, an hourly
// reminder while it lasts, and one message on recovery. State is in
// alert_state so worker restarts don't re-announce it.
const disconnectedAlertKey = "worker_ibkr_disconnected";
const disconnectedAlertThresholdMs = 5 * 60_000;
const disconnectedAlertReminderIntervalMs = 60 * 60_000;

function startDisconnectedAlerting(): void {
  setInterval(() => {
    const { disconnectedSinceMs } = persistentIbkrConnection.getHealthSnapshot();
    if (disconnectedSinceMs === null) return;
    if (Date.now() - disconnectedSinceMs < disconnectedAlertThresholdMs) return;
    notifyDownThrottled(
      disconnectedAlertKey,
      // Must be constant text: notifyDownThrottled treats a changed message as a
      // new alert, so embedding the elapsed time here would re-alert every minute.
      // (Reminders add the elapsed time themselves.)
      "🔥 iorio-worker can't reach the IBKR Gateway. The worker is still running and retrying automatically.",
      disconnectedAlertReminderIntervalMs,
    ).catch((error) => console.error(`Disconnected-alert check failed: ${error instanceof Error ? error.message : error}`));
  }, 60_000);

  persistentIbkrConnection.onConnect(() => {
    clearDownState(disconnectedAlertKey)
      .then((downForMs) => (downForMs === null ? undefined : notifyTelegram(`✅ iorio-worker reconnected to the IBKR Gateway (was down ~${formatDurationHuman(downForMs)}).`)))
      .catch((error) => console.error(`Disconnected-alert recovery failed: ${error instanceof Error ? error.message : error}`));
  });
}

async function main(): Promise<void> {
  // Before anything can connect or trade: a missing/contradictory expected account must stop the process.
  initializeAccountBinding();
  startAccountBindingWatch();
  await persistentIbkrConnection.start();
  startDisconnectedAlerting();
  // onConnect fires immediately for the connection start() just made, and
  // again on every reconnect. Strictly sequenced: listeners first so replayed
  // executions flow through the same recordExecution path as live ones (see
  // ibkrGatewayReplayRecentExecutions.ts), then the position reconciliation
  // (which creates legs and drains buffered opening executions into trades),
  // and only then the stale-order reconciliation, which reads those trades
  // to tell a fill-while-down from a genuinely orphaned order.
  persistentIbkrConnection.onConnect((ib) => {
    setupOrderTrackingListeners();
    replayRecentIbkrExecutions(ib)
      .catch((error) => console.error(`Execution replay failed: ${error}`))
      .then(() => reconcilePositionsFromIbkr())
      .catch((error) => console.error(`Initial reconciliation failed: ${error}`))
      .then(() => reconcileStaleOrderRequests())
      .catch((error) => console.error(`Stale-order reconciliation failed: ${error}`));
  });

  await listenForOrderRequests();

  setInterval(() => {
    reconcilePositionsFromIbkr().catch((error) => console.error(`Periodic reconciliation failed: ${error}`));
  }, reconciliationIntervalMs);

  // Proves the event loop is still alive and reports connection health even
  // when nothing else is logging — added because the worker has needed
  // several unexplained restarts/day and, before this, total silence was
  // indistinguishable from a healthy-but-quiet period vs. a genuinely hung
  // process (e.g. a reconciliation pass stuck mid-await with nothing left
  // to log). If this stops appearing every 5 minutes, the process itself is
  // stuck, not just quiet.
  const heartbeatIntervalMs = 5 * 60_000;
  setInterval(() => {
    const health = persistentIbkrConnection.getHealthSnapshot();
    console.log(
      `Heartbeat: connected=${health.connected}, uptime=${health.uptimeMs !== null ? `${Math.round(health.uptimeMs / 1000)}s` : "n/a"}, lifetime reconnects=${health.totalReconnects}, lastSystemStatusCode=${health.lastSystemStatusCode ?? "none"}, reconciliation passes so far=${reconciliationPassCounter}, reconciliationInFlight=${reconciliationInFlight}.`,
    );
  }, heartbeatIntervalMs);

  // Separate, shorter-interval upsert for Iorio Pulse's Gateway node (worker
  // health as a *readable row*, not a log line — see worker_health's
  // migration comment for why this is a table, not a pg_notify event). 45s
  // rather than the 5-min console.log heartbeat above: that one exists to
  // prove the event loop is alive and was deliberately sized to avoid noise,
  // this one just needs to not look stale on a live dashboard; a cheap
  // upsert carries none of the "don't hammer IBKR" concern that interval was
  // originally about.
  const workerHealthUpsertIntervalMs = 45_000;
  // Identity columns (Phase B WP1, observation only): read once — code version and
  // environment cannot change while this process runs. APP_ENVIRONMENT must be in
  // the worker's .env before this code is deployed.
  const workerGitSha = readGitSha();
  const workerAppEnvironment = readAppEnvironment();
  // Phase B release-phase deploy: lets the deploy step skip redeploying the worker when the
  // commit being released doesn't actually change anything the worker runs (e.g. an API-only
  // route change) — see computeSourceClosureHash.ts. Never worth crashing startup over: on any
  // failure this just means the release phase can't prove "unchanged" and deploys anyway (safe
  // default), same as a git_sha read failure leaves that field null.
  let workerCodeHash: string | null = null;
  try {
    workerCodeHash = computeSourceClosureHash(process.cwd(), "src/ibkrGatewayWorker.ts").hash;
  } catch (error) {
    console.warn(`Could not compute the worker's source closure hash: ${error instanceof Error ? error.message : error}`);
  }
  // Fail fast if the mode is missing/invalid, rather than on the first expiry.
  readExpirySettlementMode();
  setInterval(() => {
    const health = persistentIbkrConnection.getHealthSnapshot();
    const bindingNow = getCurrentAccountBinding();
    db("worker_health")
      .insert({
        process_name: "ibkr_gateway_worker",
        connected: health.connected,
        uptime_ms: health.uptimeMs,
        total_reconnects: health.totalReconnects,
        unplanned_drops_last_24h: health.unplannedDropsLast24h,
        last_system_status_code: health.lastSystemStatusCode,
        client_id: health.clientId,
        git_sha: workerGitSha,
        app_environment: workerAppEnvironment,
        ibkr_account_ids: health.managedAccountIds,
        detected_trading_mode: detectTradingModeFromAccountIds(health.managedAccountIds),
        configured_trading_mode: environment.ibkrTradingMode,
        account_binding_status: bindingNow.status,
        account_binding_reason: bindingNow.reason,
        worker_code_hash: workerCodeHash,
        updated_at: db.fn.now(),
      })
      .onConflict("process_name")
      .merge()
      .catch((error) => console.error(`worker_health upsert failed: ${error instanceof Error ? error.message : error}`));
  }, workerHealthUpsertIntervalMs);

  console.log("Iorio worker started — persistent IBKR connection, order placement, position sync.");
}

// Root-caused 2026-09-08: `process.exitCode = 1` alone doesn't terminate the
// process — it only sets the code Node exits with once the event loop empties
// on its own. If persistentIbkrConnection.start() had already succeeded
// before some later step in main() threw (its socket/reconnect timers keep
// the event loop alive indefinitely), the process never actually exited: it
// sat there for 3 days looking "active (running)" to systemd, quietly
// missing every order-processing/reconciliation loop main() never got to
// register. installCrashHandlers.ts already established the correct policy
// for this app (an error leaves the process in an unknown state — let
// Heroku/systemd restart it cleanly rather than trying to limp on) but only
// covers uncaughtException/unhandledRejection; main()'s own explicit .catch
// intercepts its rejection before that global handler ever sees it, so it
// needs the same "always actually exit" ending applied here directly.
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FATAL] worker main() failed to start: ${message}`);
  notifyTelegramWithTimeout(`🔥 iorio-worker failed to start: ${message}\n\nProcess is exiting — systemd will restart it.`).finally(() => {
    process.exit(1);
  });
});
