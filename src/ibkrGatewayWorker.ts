import "dotenv/config";
import { Client as PgClient } from "pg";
import { EventName, OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { CommissionReport, Contract, ComboLeg, Execution, Order as IbkrOrder } from "@stoqey/ib";
import { db } from "./db/connection.js";
import { environment } from "./config/env.js";
import { detectTradingModeFromAccountIds } from "./lib/detectTradingModeFromAccountIds.js";
import { readAppEnvironment } from "./lib/appEnvironment.js";
import { readGitSha } from "./lib/readGitSha.js";
import { getCurrentAccountBinding, getExpectedAccountId, initializeAccountBinding, startAccountBindingWatch } from "./ibkr/ibkrGatewayAccountBinding.js";
import { readExpirySettlementMode } from "./lib/expirySettlementAudit.js";
import { persistentIbkrConnection } from "./ibkr/ibkrGatewayPersistentConnection.js";
import { resolveContractId } from "./ibkr/ibkrGatewayResolveContractId.js";
import {
  buildLegContract,
  computeNetLimitPrice,
  type AdaptivePriority,
  type OrderLegPayload,
  type OrderRequestPayload,
} from "./ibkr/ibkrGatewayOrderPayload.js";
import { parseIbkrExecutionTime } from "./ibkr/ibkrGatewayParseExecutionTime.js";
import { fetchIbkrHeldPositions } from "./ibkr/ibkrGatewayFetchHeldPositions.js";
import { reconcileHeldPositions, type ReconciliationDependencies } from "./ibkr/ibkrGatewayReconcilePositions.js";
import { replayRecentIbkrExecutions } from "./ibkr/ibkrGatewayReplayRecentExecutions.js";
import { fetchIbkrOpenOrders } from "./ibkr/ibkrGatewayFetchOpenOrders.js";
import { fetchIbkrCompletedOrders } from "./ibkr/ibkrGatewayFetchCompletedOrders.js";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { notifyTelegram } from "./lib/notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./lib/throttledAlert.js";
import { formatDurationHuman } from "./lib/formatDurationHuman.js";
import { revertSourceAlertToPending } from "./lib/revertSourceAlertToPending.js";
import { publishNotification, publishPulse } from "./lib/notificationChannel.js";
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

// A row sitting in "confirmed"/"cancel_requested" this long without the
// worker picking it up is never normal (processing is near-instant once
// connected) -- treated as an incident, not a queue backlog. Chosen to be
// comfortably longer than the 30s poll fallback plus a few IBKR reconnect
// cycles, so a routine reconnect blip doesn't false-alarm.
const staleOrderAlertThresholdMs = 5 * 60_000;

const telegramNotifyTimeoutMs = 5_000;

/** Never lets a hung Telegram call block startup/shutdown paths that must proceed regardless. */
function notifyTelegramWithTimeout(message: string): Promise<void> {
  return Promise.race([notifyTelegram(message), new Promise<void>((resolve) => setTimeout(resolve, telegramNotifyTimeoutMs))]);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * IBKR's Adaptive algo, applied to every order (single-leg and BAG combo
 * alike). Confirmed via whatIf orders against the paper Gateway
 * (tmp/checkOrderTypeSupport.ts, 2026-08-31) that IBKR accepts this on both
 * shapes. It wraps the existing LMT order rather than replacing it — the
 * order type and lmtPrice are unchanged, so the worst-case fill price is
 * identical to today; Adaptive only affects how IBKR works the order to try
 * for a better/faster fill within that limit. Priority defaults to "Normal"
 * (Marcelo's original 2026-08-31 call, to keep same-day DAY-TIF fills
 * likely) but is now picked per-order from the Order Review screen
 * (Juan's 2026-09-02 ask) via payload.adaptivePriority.
 */
function buildAdaptiveAlgoFields(priority: AdaptivePriority = "Normal"): Pick<IbkrOrder, "algoStrategy" | "algoParams"> {
  return { algoStrategy: "Adaptive", algoParams: [{ tag: "adaptivePriority", value: priority }] };
}

/** Resolves every leg's conId (reusing a pre-resolved one where the payload already has it). */
async function resolveLegContractIds(
  ib: ReturnType<typeof persistentIbkrConnection.getIb>,
  legs: OrderLegPayload[],
): Promise<(number | null)[]> {
  if (!ib) return legs.map(() => null);
  let reqId = 70_000;
  const results: (number | null)[] = [];
  for (const leg of legs) {
    if (leg.ibkrContractId) {
      results.push(leg.ibkrContractId);
      continue;
    }
    results.push(await resolveContractId(ib, buildLegContract(leg), reqId++));
  }
  return results;
}

/**
 * Builds the IBKR Contract + Order for an order_requests row. A single leg
 * is a plain limit order; multiple legs become one atomic BAG combo order
 * (approved 2026-08-24 specifically to avoid a naked-exposure window — see
 * the plan doc's "Order atomicity" decision). This is the most
 * safety-critical piece of the whole redesign and needs real paper-account
 * verification (plan doc's verification step 3) before being trusted.
 */
async function buildOrder(payload: OrderRequestPayload): Promise<{ contract: Contract; order: IbkrOrder } | null> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return null;

  const conIds = await resolveLegContractIds(ib, payload.legs);
  if (conIds.some((conId) => conId === null)) return null;

  if (payload.legs.length === 1) {
    const leg = payload.legs[0]!;
    const contract = { ...buildLegContract(leg), conId: conIds[0]! };
    const order: IbkrOrder = {
      action: leg.action,
      orderType: OrderType.LMT,
      lmtPrice: leg.unitPrice,
      totalQuantity: leg.quantity,
      tif: TimeInForce.DAY,
      transmit: true,
      ...buildAdaptiveAlgoFields(payload.adaptivePriority),
    };
    return { contract, order };
  }

  // Real bug found 2026-08-24 closing a real 3-contract covered call: using
  // each leg's raw quantity as its ratio (300 shares : 3 contracts) isn't a
  // valid IBKR combo ratio — IBKR rejected it outright ("error 321: Invalid
  // leg ratio"). It only happened to work before because every order tested
  // so far was exactly 1 contract (100 shares : 1 contract, already in
  // lowest terms). IBKR combo ratios must be reduced to their smallest
  // integer terms, with totalQuantity carrying the reduced-out common
  // factor (the number of combo "units") — not always 1.
  const legRatioGcd = payload.legs.map((leg) => leg.quantity).reduce((a, b) => gcd(a, b));
  const comboLegs: ComboLeg[] = payload.legs.map((leg, index) => ({
    conId: conIds[index]!,
    ratio: leg.quantity / legRatioGcd,
    action: leg.action,
    exchange: "SMART",
  }));
  const contract: Contract = {
    symbol: payload.symbol,
    secType: SecType.BAG,
    currency: "USD",
    exchange: "SMART",
    comboLegs,
  };
  // Convention for combo/BAG orders: the top-level order action is BUY, and
  // each ComboLeg's own action + reduced ratio (set above) is what actually
  // encodes which legs are bought vs. sold and in what proportion.
  // totalQuantity is the number of combo "units" — legRatioGcd, not always 1.
  const order: IbkrOrder = {
    action: OrderAction.BUY,
    orderType: OrderType.LMT,
    lmtPrice: computeNetLimitPrice(payload.legs),
    totalQuantity: legRatioGcd,
    tif: TimeInForce.DAY,
    transmit: true,
    ...buildAdaptiveAlgoFields(payload.adaptivePriority),
  };
  return { contract, order };
}

/**
 * Cancels an order already submitted to IBKR (route: POST
 * /orders/:id/cancel, which flips status to "cancel_requested" and NOTIFYs
 * this same channel). Only this process holds the persistent IBKR
 * connection, so only it can call ib.cancelOrder() — the existing
 * orderStatus listener (see setupOrderTrackingListeners) flips the row to
 * "cancelled" once IBKR confirms, same as every other terminal status.
 */
async function processCancelRequest(orderRequestId: string): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) {
    console.error(`processCancelRequest(${orderRequestId}): no IBKR connection — cancel not sent, will retry on the next LISTEN/poll cycle.`);
    return;
  }

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "cancel_requested" }).first();
  if (!orderRequest) return; // already processed (cancelled/filled) or not actually requested

  if (!orderRequest.ibkr_order_id) {
    // Shouldn't happen — cancel_requested is only reachable from
    // submitted/partially_filled, both of which have an ibkr_order_id — but
    // fail safe rather than leaving the row stuck.
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "error", error_message: "cancel_requested with no ibkr_order_id.", updated_at: db.fn.now() });
    return;
  }

  ib.cancelOrder(orderRequest.ibkr_order_id);
}

