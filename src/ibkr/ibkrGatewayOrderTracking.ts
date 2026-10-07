import type { CommissionReport, Contract, Execution, IBApi } from "@stoqey/ib";
import type { Knex } from "knex";
import type { AppNotification } from "../lib/notificationChannel.js";
import { finalOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { ibkrInactiveOrderMessage, ibkrOrderCanceledErrorCode, ibkrOrderRejectionErrorCodes, requestStatusForIbkrRejection, requestStatusForOrderStatusEvent } from "./ibkrGatewayOrderStatus.js";
import { recordIbkrCancellationReason, recordIbkrOrderCanceled, workingOrderRequestStatuses, type ExecutedOutcome } from "./ibkrGatewayCancellationRecording.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";
import { parseIbkrExecutionTime } from "./ibkrGatewayParseExecutionTime.js";
import type { fetchIbkrCompletedOrders } from "./ibkrGatewayFetchCompletedOrders.js";
import type { fetchIbkrOpenOrders } from "./ibkrGatewayFetchOpenOrders.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// How the worker follows an order after it is placed: IBKR's order-status and error events, the executions and commissions
// that become the trades ledger, and the sweep that settles orders IBKR no longer lists. Kept apart from
// ibkrGatewayWorker.ts (which starts the worker as soon as it is imported) with every collaborator passed in, so each
// status transition and ledger write can be tested against a real database and no Gateway.

export interface OrderTrackingDependencies {
  db: Knex;
  publishNotification(notification: AppNotification): Promise<void>;
}

export interface OrderStatusEvent {
  orderId: number;
  status: string;
  filled: number;
  remaining: number;
  permId: number | undefined;
}

/**
 * Applies one IBKR orderStatus event to its order_requests row. Never rejects: a failure is logged.
 *
 * permId is globally unique forever, unlike ibkr_order_id, which resets and gets reused after every Gateway/worker restart.
 * Once a row has captured its permId, a further update only goes through if the event's permId still matches it, so a
 * reused ibkr_order_id from a genuinely different order cannot flip the wrong row. Rows already in a final status never
 * change again, so an event that still names their (by-then-reused) order id must belong to a different order.
 *
 * IBKR re-fires orderStatus with an unchanged status for an order that is just sitting unfilled. Without a real change to
 * record, the write (and the order_status notification) is skipped unless the status is moving or this event is the one
 * capturing a not-yet-known permId: that capture still has to go through on a same-status event, or the collision guard
 * above is never wired up for an order that goes straight from "submitted" to "submitted" until it fills.
 */
export function handleOrderStatusEvent(event: OrderStatusEvent, dependencies: OrderTrackingDependencies): Promise<void> {
  const { db } = dependencies;
  const { orderId, permId } = event;
  const requestStatus = requestStatusForOrderStatusEvent(event.status, event.filled, event.remaining);
  if (!requestStatus) return Promise.resolve();
  const isCancel = requestStatus === "cancelled" || requestStatus === "cancelled_partially_filled";

  const applyStatus = async (connection: Knex): Promise<{ id: string }[]> => {
    const rows: { id: string }[] = await connection("order_requests")
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
        // A fill that beat the sweep's cancel: the order is filled, not cancelled for lack of one.
        ...(requestStatus === "filled" ? { cancellation_reason: null } : {}),
        ...(event.status === "Inactive" ? { error_message: ibkrInactiveOrderMessage } : {}),
      })
      .returning(["id"]);
    if (rows[0] && isCancel) await recordIbkrCancellationReason(rows[0].id, connection);
    return rows;
  };
  // A cancel's status and reason commit together, so nothing reading the row (Genosuke's follow-up) sees one without the other.
  return (isCancel ? db.transaction(applyStatus) : applyStatus(db))
    .then(async (rows) => {
      if (!rows[0]) return;
      await dependencies.publishNotification({ type: "order_status", orderId: rows[0].id });
    })
    .catch((error) => console.error(`Failed to update order_requests for order ${orderId}: ${error}`));
}

/**
 * An IBKR error keyed by an order id. A rejected/errored order surfaces only as an error event, not an orderStatus event.
 * Not every error keyed by a real order id is a rejection: code 399 ("Order Message") attaches an informational notice to an
 * order that was still accepted, and IBKR's own convention is that 2100-2169 are informational system messages. Those never
 * flip an order to "error". reqId -1 is a connection-status notice. Never rejects: a failure is logged.
 */
