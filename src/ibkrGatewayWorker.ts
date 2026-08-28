import "dotenv/config";
import { Client as PgClient } from "pg";
import { EventName, OptionType, OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { Contract, ComboLeg, Execution, Order as IbkrOrder } from "@stoqey/ib";
import { db } from "./db/connection.js";
import { environment } from "./config/env.js";
import { persistentIbkrConnection } from "./ibkr/ibkrGatewayPersistentConnection.js";
import { resolveContractId } from "./ibkr/ibkrGatewayResolveContractId.js";
import { buildLegContract, computeNetLimitPrice, type OrderLegPayload, type OrderRequestPayload } from "./ibkr/ibkrGatewayOrderPayload.js";
import { parseIbkrExecutionTime } from "./ibkr/ibkrGatewayParseExecutionTime.js";
import { fetchIbkrHeldPositions, type IbkrHeldPosition } from "./ibkr/ibkrGatewayFetchHeldPositions.js";
import { fetchIbkrOpenOrders } from "./ibkr/ibkrGatewayFetchOpenOrders.js";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { fetchPositionById, type PositionLegRow } from "./lib/positionQueries.js";
import { formatPositionExpiredMessage } from "./lib/formatPositionExpiredMessage.js";
import { notifyTelegram } from "./lib/notifyTelegram.js";
import { revertSourceAlertToPending } from "./lib/revertSourceAlertToPending.js";
import { publishNotification } from "./lib/notificationChannel.js";

installCrashHandlers("worker");

/**
 * The persistent worker process — see PROGRESS.md's "IBKR is the source of
 * truth" decision (2026-08-24) and the plan at
 * ~/.claude/plans/purring-tumbling-lemur.md for the full design.
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

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
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
  if (!ib) return;

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
  if (!ib) return;

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "confirmed" }).first();
  if (!orderRequest) return; // already processed, cancelled, or not actually confirmed

  const payload = orderRequest.payload as OrderRequestPayload;
  try {
    const built = await buildOrder(payload);
    if (!built) {
      await db("order_requests")
        .where({ id: orderRequestId })
        .update({ status: "error", error_message: "Could not resolve one or more contract ids.", updated_at: db.fn.now() });
      return;
    }

    const ibkrOrderId = persistentIbkrConnection.getNextOrderId();
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "submitted", ibkr_order_id: ibkrOrderId, updated_at: db.fn.now() });

    ib.placeOrder(ibkrOrderId, built.contract, built.order);
  } catch (error) {
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: db.fn.now(),
      });
  }
}

/**
 * The web dyno NOTIFYs the same channel for both a fresh confirm and a
 * cancel request, distinguished by the row's current status — dispatches to
 * whichever this row actually needs.
 */
async function handleOrderRequestNotification(orderRequestId: string, knownStatus?: string): Promise<void> {
  const status = knownStatus ?? (await db("order_requests").where({ id: orderRequestId }).first())?.status;
  if (status === "cancel_requested") {
    await processCancelRequest(orderRequestId);
  } else {
    await processOrderRequest(orderRequestId);
  }
}

/** Postgres LISTEN/NOTIFY — the web dyno NOTIFYs this channel with the order_requests.id on confirm. */
async function listenForOrderRequests(): Promise<void> {
  const client = new PgClient({
    connectionString: environment.databaseUrl,
    ssl: environment.nodeEnvironment === "production" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  await client.query(`LISTEN ${orderRequestsChannel}`);
  client.on("notification", (message) => {
    if (message.channel !== orderRequestsChannel || !message.payload) return;
    handleOrderRequestNotification(message.payload).catch((error) => console.error(`Order request processing failed: ${error}`));
  });
  client.on("error", (error) => console.error(`order_requests LISTEN connection error: ${error.message}`));

  // A missed NOTIFY (e.g. a reconnect window) shouldn't leave a confirmed
  // order, or a cancel request, stuck forever — this short poll is the
  // fallback safety net for both.
  setInterval(async () => {
    const stuck = await db("order_requests").whereIn("status", ["confirmed", "cancel_requested"]).select("id", "status");
    for (const row of stuck) await handleOrderRequestNotification(row.id, row.status);
  }, 30_000);
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
    db("order_requests")
      .where({ ibkr_order_id: orderId })
      .whereNotIn("status", finalOrderRequestStatuses)
      .andWhere((builder) => (permId ? builder.whereNull("ibkr_perm_id").orWhere("ibkr_perm_id", permId) : builder))
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
    })
    .onConflict("ibkr_exec_id")
    .ignore();
}

/**
 * Idempotent by construction — trades.ibkr_exec_id is UNIQUE, and each
 * partial fill has its own distinct execId (see @stoqey/ib's Execution type
 * doc comment), so re-processing the same execDetails event (e.g. after a
 * reconnect) is safe: the insert is a no-op on conflict.
 */
async function recordExecution(contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId || !contract.conId) return;

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
  });

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