async function processOrderRequest(orderRequestId: string): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) {
    console.error(`processOrderRequest(${orderRequestId}): no IBKR connection — order not sent, will retry on the next LISTEN/poll cycle.`);
    return;
  }

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "confirmed" }).first();
  if (!orderRequest) return; // already processed, cancelled, or not actually confirmed

  const payload = orderRequest.payload as OrderRequestPayload;

  // Fail-closed account binding (Phase B WP2). "pending" (just reconnected, accounts not reported yet) leaves the
  // order confirmed for the next poll cycle; a real mismatch errors it for good so a stale limit price can never
  // fire later once the binding recovers.
  const binding = getCurrentAccountBinding();
  if (binding.status === "pending") {
    console.log(`processOrderRequest(${orderRequestId}): account binding pending (${binding.reason}) — order left confirmed, will retry.`);
    return;
  }
  if (binding.status === "mismatch") {
    const message = `Trading blocked by account binding: ${binding.reason}`;
    console.error(`processOrderRequest(${orderRequestId}): ${message}`);
    await db("order_requests").where({ id: orderRequestId }).update({ status: "error", error_message: message, updated_at: db.fn.now() });
    await notifyTelegramWithTimeout(`🛑 Order for ${payload.symbol} (id ${orderRequestId}) was NOT sent to IBKR.\n${message}`);
    return;
  }
  console.log(`processOrderRequest(${orderRequestId}): building order for ${payload.symbol}, ${payload.legs.length} leg(s).`);
  try {
    const built = await buildOrder(payload);
    if (!built) {
      console.error(`processOrderRequest(${orderRequestId}): buildOrder returned null — could not resolve one or more contract ids.`);
      await db("order_requests")
        .where({ id: orderRequestId })
        .update({ status: "error", error_message: "Could not resolve one or more contract ids.", updated_at: db.fn.now() });
      return;
    }

    const ibkrOrderId = persistentIbkrConnection.getNextOrderId();
    // Conditioned on the row still being "confirmed": a cancel that landed
    // while buildOrder ran (2026-09-24) must win — otherwise this overwrote
    // "cancelled" with "submitted" and placed an order the app said was
    // cancelled. Zero rows changed means someone else moved it; do not place.
    const claimed = await db("order_requests")
      .where({ id: orderRequestId, status: "confirmed" })
      .update({ status: "submitted", ibkr_order_id: ibkrOrderId, updated_at: db.fn.now() })
      .returning("id");
    if (claimed.length === 0) {
      console.log(`processOrderRequest(${orderRequestId}): no longer confirmed (cancelled or already taken) — not placing.`);
      return;
    }

    console.log(`processOrderRequest(${orderRequestId}): placing IBKR order ${ibkrOrderId} (${payload.symbol}, lmtPrice=${built.order.lmtPrice}).`);
    // Name the account on the order itself: if the Gateway session does not manage it, IBKR rejects the order.
    built.order.account = getExpectedAccountId();
    ib.placeOrder(ibkrOrderId, built.contract, built.order);
    // Animation-only signal for Iorio Pulse's IBKR-Gateway line (never persisted).
    publishPulse("ibkr-gateway").catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "error", error_message: message, updated_at: db.fn.now() });
    await notifyTelegramWithTimeout(`🔥 Order request errored while placing with IBKR: ${payload.symbol} (id ${orderRequestId}).\n${message}`);
  }
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
      ssl: environment.nodeEnvironment === "production" ? { rejectUnauthorized: false } : undefined,
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