export function handleOrderErrorEvent(error: Error, code: number, reqId: number, dependencies: OrderTrackingDependencies): Promise<void> {
  const { db } = dependencies;
  if (reqId === -1) return Promise.resolve();
  if (code === 399 || (code >= 2100 && code <= 2169)) {
    console.log(`Order ${reqId} informational message: ${code} ${error.message}`);
    return Promise.resolve();
  }
  if (code === ibkrOrderCanceledErrorCode) {
    return recordIbkrOrderCanceled(reqId, error.message, {
      executedOutcome: (orderRequestId, payload) => executedOutcomeForOrderRequest(orderRequestId, payload, db),
      notify: (orderRequestId) => dependencies.publishNotification({ type: "order_status", orderId: orderRequestId }),
    }).catch((dbError) => console.error(`Failed to record IBKR cancel for ${reqId}: ${dbError}`));
  }
  if (ibkrOrderRejectionErrorCodes.has(code)) {
    return recordIbkrOrderRejection(reqId, `IBKR error ${code}: ${error.message}`, dependencies).catch((dbError) => console.error(`Failed to record IBKR refusal for ${reqId}: ${dbError}`));
  }
  return db("order_requests")
    .where({ ibkr_order_id: reqId, status: "submitted" })
    .update({ status: "error", error_message: `IBKR error ${code}: ${error.message}`, updated_at: db.fn.now() })
    .returning(["id"])
    .then(async (rows) => {
      if (!rows[0]) return;
      console.error(`Order ${reqId} errored: ${code} ${error.message}`);
      await dependencies.publishNotification({ type: "order_status", orderId: rows[0].id });
    })
    .catch((dbError) => console.error(`Failed to record order error for ${reqId}: ${dbError}`));
}

/** An IBKR refusal (ibkrOrderRejectionErrorCodes) ends a working order as rejected, or as a cancel after a partial fill. */
async function recordIbkrOrderRejection(ibkrOrderId: number, errorMessage: string, dependencies: OrderTrackingDependencies): Promise<void> {
  const { db } = dependencies;
  const row = await db("order_requests").where({ ibkr_order_id: ibkrOrderId }).whereIn("status", workingOrderRequestStatuses).orderBy("created_at", "desc").first("id", "status");
  if (!row) return;
  const nextStatus = requestStatusForIbkrRejection(row.status);
  await db.transaction(async (transaction) => {
    await transaction("order_requests").where({ id: row.id }).update({ status: nextStatus, error_message: errorMessage, updated_at: db.fn.now() });
    if (nextStatus === "cancelled_partially_filled") await recordIbkrCancellationReason(row.id, transaction);
  });
  console.error(`Order ${ibkrOrderId} ${nextStatus}: ${errorMessage}`);
  await dependencies.publishNotification({ type: "order_status", orderId: row.id });
}

/**
 * What a non-open, non-completed row's own recorded executions say: trades rows link back through source_order_request_id,
 * written by the execution recorder via the permId lookup, which is why the execution replay and the position
 * reconciliation both run before this on every connect.
 */