async function reconcilePositionsFromIbkr(): Promise<void> {
  if (reconciliationInFlight) {
    reconciliationRerunQueued = true;
    return;
  }
  reconciliationInFlight = true;
  try {
    await runReconciliationPass();
  } finally {
    reconciliationInFlight = false;
    if (reconciliationRerunQueued) {
      reconciliationRerunQueued = false;
      reconcilePositionsFromIbkr().catch((error) => console.error(`Queued reconciliation rerun failed: ${error}`));
    }
  }
}

/**
 * Pulls IBKR's actual current holdings and reconciles them into
 * positions/position_legs — the core of "the interface matches IBKR
 * exactly." Pairing heuristic (approved 2026-08-24, revised 2026-08-25,
 * 2026-08-27): group by underlying symbol. Each distinct short call
 * contract (its own conId — a different strike/expiry is a different
 * contract) pairs with its own proportional slice of the stock (quantity *
 * 100) into its own covered_call position — every position opened through
 * this app is exactly 1 option + 100 shares/contract, so multiple short
 * calls on one symbol are always separate bets, never one blended position
 * (see PROGRESS.md, prompted by a real MU position that had wrongly merged
 * two different strikes under the old symbol-only grouping).
 *
 * Short puts are handled unconditionally, independent of any covered-call
 * pairing on the same symbol — a covered call and a cash-secured put can
 * legitimately coexist on one underlying (e.g. a wheel), and a put must
 * never be silently stranded when its sibling stock/call legs get split off
 * into their own covered_call position by upsertSplitCoveredCallPosition
 * below. Real bug found 2026-08-27 on a real prod AAOI position: after a
 * covered call was rolled, the old shared position kept the still-open
 * short put but was left permanently mislabeled "unstructured" because the
 * put was never revisited once the call/stock pairing claimed the
 * isCoveredCall branch for that symbol.
 *
 * Anything left over that isn't a short put and doesn't cleanly pair as a
 * covered call (including any stock beyond what the sold calls need — see
 * upsertLeftoverStockPosition) is surfaced as strategy_key "unstructured"
 * rather than hidden.
 */
async function logPlatformAnomaly(
  anomalyType: string,
  detail: string,
  ids: { positionId?: string; orderRequestId?: string } = {},
): Promise<void> {
  await db("platform_anomalies").insert({
    anomaly_type: anomalyType,
    position_id: ids.positionId ?? null,
    order_request_id: ids.orderRequestId ?? null,
    detail,
  });
}

// Stock-only leftover (no calls sold against it at all) traces back to
// exactly one of two known causes: a covered call's short call expired
// worthless (its own close_reason already recorded that), or a
// cash-secured put got assigned (same). Looked up by the most recently
// closed covered_call/cash_secured_put position on this ticker — if
// neither matches, this is a genuinely unexplained appearance of stock and
// gets logged as a platform anomaly rather than silently labeled.
async function determineLeftoverStockReason(symbol: string): Promise<string> {
  const ticker = await db("tickers").where({ symbol }).first();
  if (!ticker) return "unknown";

  const recentClosed = await db("positions")
    .where({ ticker_id: ticker.id })
    .whereIn("strategy_key", ["covered_call", "cash_secured_put"])
    .whereNotNull("closed_at")
    .orderBy("closed_at", "desc")
    .first();

  if (recentClosed?.strategy_key === "covered_call" && recentClosed.close_reason === "expired_worthless") {
    return "cc_expired_leftover_stock";
  }
  if (recentClosed?.strategy_key === "cash_secured_put" && recentClosed.close_reason === "assigned") {
    return "csp_assigned_stock";
  }
  return "unknown";
}