async function alertOnStaleOrderRequests(): Promise<void> {
  const thresholdCutoff = new Date(Date.now() - staleOrderAlertThresholdMs);

  const newlyStale = await db("order_requests")
    .whereIn("status", ["confirmed", "cancel_requested"])
    .andWhere("created_at", "<", thresholdCutoff)
    .whereNull("stale_alert_sent_at")
    .select("id", "status", "created_at", "payload");
  for (const row of newlyStale) {
    const symbol = (row.payload as OrderRequestPayload | null)?.symbol ?? "unknown symbol";
    const stuckMinutes = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60_000);
    await db("order_requests").where({ id: row.id }).update({ stale_alert_sent_at: db.fn.now() });
    await notifyTelegramWithTimeout(
      `⚠️ Order request stuck: ${symbol} (${row.status}) has not been picked up by the worker for ${stuckMinutes}+ minute(s) (id ${row.id}). Check the iorio-worker service on the VPS.`,
    );
  }

  const nowResolved = await db("order_requests")
    .whereNotIn("status", ["confirmed", "cancel_requested"])
    .whereNotNull("stale_alert_sent_at")
    .select("id", "status", "payload");
  for (const row of nowResolved) {
    const symbol = (row.payload as OrderRequestPayload | null)?.symbol ?? "unknown symbol";
    await db("order_requests").where({ id: row.id }).update({ stale_alert_sent_at: null });
    await notifyTelegramWithTimeout(`✅ Previously stuck order request resolved: ${symbol} is now "${row.status}" (id ${row.id}).`);
  }
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
      await alertOnStaleOrderRequests();
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
const finalOrderRequestStatuses = ["filled", "cancelled", "rejected", "error"];

