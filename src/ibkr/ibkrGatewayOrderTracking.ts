import type { CommissionReport, Contract, Execution, IBApi } from "@stoqey/ib";
import type { Knex } from "knex";
import type { AppNotification } from "../lib/notificationChannel.js";
import { finalOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { ibkrInactiveOrderMessage, ibkrOrderCanceledErrorCode, ibkrOrderRejectionErrorCodes, requestStatusForIbkrRejection, requestStatusForOrderStatusEvent } from "./ibkrGatewayOrderStatus.js";
import { recordIbkrCancellationReason, recordIbkrOrderCanceled, workingOrderRequestStatuses, type ExecutedOutcome } from "./ibkrGatewayCancellationRecording.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

interface SourceOrderRequest {
  id: string;
  requestType: string;
  payload: Partial<OrderRequestPayload>;
}

/** The position_legs columns fill attribution reads. */
interface FillLegRow {
  id: string;
  position_id: string;
  side: "long" | "short";
  quantity: number;
}

/** Where an execution is written: an open leg, a leg the reconciliation already closed, or the buffer until its leg exists. */
type FillDestination = ({ kind: "open"; leg: FillLegRow } | { kind: "closed"; leg: FillLegRow } | { kind: "wait" }) & { assignedOptionLegIds?: string[] };
import { parseIbkrExecutionTime } from "./ibkrGatewayParseExecutionTime.js";
import type { fetchIbkrCompletedOrders } from "./ibkrGatewayFetchCompletedOrders.js";
import type { fetchIbkrOpenOrders } from "./ibkrGatewayFetchOpenOrders.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { exitFromClosingFills } from "../lib/partialCloseSlice.js";

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
  // A cancel's status and reason commit together, so nothing reading the row (the Telegram order notices) sees one without the other.
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

/**
 * A buffered opening fill asks for a reconciliation this long after the last one of its burst: a combo's legs arrive over a
 * second or two, and a pass that read the shares before the call would build a stock-only position first.
 */
export const openingFillReconciliationDelayMs = 3_000;

/** How long after the reconciliation closed a leg a fill still counts as that leg's (an assignment's, or any late closing fill). */
export const lateClosingFillWindowMs = 36 * 3_600_000;

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
  const pendingOpeningExecutions = new Map<string, { contract: Contract; execution: Execution; receivedAt: Date }[]>();
  const pendingCommissionsByExecId = new Map<string, number>();
  let openingFillReconciliationTimer: ReturnType<typeof setTimeout> | null = null;

  function requestReconciliationAfterOpeningFills(): void {
    if (openingFillReconciliationTimer) clearTimeout(openingFillReconciliationTimer);
    openingFillReconciliationTimer = setTimeout(() => {
      openingFillReconciliationTimer = null;
      dependencies.requestReconciliation();
    }, openingFillReconciliationDelayMs);
    openingFillReconciliationTimer.unref?.();
  }

  /** IBKR's own execution time; when it cannot be read, the moment the execution reached the worker (not when it was written). */
  function executedAtOf(execution: Execution, receivedAt: Date): Date {
    let parsed: Date | null = null;
    try {
      parsed = parseIbkrExecutionTime(execution.time);
    } catch {
      // An unknown zone name (RangeError): the trade row matters more than its exact second.
    }
    if (!parsed) console.warn(`Execution ${execution.execId}: IBKR time ${JSON.stringify(execution.time)} could not be read, recording the time it reached the worker.`);
    return parsed ?? receivedAt;
  }

  // Looked up by permId, not ibkr_order_id: ibkr_order_id resets and gets reused after every Gateway/worker restart, so
  // matching a trade to its requester by order id could attribute an old trade to whichever unrelated request later reused
  // that id. Null if the order was placed outside the app (no order_requests row), which is expected, not an error.
  async function loadSourceOrderRequest(execution: Execution): Promise<SourceOrderRequest | null> {
    if (!execution.permId) return null;
    const orderRequest = await db("order_requests").where({ ibkr_perm_id: execution.permId }).first("id", "request_type", "payload");
    if (!orderRequest) return null;
    const payload: Partial<OrderRequestPayload> = typeof orderRequest.payload === "string" ? JSON.parse(orderRequest.payload) : (orderRequest.payload ?? {});
    return { id: orderRequest.id, requestType: orderRequest.request_type, payload };
  }

  async function lookupSourceOrderRequestId(execution: Execution): Promise<string | null> {
    return (await loadSourceOrderRequest(execution))?.id ?? null;
  }

  // Shares bought by a covered-call order are that new position's own, even when another position already holds the same
  // stock: they belong with the call the same order sold, never with whichever open leg of the contract comes first.
  function isCoveredCallShareBuy(contract: Contract, execution: Execution, sourceOrder: SourceOrderRequest | null): boolean {
    return contract.secType === "STK" && execution.side === "BOT" && sourceOrder?.requestType === "open_covered_call";
  }

  /** Order request ids whose option fills sit on the position that owns this leg. */
  async function orderRequestIdsOfPositionOptionFills(legId: string): Promise<Set<string>> {
    const rows: { id: string }[] = await db("trades as tr")
      .join("position_legs as option_leg", "option_leg.id", "tr.position_leg_id")
      .join("position_legs as leg", "leg.position_id", "option_leg.position_id")
      .where({ "leg.id": legId, "option_leg.leg_type": "option" })
      .whereNotNull("tr.source_order_request_id")
      .distinct("tr.source_order_request_id as id");
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Where an execution goes. One stock contract can be open on several positions (Covered Calls on the same ticker), so the
   * conId alone is not enough:
   *   - a leg the order itself names (a close or a roll of a tracked leg) wins, even one the reconciliation just closed;
   *   - shares bought by a covered-call order go to the position holding that order's call, or wait for it;
   *   - an assignment (no app order, at a short option's strike) goes where assignmentDestination says;
   *   - anything else keeps the oldest open leg of the contract; with none open, a closing fill goes to the leg the
   *     reconciliation closed when IBKR's holding went (lateClosingFillWindowMs), and an opening fill waits for its leg.
   */
  async function destinationForExecution(conId: string, contract: Contract, execution: Execution, sourceOrder: SourceOrderRequest | null, receivedAt: Date): Promise<FillDestination> {
    const executedAt = executedAtOf(execution, receivedAt);
    const openLegs: FillLegRow[] = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").orderBy("entry_at", "asc").orderBy("id", "asc");
    const recentlyClosedLegs = (): Promise<FillLegRow[]> =>
      db("position_legs")
        .where({ ibkr_contract_id: conId, side: execution.side === "SLD" ? "long" : "short" })
        .whereNotNull("exit_at")
        .where("exit_at", ">=", new Date(executedAt.getTime() - lateClosingFillWindowMs))
        .whereNotExists(db("trades as closing").whereRaw("closing.position_leg_id = position_legs.id").where("closing.is_closing_trade", true))
        .orderBy("exit_at", "desc")
        .orderBy("id", "asc");

    const namedLegIds = new Set((sourceOrder?.payload.legs ?? []).map((leg) => leg.positionLegId).filter((id): id is string => typeof id === "string"));
    const namedOpenLeg = openLegs.find((leg) => namedLegIds.has(leg.id));
    if (namedOpenLeg) return { kind: "open", leg: namedOpenLeg };
    if (namedLegIds.size > 0) {
      const namedClosedLeg = (await recentlyClosedLegs()).find((leg) => namedLegIds.has(leg.id));
      if (namedClosedLeg) return { kind: "closed", leg: namedClosedLeg };
    }

    if (isCoveredCallShareBuy(contract, execution, sourceOrder)) {
      const callOwnerPositionId = await positionHoldingOrdersCall(sourceOrder!.id);
      const ownStockLeg = openLegs.find((leg) => leg.position_id === callOwnerPositionId);
      return ownStockLeg ? { kind: "open", leg: ownStockLeg } : { kind: "wait" };
    }
    if (!sourceOrder && contract.secType === "STK") {
      const assignment = await assignmentDestination(conId, openLegs, recentlyClosedLegs, execution, executedAt);
      if (assignment) return assignment;
    }
    if (openLegs.length > 0) return { kind: "open", leg: openLegs[0]! };
    const lateClosedLeg = (await recentlyClosedLegs())[0];
    return lateClosedLeg ? { kind: "closed", leg: lateClosedLeg } : { kind: "wait" };
  }

  /** The position holding the option leg an order's option fill went to, once that fill is recorded. */
  async function positionHoldingOrdersCall(orderRequestId: string): Promise<string | undefined> {
    const callOwner = await db("trades as tr")
      .join("position_legs as option_leg", "option_leg.id", "tr.position_leg_id")
      .where({ "tr.source_order_request_id": orderRequestId, "option_leg.leg_type": "option" })
      .first("option_leg.position_id as positionId");
    return callOwner?.positionId;
  }

  /**
   * An assignment's stock fill, told by its price: exactly the strike of a short option on the ticker with no closing
   * trade, still open or closed within lateClosingFillWindowMs (early assignments included: no expiry condition).
   *   - a call assigned (shares sold): the stock leg of the position holding that call, open or just closed;
   *   - a put assigned (shares bought): the ticker's leftover-stock position, or wait for the reconciliation to create it.
   *     Never a covered call's leg: those shares are the put's, and would blend into that position's own cost.
   * null when the fill is not an assignment, or no leg of the assigned call's position fits.
   */
  async function assignmentDestination(conId: string, openLegs: FillLegRow[], recentlyClosedLegs: () => Promise<FillLegRow[]>, execution: Execution, executedAt: Date): Promise<FillDestination | null> {
    if (execution.price === undefined || (execution.side !== "SLD" && execution.side !== "BOT")) return null;
    const tickerIds = db("positions").whereIn("id", db("position_legs").where({ ibkr_contract_id: conId }).select("position_id")).select("ticker_id");
    const assignedOptionLegs: { id: string; positionId: string }[] = await db("position_legs as pl")
      .join("positions as p", "p.id", "pl.position_id")
      .whereIn("p.ticker_id", tickerIds)
      .where({ "pl.leg_type": "option", "pl.side": "short", "pl.option_type": execution.side === "SLD" ? "call" : "put" })
      .whereRaw("abs(pl.strike_price - ?) < 0.00005", [execution.price])
      .andWhere((builder) => builder.whereNull("pl.exit_at").orWhere("pl.exit_at", ">=", new Date(executedAt.getTime() - lateClosingFillWindowMs)))
      .whereNotExists(db("trades as closing").whereRaw("closing.position_leg_id = pl.id").where("closing.is_closing_trade", true))
      .select("pl.id", "pl.position_id as positionId");
    if (assignedOptionLegs.length === 0) return null;
    const assignedPositionIds = new Set(assignedOptionLegs.map((leg) => leg.positionId));
    const assignedOptionLegIds = assignedOptionLegs.map((leg) => leg.id);

    if (execution.side === "SLD") {
      const openLeg = openLegs.find((leg) => assignedPositionIds.has(leg.position_id));
      if (openLeg) return { kind: "open", leg: openLeg, assignedOptionLegIds };
      const closedLeg = (await recentlyClosedLegs()).find((leg) => assignedPositionIds.has(leg.position_id));
      return closedLeg ? { kind: "closed", leg: closedLeg, assignedOptionLegIds } : null;
    }
    const leftoverPosition = openLegs.length === 0 ? undefined : await db("positions").whereIn("id", openLegs.map((leg) => leg.position_id)).where({ strategy_key: "unstructured" }).first("id");
    const leftoverLeg = openLegs.find((leg) => leg.position_id === leftoverPosition?.id);
    return leftoverLeg ? { kind: "open", leg: leftoverLeg, assignedOptionLegIds } : { kind: "wait", assignedOptionLegIds };
  }

  /**
   * An assigned option leg the reconciliation closed before the assignment's fill arrived (it vanished before its expiry
   * with no trade, so its exit was left unknown): the fill shows it was assigned, which ends a short option at 0.
   */
  async function settleAssignedOptionLegs(assignedOptionLegIds: string[] | undefined): Promise<void> {
    if (!assignedOptionLegIds || assignedOptionLegIds.length === 0) return;
    const settled = await db("position_legs").whereIn("id", assignedOptionLegIds).whereNotNull("exit_at").whereNull("exit_price").update({ exit_price: 0 });
    if (settled > 0) console.log(`Assignment fill: ${settled} assigned option leg(s) closed earlier without an exit now exit at 0.`);
  }

  /**
   * A closing fill for a leg the reconciliation already closed (IBKR's holding went before the execution arrived): recorded
   * as that leg's closing trade, and the leg's exit becomes its closing fills' average once they cover its quantity.
   */
  async function recordLateClosingFill(leg: FillLegRow, execution: Execution, receivedAt: Date): Promise<void> {
    await db("trades")
      .insert({
        position_leg_id: leg.id,
        ibkr_order_id: String(execution.orderId ?? ""),
        ibkr_exec_id: execution.execId,
        side: execution.side === "BOT" ? "buy" : "sell",
        quantity: execution.shares ?? 0,
        price: execution.price ?? 0,
        executed_at: executedAtOf(execution, receivedAt),
        is_closing_trade: true,
        source_order_request_id: await lookupSourceOrderRequestId(execution),
      })
      .onConflict("ibkr_exec_id")
      .ignore();
    await applyPendingCommission(execution.execId!);
    const closingQuantity = Number((await db("trades").where({ position_leg_id: leg.id, is_closing_trade: true }).sum({ total: "quantity" }).first())?.total ?? 0);
    const exit = closingQuantity >= Number(leg.quantity) ? await exitFromClosingFills(leg.id, db) : null;
    if (exit) await db("position_legs").where({ id: leg.id }).update({ exit_price: exit.exitPrice, exit_at: exit.exitAt });
    console.log(`Execution ${execution.execId}: closing fill for leg ${leg.id}, closed before it arrived${exit ? `; exit now ${exit.exitPrice}` : ""}.`);
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

  async function insertOpeningTradeRow(positionLegId: string, _contract: Contract, execution: Execution, receivedAt: Date): Promise<void> {
    if (!execution.execId) return;
    await db("trades")
      .insert({
        position_leg_id: positionLegId,
        ibkr_order_id: String(execution.orderId ?? ""),
        ibkr_exec_id: execution.execId,
        side: execution.side === "BOT" ? "buy" : "sell",
        quantity: execution.shares ?? 0,
        price: execution.price ?? 0,
        executed_at: executedAtOf(execution, receivedAt),
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
    // A combo also reports one execution for the combo itself; its legs arrive as their own executions, and no leg ever
    // carries the combo's conId, so it would wait in the buffer forever.
    if (contract.secType === "BAG") return;
    const receivedAt = new Date();
    if (dependencies.isAccountBindingMismatch()) {
      console.log(`Execution ${execution.execId} ignored: account binding mismatch.`);
      return;
    }

    const existing = await db("trades").where({ ibkr_exec_id: execution.execId }).first();
    if (existing) return;

    const conId = String(contract.conId);
    const destination = await destinationForExecution(conId, contract, execution, await loadSourceOrderRequest(execution), receivedAt);
    await settleAssignedOptionLegs(destination.assignedOptionLegIds);

    if (destination.kind === "closed") {
      await recordLateClosingFill(destination.leg, execution, receivedAt);
      dependencies.requestReconciliation();
      return;
    }
    if (destination.kind === "wait") {
      // A brand-new position-opening fill (or one placed outside the app entirely): the leg does not exist yet because the
      // position reconciliation has not run since this fill. Buffer it; the reconciliation drains the buffer once it
      // creates the leg. Shares a covered-call order bought wait here too while another position already holds the stock.
      const buffered = pendingOpeningExecutions.get(conId) ?? [];
      buffered.push({ contract, execution, receivedAt });
      pendingOpeningExecutions.set(conId, buffered);
      console.log(`Execution ${execution.execId} for conId ${conId} has no matching open leg yet — buffered for the next reconciliation pass.`);
      requestReconciliationAfterOpeningFills();
      return;
    }

    const leg = destination.leg;
    const isClosing = execution.side === "BOT" ? leg.side === "short" : leg.side === "long";
    if (!isClosing) {
      // An add-on fill to an already-tracked leg: not a close, but still a real execution the Trade Blotter should show.
      // The leg's own quantity is not updated here; the reconciliation does that, so trigger it now rather than waiting
      // for the periodic pass.
      await insertOpeningTradeRow(leg.id, contract, execution, receivedAt);
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
      executed_at: executedAtOf(execution, receivedAt),
      is_closing_trade: true,
      source_order_request_id: await lookupSourceOrderRequestId(execution),
    });
    await applyPendingCommission(execution.execId);

    dependencies.requestReconciliation();
  }

  /**
   * Called by the position reconciliation when it creates a leg: writes the opening fills that were waiting for it. Shares
   * a covered-call order bought stay buffered unless the new leg's position holds that order's call.
   */
  async function drainPendingOpeningExecutions(conId: string, newLegId: string): Promise<void> {
    const buffered = pendingOpeningExecutions.get(conId);
    if (!buffered) return;
    pendingOpeningExecutions.delete(conId);
    let ownOrderRequestIds: Set<string> | null = null;
    const stillWaiting: typeof buffered = [];
    for (const entry of buffered) {
      const sourceOrder = await loadSourceOrderRequest(entry.execution);
      if (isCoveredCallShareBuy(entry.contract, entry.execution, sourceOrder)) {
        ownOrderRequestIds ??= await orderRequestIdsOfPositionOptionFills(newLegId);
        if (!ownOrderRequestIds.has(sourceOrder!.id)) {
          stillWaiting.push(entry);
          continue;
        }
      }
      await insertOpeningTradeRow(newLegId, entry.contract, entry.execution, entry.receivedAt);
    }
    if (stillWaiting.length > 0) pendingOpeningExecutions.set(conId, stillWaiting);
  }

  /**
   * Shares a covered-call order bought that are still waiting while the position holding the order's call already has its
   * stock leg: an add-on to an existing Covered Call creates no new leg to drain onto, and its call fill may have been
   * recorded after the shares'. Called by the position reconciliation at the start of each pass.
   */
  async function attributeWaitingCoveredCallShareBuys(): Promise<void> {
    for (const [conId, buffered] of [...pendingOpeningExecutions]) {
      const stillWaiting: typeof buffered = [];
      for (const entry of buffered) {
        const sourceOrder = await loadSourceOrderRequest(entry.execution);
        const callOwnerPositionId = isCoveredCallShareBuy(entry.contract, entry.execution, sourceOrder) ? await positionHoldingOrdersCall(sourceOrder!.id) : undefined;
        const ownStockLeg = callOwnerPositionId === undefined ? undefined : await db("position_legs").where({ ibkr_contract_id: conId, position_id: callOwnerPositionId }).whereNull("exit_at").first("id");
        if (!ownStockLeg) {
          stillWaiting.push(entry);
          continue;
        }
        await insertOpeningTradeRow(ownStockLeg.id, entry.contract, entry.execution, entry.receivedAt);
        console.log(`Execution ${entry.execution.execId}: shares of a covered-call order written to stock leg ${ownStockLeg.id} of the position holding its call.`);
      }
      if (stillWaiting.length > 0) pendingOpeningExecutions.set(conId, stillWaiting);
      else pendingOpeningExecutions.delete(conId);
    }
  }

  return {
    recordExecution,
    recordCommission,
    drainPendingOpeningExecutions,
    attributeWaitingCoveredCallShareBuys,
    bufferedOpeningExecutionCount: (conId: string) => pendingOpeningExecutions.get(conId)?.length ?? 0,
    pendingCommissionCount: () => pendingCommissionsByExecId.size,
  };
}