// Determines why a position closed, for the events feed and for
// notifyPositionExpired — computed once here instead of re-derived by
// every future reader. "assigned" reuses the exact heuristics already
// proven out in this file's history: a covered call is assigned iff its
// stock leg's exit_price got set by a real trade; a cash-secured put is
// assigned iff a fresh stock leg for the same ticker appeared within the
// last 5 minutes (the only way shares show up for a strategy with no stock
// leg of its own).
async function determineCloseReason(positionId: string): Promise<string> {
  const position = await fetchPositionById(positionId);
  if (!position) return "unknown";

  const stockLeg = position.legs.find((leg: PositionLegRow) => leg.legType === "stock");
  if (position.strategyKey === "covered_call") {
    if (stockLeg && stockLeg.exitPrice !== null) return "assigned";
  } else if (position.strategyKey === "cash_secured_put") {
    const ticker = await db("tickers").where({ symbol: position.symbol }).first();
    const recentStockLeg = ticker
      ? await db("position_legs as pl")
          .join("positions as p", "p.id", "pl.position_id")
          .where({ "p.ticker_id": ticker.id, "pl.leg_type": "stock" })
          .andWhere("pl.entry_at", ">=", db.raw("now() - interval '5 minutes'"))
          .first()
      : undefined;
    if (recentStockLeg) return "assigned";
  }

  const closingTrade = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .where({ "pl.position_id": positionId, "t.is_closing_trade": true })
    .first();
  if (closingTrade) {
    const orderRequest = await db("order_requests").where({ related_position_id: positionId, status: "filled" }).first();
    return orderRequest ? "closed_via_app" : "closed_via_external_trade";
  }

  const hasExpiredOptionLeg = position.legs.some(
    (leg: PositionLegRow) => leg.legType === "option" && leg.exitAt !== null,
  );
  if (hasExpiredOptionLeg) return "expired_worthless";

  return "unknown";
}