function orderStatusToRequestStatus(status: string): string | null {
  if (status === "Filled") return "filled";
  if (status === "Cancelled" || status === "ApiCancelled") return "cancelled";
  if (status === "Submitted" || status === "PreSubmitted") return "submitted";
  return null;
}

function setupOrderTrackingListeners(): void {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  ib.on(EventName.orderStatus, (orderId, status, filled, remaining, _avgFillPrice, permId) => {
    publishPulse("ibkr-gateway").catch(() => {});
    const requestStatus = filled > 0 && remaining > 0 ? "partially_filled" : orderStatusToRequestStatus(status);
    if (!requestStatus) return;
    // permId is globally unique forever, unlike ibkr_order_id, which resets
    // and gets reused after every Gateway/worker restart — found 2026-08-27
    // when a fill for reused id 5 matched both a stale two-day-old row and
    // today's real order, flipping both to "filled". order_requests already
    // had an ibkr_perm_id column (2026-08-24) for exactly this, just never
    // wired up. Once a row has captured its permId, only let a further
    // update through if this callback's permId still matches it, so a
    // reused ibkr_order_id from a genuinely different order can't flip the
    // wrong row. reconcileStaleOrderRequests (run on every connect) is the
    // primary defense — this is a second layer for whatever it doesn't catch.
    // Also excludes rows already in a final status: once a row is filled,
    // cancelled, rejected, or errored, it should never change again, so a
    // status event that still names its (by-then-reused) ibkr_order_id must
    // belong to a different order.
    //
    // IBKR re-fires orderStatus with an unchanged status for an order that's
    // just sitting unfilled (e.g. a resting multi-day limit order) — found
    // 2026-09-22 from Pulse's Latest Events panel showing the same "Sent —"
    // line repeated many times for one order. Without a real change to
    // record, skip the write (and so the order_status notification below)
    // unless the status itself is moving or this callback is the one
    // capturing a not-yet-known permId — that capture still needs to go
    // through even on a same-status callback, or the permId collision guard
    // above never gets wired up for an order that goes straight from
    // "submitted" to "submitted" until it fills.
    db("order_requests")
      .where({ ibkr_order_id: orderId })
      .whereNotIn("status", finalOrderRequestStatuses)
      .andWhere((builder) => (permId ? builder.whereNull("ibkr_perm_id").orWhere("ibkr_perm_id", permId) : builder))
      .andWhere((builder) => {
        builder.whereNot("status", requestStatus);
        if (permId) builder.orWhereNull("ibkr_perm_id");
      })
      .update({
        status: requestStatus,
        updated_at: db.fn.now(),
        ...(permId ? { ibkr_perm_id: permId } : {}),
      })
      .returning(["id", "source_alert_id"])
      .then(async (rows) => {
        if (!rows[0]) return;
        await publishNotification({ type: "order_status", orderId: rows[0].id });
        if (requestStatus === "cancelled") await revertSourceAlertToPending(rows[0].source_alert_id);
      })
      .catch((error) => console.error(`Failed to update order_requests for order ${orderId}: ${error}`));
  });

  ib.on(EventName.execDetails, (_reqId, contract, execution) => {
    recordExecution(contract, execution).catch((error) => console.error(`Failed to record execution: ${error}`));
  });

  // Commissions arrive on their own event, keyed by execId, usually right
  // after execDetails (found 2026-09-19: nothing ever subscribed, so
  // trades.commission was NULL on every trade). Also fires for replayed
  // executions after a reconnect, which backfills whatever IBKR still returns.
  ib.on(EventName.commissionReport, (report) => {
    recordCommission(report).catch((error) => console.error(`Failed to record commission: ${error}`));
  });

  // Found by real testing (2026-08-24): a rejected/errored order surfaces
  // only as an EventName.error keyed by the order id, not an orderStatus
  // event — without this listener a rejection vanished with zero trace
  // anywhere (order_requests stuck at "submitted" forever, nothing in
  // reqAllOpenOrders, no log line). informational connection-status notices
  // (reqId -1) are excluded, same as connectIbkr.ts's handshake filtering.
  //
  // Also found by testing: not every EventName.error keyed by a real order
  // id is a rejection — code 399 ("Order Message") is IBKR attaching an
  // informational/warning notice to an order that was still accepted (e.g.
  // "will not be placed at the exchange until <next session open>" outside
  // market hours). IBKR's own convention is that the 2100-2169 range is
  // informational "system messages" too. Treating these as fatal would
  // flip a perfectly good queued order to "error".
  ib.on(EventName.error, (error, code, reqId) => {
    if (reqId === -1) return;
    if (code === 399 || (code >= 2100 && code <= 2169)) {
      console.log(`Order ${reqId} informational message: ${code} ${error.message}`);
      return;
    }
    db("order_requests")
      .where({ ibkr_order_id: reqId, status: "submitted" })
      .update({ status: "error", error_message: `IBKR error ${code}: ${error.message}`, updated_at: db.fn.now() })
      .returning(["id", "source_alert_id"])
      .then(async (rows) => {
        if (!rows[0]) return;
        console.error(`Order ${reqId} errored: ${code} ${error.message}`);
        await publishNotification({ type: "order_status", orderId: rows[0].id });
        await revertSourceAlertToPending(rows[0].source_alert_id);
      })
      .catch((dbError) => console.error(`Failed to record order error for ${reqId}: ${dbError}`));
  });
}