export async function executedOutcomeForOrderRequest(orderRequestId: string, payload: OrderRequestPayload, db: Knex): Promise<ExecutedOutcome> {
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

export interface StaleOrderReconciliationDependencies extends OrderTrackingDependencies {
  getIb(): IBApi | null;
  fetchIbkrOpenOrders: typeof fetchIbkrOpenOrders;
  fetchIbkrCompletedOrders: typeof fetchIbkrCompletedOrders;
  now?: () => Date;
}

/**
 * Rows still non-terminal locally whose order IBKR no longer lists as open. In order of authority:
 *   1. still open at IBKR → leave alone;
 *   2. IBKR's completed orders for this Gateway session (matched on permId, never on the session-scoped ibkr_order_id) →
 *      filled / cancelled;
 *   3. our own trades for this row (from the execution replay, which spans Gateway restarts within the day) →
 *      filled / partially_filled;
 *   4. otherwise → error.
 * An order that simply filled while the worker was down must not be flagged "error": that would also revert its source alert
 * to pending and invite a duplicate order.
 */
export async function reconcileStaleOrderRequests(dependencies: StaleOrderReconciliationDependencies): Promise<void> {
  const { db } = dependencies;
  const ib = dependencies.getIb();
  if (!ib) return;
  const now = dependencies.now ?? (() => new Date());

  const staleCandidates: { id: string; ibkr_order_id: number; ibkr_perm_id: number | null; payload: OrderRequestPayload; created_at: Date }[] = await db("order_requests")
    .whereIn("status", workingOrderRequestStatuses)
    .whereNotNull("ibkr_order_id")
    .select("id", "ibkr_order_id", "ibkr_perm_id", "payload", "created_at");
  if (staleCandidates.length === 0) return;

  const [openOrders, completedOrders] = await Promise.all([dependencies.fetchIbkrOpenOrders(ib), dependencies.fetchIbkrCompletedOrders(ib)]);
  const liveOrderIds = new Set(openOrders.map((order) => order.orderId));
  const completedStatusByPermId = new Map(completedOrders.filter((order) => order.permId).map((order) => [order.permId!, order.status]));

  for (const row of staleCandidates) {
    if (liveOrderIds.has(row.ibkr_order_id)) continue;

    const completedStatus = row.ibkr_perm_id ? completedStatusByPermId.get(row.ibkr_perm_id) : undefined;
    const completedRequestStatus = completedStatus ? requestStatusForOrderStatusEvent(completedStatus, 0, 0) : null;
    if (completedRequestStatus === "filled" || completedRequestStatus === "cancelled" || completedRequestStatus === "rejected") {
      // The completed-orders list doesn't say whether a cancelled (or Inactive) order had partly filled; its recorded executions do.
      const resolvedStatus =
        completedRequestStatus !== "filled" && (await executedOutcomeForOrderRequest(row.id, row.payload, db)) === "partially_filled"
          ? "cancelled_partially_filled"
          : completedRequestStatus;
      await db.transaction(async (transaction) => {
        await transaction("order_requests")
          .where({ id: row.id })
          .update({ status: resolvedStatus, updated_at: db.fn.now(), ...(resolvedStatus === "rejected" ? { error_message: ibkrInactiveOrderMessage } : {}) });
        if (resolvedStatus === "cancelled" || resolvedStatus === "cancelled_partially_filled") await recordIbkrCancellationReason(row.id, transaction);
      });
      console.log(`reconcileStaleOrderRequests: row ${row.id} resolved to "${resolvedStatus}" from IBKR's completed orders (permId ${row.ibkr_perm_id}).`);
      await dependencies.publishNotification({ type: "order_status", orderId: row.id });
      continue;
    }

    // A DAY order from an earlier session cannot still be working: IBKR expired it at that session's close, even when
    // a Gateway restart since has dropped it from the completed-orders list.
    const expiredDayOrder = easternIsoDate(new Date(row.created_at)) < easternIsoDate(now());
    const executed = await executedOutcomeForOrderRequest(row.id, row.payload, db);
    if (executed !== "none" || expiredDayOrder) {
      const resolvedStatus = !expiredDayOrder ? executed : executed === "filled" ? "filled" : executed === "partially_filled" ? "cancelled_partially_filled" : "cancelled";
      await db.transaction(async (transaction) => {
        await transaction("order_requests").where({ id: row.id }).update({ status: resolvedStatus, updated_at: db.fn.now() });
        if (resolvedStatus === "cancelled" || resolvedStatus === "cancelled_partially_filled") await recordIbkrCancellationReason(row.id, transaction);
      });
      console.log(`reconcileStaleOrderRequests: row ${row.id} resolved to "${resolvedStatus}" from its recorded executions${expiredDayOrder ? " (a DAY order from an earlier session)" : ""}.`);
      await dependencies.publishNotification({ type: "order_status", orderId: row.id });
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
    await dependencies.publishNotification({ type: "order_status", orderId: row.id });
  }
}

export interface ExecutionRecordingDependencies {
  db: Knex;
  isAccountBindingMismatch(): boolean;
  /** Asks for a position reconciliation pass now (fire and forget): a fill changes what IBKR holds. */
  requestReconciliation(): void;
}

/** Most commission reports held while waiting for their trade row; the oldest is dropped beyond this. */
export const maxPendingCommissions = 500;

// IBKR sends Double.MAX_VALUE when a commission isn't known yet.
function isRealCommission(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value < 1e9;
}

/**
 * Turns IBKR executions and commission reports into trades rows. Holds two pieces of in-memory state:
 *  - opening executions with no matching leg yet, keyed by conId. The leg is created only by the position reconciliation
 *    (it has the full holdings picture needed to pair a stock leg with an option leg), which drains this buffer into real
 *    trades rows the moment it creates the leg, using the actual per-fill data (execId, price, quantity).
 *  - commission reports that arrived before their trades row existed. A worker restart in that gap loses them, but the
 *    post-reconnect execution replay re-emits commission reports for recent fills, so it self-heals.
 */
export function createExecutionRecorder(dependencies: ExecutionRecordingDependencies) {
  const { db } = dependencies;
  const pendingOpeningExecutions = new Map<string, { contract: Contract; execution: Execution }[]>();
  const pendingCommissionsByExecId = new Map<string, number>();

  // Looked up by permId, not ibkr_order_id: ibkr_order_id resets and gets reused after every Gateway/worker restart, so
  // matching a trade to its requester by order id could attribute an old trade to whichever unrelated request later reused
  // that id. Null if the order was placed outside the app (no order_requests row), which is expected, not an error.
  async function lookupSourceOrderRequestId(execution: Execution): Promise<string | null> {
    if (!execution.permId) return null;
    const orderRequest = await db("order_requests").where({ ibkr_perm_id: execution.permId }).first("id");
    return orderRequest?.id ?? null;
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

  async function insertOpeningTradeRow(positionLegId: string, _contract: Contract, execution: Execution): Promise<void> {
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
   * Idempotent by construction: trades.ibkr_exec_id is UNIQUE and each partial fill has its own distinct execId, so
   * re-processing the same execDetails event (e.g. after a reconnect) is safe.
   */
  async function recordExecution(contract: Contract, execution: Execution): Promise<void> {
    if (!execution.execId || !contract.conId) return;
    if (dependencies.isAccountBindingMismatch()) {
      console.log(`Execution ${execution.execId} ignored: account binding mismatch.`);
      return;
    }

    const existing = await db("trades").where({ ibkr_exec_id: execution.execId }).first();
    if (existing) return;

    const conId = String(contract.conId);
    const leg = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").first();

    if (!leg) {
      // A brand-new position-opening fill (or one placed outside the app entirely): the leg does not exist yet because the
      // position reconciliation has not run since this fill. Buffer it; the reconciliation drains the buffer once it
      // creates the leg.
      const buffered = pendingOpeningExecutions.get(conId) ?? [];
      buffered.push({ contract, execution });
      pendingOpeningExecutions.set(conId, buffered);
      console.log(`Execution ${execution.execId} for conId ${conId} has no matching open leg yet — buffered for the next reconciliation pass.`);
      return;
    }

    const isClosing = execution.side === "BOT" ? leg.side === "short" : leg.side === "long";
    if (!isClosing) {
      // An add-on fill to an already-tracked leg: not a close, but still a real execution the Trade Blotter should show.
      // The leg's own quantity is not updated here; the reconciliation does that, so trigger it now rather than waiting
      // for the periodic pass.
      await insertOpeningTradeRow(leg.id, contract, execution);
      dependencies.requestReconciliation();
      return;
    }

    // Record the trade only: do NOT flip position_legs.exit_at/exit_price here. A single closing execution may only be a
    // partial close (a 1-lot closing fill on a 3-lot leg must not mark the whole leg closed and hide the still-open
    // 2-lot remainder). The reconciliation is the sole place a leg gets closed, gated on IBKR reporting zero remaining
    // holding for this conId. Trigger it now so closing still reflects near-instantly.
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

    dependencies.requestReconciliation();
  }

  /** Called by the position reconciliation when it creates a leg: writes the opening fills that were waiting for it. */
  async function drainPendingOpeningExecutions(conId: string, newLegId: string): Promise<void> {
    const buffered = pendingOpeningExecutions.get(conId);
    if (!buffered) return;
    pendingOpeningExecutions.delete(conId);
    for (const { contract, execution } of buffered) {
      await insertOpeningTradeRow(newLegId, contract, execution);
    }
  }

  return {
    recordExecution,
    recordCommission,
    drainPendingOpeningExecutions,
    bufferedOpeningExecutionCount: (conId: string) => pendingOpeningExecutions.get(conId)?.length ?? 0,
    pendingCommissionCount: () => pendingCommissionsByExecId.size,
  };
}