async function runReconciliationPass(): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const held = await fetchIbkrHeldPositions(ib);

  const bySymbol = new Map<string, IbkrHeldPosition[]>();
  for (const position of held) {
    const symbol = position.contract.symbol ?? "UNKNOWN";
    const existing = bySymbol.get(symbol) ?? [];
    existing.push(position);
    bySymbol.set(symbol, existing);
  }

  for (const [symbol, positionsForSymbol] of bySymbol) {
    const stockLeg = positionsForSymbol.find((p) => p.contract.secType === SecType.STK && p.quantity > 0);
    const shortCallLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Call && p.quantity < 0,
    );
    const shortPutLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Put && p.quantity < 0,
    );

    if (shortPutLegs.length > 0) {
      await upsertSyncedPosition(
        symbol,
        "cash_secured_put",
        shortPutLegs.map((leg) => ({ held: leg, side: "short" as const })),
      );
    }

    const totalShortCallShares = shortCallLegs.reduce((sum, leg) => sum + Math.abs(leg.quantity) * 100, 0);
    const isCoveredCall = stockLeg && shortCallLegs.length > 0 && totalShortCallShares <= stockLeg.quantity;

    if (isCoveredCall) {
      // Sorted for a stable, deterministic split across reconciliation runs
      // (every 60s) -- otherwise which conId's stock slice goes where could
      // reshuffle from one pass to the next with no real change underneath.
      const sortedCallLegs = [...shortCallLegs].sort((a, b) => (a.contract.conId ?? 0) - (b.contract.conId ?? 0));
      for (const callLeg of sortedCallLegs) {
        await upsertSplitCoveredCallPosition(symbol, stockLeg, callLeg, Math.abs(callLeg.quantity) * 100);
      }
      // Should never happen -- every position this app opens is exactly 1
      // option + 100 shares/contract, so leftover stock beyond what the
      // sold calls need means something went wrong (a bug, or a manual
      // trade outside the app). Surfaced as its own flagged position
      // rather than silently absorbed into one of the covered calls above.
      await upsertLeftoverStockPosition(symbol, stockLeg, stockLeg.quantity - totalShortCallShares);
    } else {
      const nonPutLegs = positionsForSymbol.filter((p) => !shortPutLegs.includes(p));
      if (nonPutLegs.length > 0) {
        // Doesn't cleanly pair — surfaced, not hidden (approved 2026-08-24).
        // Stock-only leftover has two known causes (see
        // determineLeftoverStockReason); any short call present alongside it
        // is a naked/uncovered call, which nothing in this app should ever
        // produce — always an unknown-cause anomaly.
        const hasCallLeg = nonPutLegs.some((p) => p.contract.secType === SecType.OPT);
        const reason = hasCallLeg ? "unknown" : await determineLeftoverStockReason(symbol);
        await upsertSyncedPosition(
          symbol,
          "unstructured",
          nonPutLegs.map((leg) => ({ held: leg, side: leg.quantity > 0 ? ("long" as const) : ("short" as const) })),
          reason,
        );
        if (reason === "unknown") {
          await logPlatformAnomaly(
            hasCallLeg ? "naked_call_detected" : "unexplained_leftover_stock",
            `${symbol}: reconciliation flagged unstructured with no known cause`,
          );
        }
      }
    }
  }

  // Anything tracked as open in our DB but no longer reported by IBKR at
  // all — this is the sole place a leg is ever marked closed (see
  // recordExecution above for why a single closing execution can't decide
  // this on its own: a partial close previously flipped an entire
  // multi-lot leg to closed and hid the still-open remainder). exit_price
  // comes from the most recent closing trade already recorded for this
  // leg by recordExecution, if any.
  //
  // An option leg past its own expiry with no closing trade is the
  // "expired worthless" (or exercised/assigned, which also never generates
  // a trade for the option side itself) case, not an unknown close — bug
  // found 2026-08-27: this used to fall back to exit_price=null here too,
  // which silently dropped the leg out of realizedPnl's SUM (it requires
  // exit_price IS NOT NULL) and reported $0 P&L for every expired short
  // option instead of the full premium collected. Only a genuinely
  // ambiguous close (no trade, not past expiry — e.g. closed directly in
  // TWS, or before this worker was deployed) still falls back to null.
  const heldConIds = new Set(held.map((p) => p.contract.conId).filter((id): id is number => id !== undefined));
  const openLegs = await db("position_legs")
    .whereNull("exit_at")
    .whereNotNull("ibkr_contract_id")
    .select("*", db.raw("(leg_type = 'option' AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE) AS is_expired_option"));

  const positionIdsWithExpiredLeg = new Set<string>();
  for (const leg of openLegs) {
    if (heldConIds.has(Number(leg.ibkr_contract_id))) continue;

    const lastClosingTrade = await db("trades")
      .where({ position_leg_id: leg.id, is_closing_trade: true })
      .orderBy("executed_at", "desc")
      .first();

    const expiredWithoutTrade = !lastClosingTrade && leg.is_expired_option;
    if (expiredWithoutTrade) positionIdsWithExpiredLeg.add(leg.position_id);

    await db("position_legs")
      .where({ id: leg.id })
      .update({
        exit_price: lastClosingTrade?.price ?? (expiredWithoutTrade ? 0 : null),
        exit_at: lastClosingTrade?.executed_at ?? db.fn.now(),
      });

    const remainingOpenLegs = await db("position_legs").where({ position_id: leg.position_id }).whereNull("exit_at");
    if (remainingOpenLegs.length === 0) {
      await db("positions").where({ id: leg.position_id }).update({ status: "closed", closed_at: db.fn.now() });
      const closeReason = await determineCloseReason(leg.position_id);
      await db("positions").where({ id: leg.position_id }).update({ close_reason: closeReason });
      if (closeReason === "unknown" || closeReason === "closed_via_external_trade") {
        await logPlatformAnomaly(
          closeReason === "unknown" ? "unexplained_position_close" : "position_closed_outside_app",
          `Position ${leg.position_id} closed with reason "${closeReason}"`,
          { positionId: leg.position_id },
        );
      }
      if (positionIdsWithExpiredLeg.has(leg.position_id)) {
        await notifyPositionExpired(leg.position_id, closeReason).catch((error) =>
          console.error(`Expiry notification failed for position ${leg.position_id}: ${error}`),
        );
      }
    }
  }
}