/**
 * Real bug found 2026-08-24 testing against 3 genuine paper fills: an
 * opening execution (no position_leg exists yet — reconcilePositionsFromIbkr
 * hasn't created it) was silently dropped instead of ever being recorded,
 * leaving the Trade Blotter permanently empty for every opening trade. This
 * buffers that raw execution, keyed by conId, so upsertSyncedPosition can
 * drain it into a real trades row the moment it creates the matching leg —
 * using the actual per-fill execution data (execId, price, quantity), not a
 * synthesized one from IBKR's aggregate avgCost.
 */
const pendingOpeningExecutions = new Map<string, { contract: Contract; execution: Execution }[]>();

// Looked up by permId, not ibkr_order_id — ibkr_order_id resets and gets
// reused after every Gateway/worker restart (see setupOrderTrackingListeners's
// own comment on this), so matching a trade to its requester by order id
// could attribute an old trade to whichever unrelated request later reused
// that same id. permId is globally unique forever. Null if this execution's
// order was placed outside the app (no order_requests row to find), which
// is expected, not an error.
async function lookupSourceOrderRequestId(execution: Execution): Promise<string | null> {
  if (!execution.permId) return null;
  const orderRequest = await db("order_requests").where({ ibkr_perm_id: execution.permId }).first("id");
  return orderRequest?.id ?? null;
}