// Fires only for a position that closed via reconcilePositionsFromIbkr's
// "option past expiry, no closing trade" path above — a manual close
// through the app already has its own confirmation UI (and its own
// "Filled" order toast), so it doesn't need a Telegram ping or a second
// toast too. Sends both the Telegram message and the in-app toast
// notification (routes/notifications.ts's SSE stream) off the same
// message text, so they never drift apart.
async function notifyPositionExpired(positionId: string, closeReason: string): Promise<void> {
  const position = await fetchPositionById(positionId);
  if (!position) return;
  if (position.strategyKey !== "covered_call" && position.strategyKey !== "cash_secured_put") return;

  const realizedPnl = Number(position.realizedPnl);
  const capitalAtRisk = position.capitalAtRisk === null ? null : Number(position.capitalAtRisk);
  const realizedPnlPercent = capitalAtRisk && capitalAtRisk !== 0 ? (realizedPnl / capitalAtRisk) * 100 : null;
  const assigned = closeReason === "assigned";

  const message = formatPositionExpiredMessage({
    symbol: position.symbol,
    strategyKey: position.strategyKey as "covered_call" | "cash_secured_put",
    legs: position.legs.map((leg: PositionLegRow) => ({
      legType: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice === null ? null : Number(leg.strikePrice),
    })),
    realizedPnl,
    realizedPnlPercent,
    assigned,
  });
  await notifyTelegram(message);
  await publishNotification({ type: "position_closed", positionId: position.id, symbol: position.symbol, message });
}

/**
 * Fills in trade_alerts.resulting_position_id for a brand-new position
 * (known gap flagged 2026-08-24: a `roll` already knows related_position_id
 * at confirm time, but a new_trade alert's position doesn't exist until
 * this reconciliation pass creates it — nothing wrote the link back until
 * now). Matches on symbol + still-unlinked alert rather than a contract id,
 * since the order_requests payload for a brand-new open never has a conId
 * (it isn't resolved until the worker places the order) — safe because this
 * only matches request_types that never set related_position_id (an
 * open_covered_call/open_cash_secured_put, never a roll/close), and only
 * order_requests that came from a trade alert in the first place (a
 * manually-entered new position has no source_alert_id, so nothing to link).
 */
async function backfillAlertResultingPositionId(symbol: string, positionId: string): Promise<void> {
  const orderRequest = await db("order_requests as orq")
    .join("trade_alerts as ta", "ta.id", "orq.source_alert_id")
    .whereIn("orq.request_type", ["open_covered_call", "open_cash_secured_put"])
    .whereIn("orq.status", ["filled", "partially_filled"])
    .whereRaw("orq.payload->>'symbol' = ?", [symbol])
    .whereNull("ta.resulting_position_id")
    .orderBy("orq.created_at", "asc")
    .first({ alertId: "ta.id" });
  if (!orderRequest) return;

  await db("trade_alerts").where({ id: orderRequest.alertId }).update({ resulting_position_id: positionId });
}

// Insert-or-update for a single position_legs row against one IBKR-held
// contract. Shared by upsertSyncedPosition (CSP / unstructured-fallback —
// looks up an existing leg by conId alone, which stays safe there since
// those paths never split one conId across multiple positions) and
// upsertSplitCoveredCallPosition/upsertLeftoverStockPosition below (which
// pass scopeLookupToPosition=true, since a covered call's *stock* conId can
// now be shared across several sibling positions and needs position_id in
// the lookup to disambiguate which slice belongs to which).
async function upsertPositionLeg(
  positionId: string,
  held: IbkrHeldPosition,
  side: "long" | "short",
  quantityOverride?: number,
  scopeLookupToPosition = false,
): Promise<void> {
  const conId = String(held.contract.conId);
  const contract = held.contract;
  // avgCost from IBKR's `position` event: for stock, cost per share; for
  // options, per @stoqey/ib's convention this already includes the
  // multiplier (total $ per contract, not per-share) — NEEDS VERIFICATION
  // against a real paper position before this is trusted (plan doc's
  // verification step 3). Flagging rather than asserting confidently.
  // `||`, not `??` — IBKR reports a stock contract's multiplier as "" (see
  // the comment a few lines below), and while that's been confirmed for
  // stock legs specifically, this codebase has hit the same "empty string,
  // not undefined" shape from IBKR for enough different fields (strike,
  // expiry, multiplier) that an option leg reporting "" here too can't be
  // ruled out — `?? 100` wouldn't catch it (`"" ?? 100` is `""`, not 100),
  // silently producing `avgCost / 0` = Infinity.
  const entryPrice = contract.secType === SecType.STK ? held.avgCost : held.avgCost / (contract.multiplier || 100);
  const trueQuantity = quantityOverride ?? Math.abs(held.quantity);

  const lookupQuery = db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at");
  if (scopeLookupToPosition) lookupQuery.where({ position_id: positionId });
  const existing = await lookupQuery.first();

  if (existing) {
    // Sync to IBKR's current truth on every pass, not just at creation.
    // Real bug found 2026-08-25 on a real MU position: two separate
    // 100-share opening orders for the same contract, 5 min apart, left
    // `quantity` stuck at 100 (whatever it was when this leg was first
    // created) even though `trades` correctly recorded both fills.
    // IBKR's `position` event always reports the CURRENT total holding +
    // blended average cost for this conId, never an increment, so it's
    // always safe to overwrite while the leg is still open.
    if (Number(existing.quantity) !== trueQuantity || Number(existing.entry_price) !== entryPrice) {
      await db("position_legs").where({ id: existing.id }).update({ quantity: trueQuantity, entry_price: entryPrice });
    }
    return;
  }

  const [newLeg] = await db("position_legs")
    .insert({
      position_id: positionId,
      leg_type: contract.secType === SecType.STK ? "stock" : "option",
      side,
      quantity: trueQuantity,
      option_type: contract.right === OptionType.Call ? "call" : contract.right === OptionType.Put ? "put" : null,
      // Same story as expiry_date below: IBKR reports strike as 0 (not
      // undefined) for a stock contract, and 0 ?? null still evaluates to 0
      // — stored as a truthy string ("0.0000") by the time it round-trips
      // through Postgres, which could mislead any caller checking
      // `if (leg.strikePrice)` to assume this stock leg is an option.
      strike_price: contract.secType === SecType.STK ? null : (contract.strike ?? null),
      // A stock leg's contract has no expiry — IBKR reports it as "", not
      // undefined/null, for that field. `??` doesn't catch an empty string
      // (same recurring bug class as reqContractDetails elsewhere in this
      // codebase, see PROGRESS.md) — the Postgres `date` column rejected it
      // outright and crashed reconciliation mid-loop before any legs (or
      // subsequent positions in the same pass) could be written.
      expiry_date: contract.lastTradeDateOrContractMonth || null,
      // Third instance of the same bug: IBKR reports a stock contract's
      // multiplier as "" (falsy but not nullish), not the conceptually
      // correct 1 — found 2026-08-24 when it silently zeroed out a real
      // stock leg's entire contribution to unrealized P&L (positions.ts's
      // formula multiplies every leg's price move by leg.multiplier).
      multiplier: contract.secType === SecType.STK ? 1 : (contract.multiplier ?? 1),
      ibkr_contract_id: conId,
      entry_price: entryPrice,
      entry_at: db.fn.now(),
    })
    .returning(["id"]);

  // Drain any opening execution(s) recordExecution buffered before this
  // leg existed (see pendingOpeningExecutions) — one trades row per real
  // fill, not a single synthesized one, so partial fills still show
  // individually in the Trade Blotter. Note: if two sibling covered-call
  // positions both create their stock leg from the same never-before-seen
  // conId in the same pass, whichever runs first drains the whole buffer —
  // an extremely unlikely race (this app only ever opens 1 option + 100
  // shares at a time; splitting only matters for pre-existing multi-strike
  // data), not fully solved here.
  const buffered = pendingOpeningExecutions.get(conId);
  if (buffered) {
    pendingOpeningExecutions.delete(conId);
    for (const { contract: bufferedContract, execution } of buffered) {
      await insertOpeningTradeRow(newLeg!.id, bufferedContract, execution);
    }
  }
}