// A commission report can arrive before the trades row exists (the execution
// is buffered until reconcilePositionsFromIbkr creates its leg). Hold it here
// and apply it right after the row is inserted. In-memory only: a worker
// restart in that gap loses it, but the post-reconnect execution replay
// re-emits commission reports for recent fills, so it self-heals.
const pendingCommissionsByExecId = new Map<string, number>();
const maxPendingCommissions = 500;

// IBKR sends Double.MAX_VALUE when a commission isn't known yet.
function isRealCommission(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value < 1e9;
}

async function recordCommission(report: CommissionReport): Promise<void> {
  if (!report.execId || !isRealCommission(report.commission)) return;
  const updatedRowCount = await db("trades").where({ ibkr_exec_id: report.execId }).update({ commission: report.commission });
  if (updatedRowCount > 0) {
    pendingCommissionsByExecId.delete(report.execId);
    return;
  }
  if (pendingCommissionsByExecId.size >= maxPendingCommissions) {
    pendingCommissionsByExecId.delete(pendingCommissionsByExecId.keys().next().value!);
  }
  pendingCommissionsByExecId.set(report.execId, report.commission);
}

async function applyPendingCommission(execId: string): Promise<void> {
  const commission = pendingCommissionsByExecId.get(execId);
  if (commission === undefined) return;
  await db("trades").where({ ibkr_exec_id: execId }).update({ commission });
  pendingCommissionsByExecId.delete(execId);
}

async function insertOpeningTradeRow(positionLegId: string, contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId) return;
  await db("trades")
    .insert({
      position_leg_id: positionLegId,
      ibkr_order_id: String(execution.orderId ?? ""),
      ibkr_exec_id: execution.execId,
      side: execution.side === "BOT" ? "buy" : "sell",
      quantity: execution.shares ?? 0,
      price: execution.price ?? 0,
      executed_at: parseIbkrExecutionTime(execution.time) ?? new Date(),
      is_closing_trade: false,
      source_order_request_id: await lookupSourceOrderRequestId(execution),
    })
    .onConflict("ibkr_exec_id")
    .ignore();
  await applyPendingCommission(execution.execId);
}

/**
 * Idempotent by construction — trades.ibkr_exec_id is UNIQUE, and each
 * partial fill has its own distinct execId (see @stoqey/ib's Execution type
 * doc comment), so re-processing the same execDetails event (e.g. after a
 * reconnect) is safe: the insert is a no-op on conflict.
 */
async function recordExecution(contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId || !contract.conId) return;
  if (getCurrentAccountBinding().status === "mismatch") {
    console.log(`Execution ${execution.execId} ignored: account binding mismatch.`);
    return;
  }

  const existing = await db("trades").where({ ibkr_exec_id: execution.execId }).first();
  if (existing) return;

  const conId = String(contract.conId);
  const leg = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").first();

  if (!leg) {
    // Brand-new position-opening fill (or one placed outside the app
    // entirely) — the leg doesn't exist yet because reconcilePositionsFromIbkr
    // hasn't run since this fill. Buffer it; upsertSyncedPosition drains this
    // once it creates the leg. (Real new-position creation/pairing itself
    // still only happens there, since that pass has the full current-holdings
    // picture needed to pair a stock leg with an option leg correctly.)
    const buffered = pendingOpeningExecutions.get(conId) ?? [];
    buffered.push({ contract, execution });
    pendingOpeningExecutions.set(conId, buffered);
    console.log(`Execution ${execution.execId} for conId ${conId} has no matching open leg yet — buffered for the next reconciliation pass.`);
    return;
  }

  const isClosing = execution.side === "BOT" ? leg.side === "short" : leg.side === "long";
  if (!isClosing) {
    // An add-on fill to an already-tracked leg (e.g. bought more of an
    // existing covered call's stock leg) — not a close, but still a real
    // execution the Trade Blotter should show. The leg's own `quantity`
    // doesn't get updated here (see upsertSyncedPosition for why) —
    // trigger reconciliation now so that sync reflects promptly rather
    // than waiting for the periodic 60s pass.
    await insertOpeningTradeRow(leg.id, contract, execution);
    reconcilePositionsFromIbkr().catch((error) => console.error(`Post-execution reconciliation failed: ${error}`));
    return;
  }

  // Record the trade only — do NOT flip position_legs.exit_at/exit_price
  // here. Real bug found 2026-08-25 on a same-day HOOD test position: a
  // single closing execution may only be a *partial* close (a 1-lot
  // closing fill on a 3-lot leg previously marked the WHOLE leg closed,
  // hiding the still-open 2-lot remainder — IBKR itself still held it).
  // reconcilePositionsFromIbkr is now the sole place a leg gets closed,
  // gated on IBKR reporting zero remaining holding for this conId — the
  // only unambiguous "genuinely fully closed" signal, regardless of how
  // many partial fills got there. Trigger it now so closing still reflects
  // near-instantly rather than waiting for the periodic 60s pass.
  await db("trades").insert({
    position_leg_id: leg.id,
    ibkr_order_id: String(execution.orderId ?? ""),
    ibkr_exec_id: execution.execId,
    side: execution.side === "BOT" ? "buy" : "sell",
    quantity: execution.shares ?? 0,
    price: execution.price ?? 0,
    executed_at: parseIbkrExecutionTime(execution.time) ?? new Date(),
    is_closing_trade: true,
    source_order_request_id: await lookupSourceOrderRequestId(execution),
  });
  await applyPendingCommission(execution.execId);

  reconcilePositionsFromIbkr().catch((error) => console.error(`Post-execution reconciliation failed: ${error}`));
}

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
  notifyTelegram: notifyTelegramWithTimeout,
  async drainPendingOpeningExecutions(conId, newLegId) {
    const buffered = pendingOpeningExecutions.get(conId);
    if (!buffered) return;
    pendingOpeningExecutions.delete(conId);
    for (const { contract, execution } of buffered) {
      await insertOpeningTradeRow(newLegId, contract, execution);
    }
  },
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
// What a non-open, non-completed row's own recorded executions say (trades
// rows link back through source_order_request_id, written by recordExecution
// via the permId lookup — which is why the execution replay and the position
// reconciliation both run before this on every connect).
type ExecutedOutcome = "filled" | "partially_filled" | "none";

async function executedOutcomeForOrderRequest(orderRequestId: string, payload: OrderRequestPayload): Promise<ExecutedOutcome> {
  const executedRows: { legType: "stock" | "option"; executed: string }[] = await db("trades as tr")
    .join("position_legs as pl", "pl.id", "tr.position_leg_id")
    .where("tr.source_order_request_id", orderRequestId)
    .groupBy("pl.leg_type")
    .select("pl.leg_type as legType", db.raw("SUM(tr.quantity) AS executed"));
  if (executedRows.length === 0) return "none";
  const executedByLegType = new Map(executedRows.map((row) => [row.legType, Number(row.executed)]));
  const everyLegFullyExecuted = payload.legs.every((leg) => (executedByLegType.get(leg.role) ?? 0) >= Math.abs(leg.quantity));
  return everyLegFullyExecuted ? "filled" : "partially_filled";
}