async function upsertSyncedPosition(
  symbol: string,
  strategyKey: string,
  legs: { held: IbkrHeldPosition; side: "long" | "short" }[],
  unstructuredReason: string | null = null,
): Promise<void> {
  const conIds = legs.map((leg) => String(leg.held.contract.conId));
  const existingLegs = await db("position_legs").whereIn("ibkr_contract_id", conIds).whereNull("exit_at");

  let positionId = existingLegs[0]?.position_id as string | undefined;
  if (!positionId) {
    let ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcilePositionsFromIbkr: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: strategyKey, ticker_id: ticker.id, status: "open", unstructured_reason: unstructuredReason })
      .returning(["id"]);
    positionId = newPosition.id;
  } else {
    await db("positions").where({ id: positionId }).update({ strategy_key: strategyKey, unstructured_reason: unstructuredReason });
  }
  // Retried on every pass, not just at creation (found 2026-08-28): a real
  // race with the order's own fill-status callback — reconciliation can
  // detect and create the position from IBKR's held-positions report before
  // that order's order_requests row has actually flipped to "filled", so a
  // creation-time-only call sometimes found nothing to link and never got
  // a second chance. Safe to call repeatedly — the query only ever matches
  // an alert with resulting_position_id still NULL.
  await backfillAlertResultingPositionId(symbol, positionId!);

  for (const leg of legs) {
    await upsertPositionLeg(positionId!, leg.held, leg.side);
  }
}

// One covered-call position per distinct short call contract (added
// 2026-08-25 — see runReconciliationPass's header comment for why). Found
// via the call leg's own conId, which is always globally unique to exactly
// one position under this design — unlike the stock leg's conId, which can
// now be shared across several sibling positions and needs
// scopeLookupToPosition=true to disambiguate.
async function upsertSplitCoveredCallPosition(
  symbol: string,
  stockLeg: IbkrHeldPosition,
  callLeg: IbkrHeldPosition,
  sharesForThisLeg: number,
): Promise<void> {
  const callConId = String(callLeg.contract.conId);
  const existingCallLeg = await db("position_legs").where({ ibkr_contract_id: callConId }).whereNull("exit_at").first();

  let positionId = existingCallLeg?.position_id as string | undefined;

  // One-time migration for pre-existing merged positions (the exact MU bug
  // this fix is for): if this call leg's position still has ANOTHER open
  // option leg on it (a different conId), the old symbol-only grouping
  // bundled two distinct covered calls together — split this leg out into
  // its own new position rather than reusing the shared one. Re-checked
  // fresh on every call so processing each sibling call leg in turn
  // (runReconciliationPass's sorted loop) correctly peels them apart one at
  // a time instead of only fixing the first.
  if (positionId) {
    const siblingOptionLegs = await db("position_legs")
      .where({ position_id: positionId, leg_type: "option" })
      .whereNot({ ibkr_contract_id: callConId })
      .whereNull("exit_at");
    if (siblingOptionLegs.length > 0) {
      const oldPosition = await db("positions").where({ id: positionId }).first();
      const [newPosition] = await db("positions")
        .insert({ strategy_key: "covered_call", ticker_id: oldPosition!.ticker_id, status: "open" })
        .returning(["id"]);
      await db("position_legs").where({ id: existingCallLeg!.id }).update({ position_id: newPosition.id });
      positionId = newPosition.id;
    }
  }

  if (!positionId) {
    const ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcilePositionsFromIbkr: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "covered_call", ticker_id: ticker.id, status: "open" })
      .returning(["id"]);
    positionId = newPosition.id;
  } else {
    await db("positions").where({ id: positionId }).update({ strategy_key: "covered_call" });
  }
  // Retried on every pass, not just at creation — see upsertSyncedPosition's
  // matching comment for why (2026-08-28).
  await backfillAlertResultingPositionId(symbol, positionId!);

  await upsertPositionLeg(positionId!, callLeg, "short");
  await upsertPositionLeg(positionId!, stockLeg, "long", sharesForThisLeg, true);
}