/**
 * Rows still non-terminal locally whose order IBKR no longer lists as open.
 * Before 2026-09-24 every such row was flagged "error" — including orders
 * that simply FILLED while the worker was down (the fill's orderStatus event
 * was never received), which then also reverted the source alert to pending
 * and invited a duplicate order. Now, in order of authority:
 *   1. still open at IBKR → leave alone;
 *   2. IBKR's completed orders for this Gateway session (matched on permId,
 *      never on the session-scoped ibkr_order_id) → filled / cancelled;
 *   3. our own trades for this row (from the execution replay, which spans
 *      Gateway restarts within the day) → filled / partially_filled;
 *   4. otherwise → error, as before.
 */
async function reconcileStaleOrderRequests(): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const staleCandidates: { id: string; ibkr_order_id: number; ibkr_perm_id: number | null; source_alert_id: string | null; payload: OrderRequestPayload }[] = await db("order_requests")
    .whereIn("status", ["submitted", "partially_filled", "cancel_requested"])
    .whereNotNull("ibkr_order_id")
    .select("id", "ibkr_order_id", "ibkr_perm_id", "source_alert_id", "payload");
  if (staleCandidates.length === 0) return;

  const [openOrders, completedOrders] = await Promise.all([fetchIbkrOpenOrders(ib), fetchIbkrCompletedOrders(ib)]);
  const liveOrderIds = new Set(openOrders.map((order) => order.orderId));
  const completedStatusByPermId = new Map(completedOrders.filter((order) => order.permId).map((order) => [order.permId!, order.status]));

  for (const row of staleCandidates) {
    if (liveOrderIds.has(row.ibkr_order_id)) continue;

    const completedStatus = row.ibkr_perm_id ? completedStatusByPermId.get(row.ibkr_perm_id) : undefined;
    const resolvedStatus = completedStatus ? orderStatusToRequestStatus(completedStatus) : null;
    if (resolvedStatus === "filled" || resolvedStatus === "cancelled") {
      await db("order_requests").where({ id: row.id }).update({ status: resolvedStatus, updated_at: db.fn.now() });
      console.log(`reconcileStaleOrderRequests: row ${row.id} resolved to "${resolvedStatus}" from IBKR's completed orders (permId ${row.ibkr_perm_id}).`);
      await publishNotification({ type: "order_status", orderId: row.id });
      if (resolvedStatus === "cancelled") await revertSourceAlertToPending(row.source_alert_id);
      continue;
    }

    const executed = await executedOutcomeForOrderRequest(row.id, row.payload);
    if (executed !== "none") {
      await db("order_requests").where({ id: row.id }).update({ status: executed, updated_at: db.fn.now() });
      console.log(`reconcileStaleOrderRequests: row ${row.id} resolved to "${executed}" from its recorded executions.`);
      await publishNotification({ type: "order_status", orderId: row.id });
      continue;
    }

    await db("order_requests")
      .where({ id: row.id })
      .update({
        status: "error",
        error_message:
          "IBKR no longer reports this order as open, completed or executed (likely orphaned by a Gateway/worker restart) — its real status could not be confirmed. Check IBKR directly if this was a real order.",
        ibkr_order_id: null,
        updated_at: db.fn.now(),
      });
    console.warn(`reconcileStaleOrderRequests: flagged orphaned order_requests row ${row.id} (was ibkr_order_id ${row.ibkr_order_id}).`);
    await publishNotification({ type: "order_status", orderId: row.id });
    await revertSourceAlertToPending(row.source_alert_id);
  }
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