// Stock beyond what the sold calls for this symbol actually need — should
// never happen (every position this app opens is exactly 1 option + 100
// shares/contract, in lockstep), so this is a data-integrity anomaly, not a
// normal state, and is deliberately kept as its own always-flagged
// "unstructured" position (renders with the existing "Needs Review" badge)
// rather than silently folded into one of the covered-call positions above.
// Matched structurally (this ticker's unstructured stock-only leg), not by
// ibkr_contract_id — the stock's conId is shared with every split
// covered-call position for this symbol too, so a bare conId lookup can't
// tell this one apart from those.
async function upsertLeftoverStockPosition(symbol: string, stockLeg: IbkrHeldPosition, leftoverShares: number): Promise<void> {
  const ticker = await db("tickers").where({ symbol }).first();
  if (!ticker) return;

  const existingLeftoverLeg = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": ticker.id, "p.strategy_key": "unstructured", "pl.leg_type": "stock" })
    .whereNull("pl.exit_at")
    .select("pl.*")
    .first();

  if (leftoverShares <= 0) {
    // Any shortfall has resolved (e.g. another call got sold against it) —
    // close out a previously-flagged leftover leg rather than leaving a
    // stale warning position visible.
    if (existingLeftoverLeg) {
      await db("position_legs").where({ id: existingLeftoverLeg.id }).update({ exit_at: db.fn.now() });
      const remaining = await db("position_legs").where({ position_id: existingLeftoverLeg.position_id }).whereNull("exit_at");
      if (remaining.length === 0) {
        await db("positions").where({ id: existingLeftoverLeg.position_id }).update({ status: "closed", closed_at: db.fn.now() });
      }
    }
    return;
  }

  let positionId = existingLeftoverLeg?.position_id as string | undefined;
  if (!positionId) {
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "open" })
      .returning(["id"]);
    positionId = newPosition.id;
  }
  await upsertPositionLeg(positionId!, stockLeg, "long", leftoverShares, true);
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
async function reconcileStaleOrderRequests(): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const staleCandidates = await db("order_requests")
    .whereIn("status", ["submitted", "partially_filled", "cancel_requested"])
    .whereNotNull("ibkr_order_id")
    .select("id", "ibkr_order_id", "source_alert_id");
  if (staleCandidates.length === 0) return;

  const openOrders = await fetchIbkrOpenOrders(ib);
  const liveOrderIds = new Set(openOrders.map((order) => order.orderId));

  for (const row of staleCandidates) {
    if (liveOrderIds.has(row.ibkr_order_id)) continue;
    await db("order_requests")
      .where({ id: row.id })
      .update({
        status: "error",
        error_message:
          "IBKR no longer reports this order as open (likely orphaned by a Gateway/worker restart) — its real status could not be confirmed. Check IBKR directly if this was a real order.",
        ibkr_order_id: null,
        updated_at: db.fn.now(),
      });
    console.warn(`reconcileStaleOrderRequests: flagged orphaned order_requests row ${row.id} (was ibkr_order_id ${row.ibkr_order_id}).`);
    await publishNotification({ type: "order_status", orderId: row.id });
    await revertSourceAlertToPending(row.source_alert_id);
  }
}

async function main(): Promise<void> {
  await persistentIbkrConnection.start();
  await reconcileStaleOrderRequests().catch((error) => console.error(`Initial stale-order reconciliation failed: ${error}`));
  persistentIbkrConnection.onConnect(() => {
    setupOrderTrackingListeners();
    reconcileStaleOrderRequests().catch((error) => console.error(`Stale-order reconciliation failed: ${error}`));
    reconcilePositionsFromIbkr().catch((error) => console.error(`Initial reconciliation failed: ${error}`));
  });

  await listenForOrderRequests();

  setInterval(() => {
    reconcilePositionsFromIbkr().catch((error) => console.error(`Periodic reconciliation failed: ${error}`));
  }, reconciliationIntervalMs);

  console.log("Iorio worker started — persistent IBKR connection, order placement, position sync.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
