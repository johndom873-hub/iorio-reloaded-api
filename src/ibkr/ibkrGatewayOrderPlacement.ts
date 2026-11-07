import { OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { ComboLeg, Contract, IBApi, Order as IbkrOrder } from "@stoqey/ib";
import type { Knex } from "knex";
import type { AccountBinding } from "../lib/accountBinding.js";
import type { PulseEdgeId } from "../lib/notificationChannel.js";
import type { PlacementBlock } from "../lib/orderPlacementEnforcement.js";
import type { StoredGateEvaluation } from "../lib/orderPlacementGuard.js";
import type { LimitPriceBlock } from "./ibkrGatewayLimitPriceCheck.js";
import { buildContractFromConId, buildLegContract, computeNetLimitPrice, type AdaptivePriority, type OrderLegPayload, type OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";
import type { RecentLimitPriceChanges } from "./ibkrGatewayRecentLimitPriceChanges.js";
import { limitChangeableOrderStatuses } from "../lib/orderRequestStatuses.js";

// The worker's order placement, kept apart from ibkrGatewayWorker.ts (which starts the worker as soon as it is imported) and
// taking everything it touches as parameters, so every guard, status transition and order shape can be tested without a
// Gateway or a running worker. The worker passes the real collaborators (see orderPlacementDependencies there).

export interface OrderPlacementDependencies {
  db: Knex;
  getIb(): IBApi | null;
  getNextOrderId(): number;
  getCurrentAccountBinding(): AccountBinding;
  getExpectedAccountId(): string;
  endOrderIfPlacementBlocked(orderRequest: { id: string; gate_evaluation: StoredGateEvaluation | null }): Promise<PlacementBlock | null>;
  endOrderIfLimitPriceUnsafe(orderRequest: { id: string; payload: OrderRequestPayload }, ib: IBApi): Promise<LimitPriceBlock | null>;
  /** Telegram, bounded by a timeout so a hung call can never block placement. */
  notify(message: string): Promise<void>;
  publishPulse(edgeId: PulseEdgeId): Promise<void>;
  resolveContractId(ib: IBApi, contract: Contract, requestId: number): Promise<number | null>;
  allocateContractResolutionRequestId(): number;
  /** The live limit-price check (ibkrGatewayLimitPriceCheck.ts) without ending the order: a limit change it refuses is dropped. */
  limitPriceRefusal(payload: OrderRequestPayload, ib: IBApi): Promise<string | null>;
  /** The trading halt as it is now: no limit change is sent while it is on. */
  fetchTradingHalt(): Promise<{ enabled: boolean; reason: string | null }>;
  /** The limit changes just sent, so an IBKR error on one reads as the change refused (handleOrderErrorEvent). */
  recentLimitPriceChanges: Pick<RecentLimitPriceChanges, "remember" | "forget">;
}

export type ContractResolutionDependencies = Pick<OrderPlacementDependencies, "resolveContractId" | "allocateContractResolutionRequestId">;

export function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * IBKR's Adaptive algo, applied to single-leg orders only: IBKR documents it
 * as single-leg only ("not available for spread orders"), so a BAG combo is a
 * plain guaranteed limit order at its net price. It wraps the existing LMT
 * order rather than replacing it — the order type and lmtPrice are unchanged,
 * so the worst-case fill price is the limit; Adaptive only affects how IBKR
 * works the order to try for a better/faster fill within that limit. Priority
 * defaults to "Normal" but is picked per-order from the Order Review screen
 * via payload.adaptivePriority.
 */
export function buildAdaptiveAlgoFields(priority: AdaptivePriority = "Normal"): Pick<IbkrOrder, "algoStrategy" | "algoParams"> {
  return { algoStrategy: "Adaptive", algoParams: [{ tag: "adaptivePriority", value: priority }] };
}

/** Resolves every leg's conId (reusing a pre-resolved one where the payload already has it). */
export async function resolveLegContractIds(ib: IBApi | null, legs: OrderLegPayload[], dependencies: ContractResolutionDependencies): Promise<(number | null)[]> {
  if (!ib) return legs.map(() => null);
  const results: (number | null)[] = [];
  for (const leg of legs) {
    if (leg.ibkrContractId) {
      results.push(leg.ibkrContractId);
      continue;
    }
    results.push(await dependencies.resolveContractId(ib, buildLegContract(leg), dependencies.allocateContractResolutionRequestId()));
  }
  return results;
}

/**
 * Builds the IBKR Contract + Order for an order_requests row. A single leg
 * is a plain limit order; multiple legs become one atomic BAG combo order
 * to avoid a naked-exposure window.
 */
export async function buildIbkrOrder(payload: OrderRequestPayload, ib: IBApi | null, dependencies: ContractResolutionDependencies): Promise<{ contract: Contract; order: IbkrOrder } | null> {
  if (!ib) return null;

  const conIds = await resolveLegContractIds(ib, payload.legs, dependencies);
  if (conIds.some((conId) => conId === null)) return null;

  if (payload.legs.length === 1) {
    const leg = payload.legs[0]!;
    const contract = buildContractFromConId(leg, conIds[0]!);
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

  // IBKR combo ratios must be reduced to their smallest integer terms, with totalQuantity carrying the reduced-out
  // common factor (the number of combo "units"): 300 shares against 3 contracts is ratio 100:1 with 3 units, and a raw
  // 300:3 ratio is rejected outright ("error 321: Invalid leg ratio").
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
 * the worker's channel). Only the worker holds the persistent IBKR
 * connection, so only it can call ib.cancelOrder() — the orderStatus listener
 * flips the row to "cancelled" once IBKR confirms, same as every other terminal status.
 */
export async function cancelSubmittedOrder(orderRequestId: string, dependencies: OrderPlacementDependencies): Promise<void> {
  const { db } = dependencies;
  const ib = dependencies.getIb();
  if (!ib) {
    console.error(`processCancelRequest(${orderRequestId}): no IBKR connection — cancel not sent, will retry on the next LISTEN/poll cycle.`);
    return;
  }

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "cancel_requested" }).first();
  if (!orderRequest) return; // already processed (cancelled/filled) or not actually requested

  if (!orderRequest.ibkr_order_id) {
    // cancel_requested is only reachable from submitted/partially_filled, both of which have an ibkr_order_id —
    // but fail safe rather than leaving the row stuck.
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "error", error_message: "cancel_requested with no ibkr_order_id.", updated_at: db.fn.now() });
    return;
  }

  ib.cancelOrder(orderRequest.ibkr_order_id);
}

/**
 * Places a confirmed order. The guards run in a fixed order, each failing closed: the worker's own last placement check,
 * the connection, the account binding, the live limit-price check, then building the order and claiming the row
 * (conditioned on it still being "confirmed", so a cancel that lands meanwhile wins) before anything is sent to IBKR.
 */
export async function placeConfirmedOrder(orderRequestId: string, dependencies: OrderPlacementDependencies): Promise<void> {
  const { db } = dependencies;
  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "confirmed" }).first();
  if (!orderRequest) return; // already processed, cancelled, or not actually confirmed

  const payload = orderRequest.payload as OrderRequestPayload;

  // The trading halt as it is NOW, a stored gate verdict from the confirm step with no blocks, and no more than
  // maximumConfirmedOrderAgeMs between that verdict and now. Run before the connection check on purpose: an order that
  // expired while the Gateway was down is ended here, not left to fire when the connection returns.
  const placementBlock = await dependencies.endOrderIfPlacementBlocked(orderRequest);
  if (placementBlock) {
    console.error(`processOrderRequest(${orderRequestId}): ${placementBlock.reason}`);
    if (placementBlock.ended) await dependencies.notify(`🛑 Order for ${payload.symbol} (id ${orderRequestId}) was NOT sent to IBKR.\n${placementBlock.reason}`);
    return;
  }

  const ib = dependencies.getIb();
  if (!ib) {
    console.error(`processOrderRequest(${orderRequestId}): no IBKR connection — order not sent, will retry on the next LISTEN/poll cycle.`);
    return;
  }

  // Fail-closed account binding. "pending" (just reconnected, accounts not reported yet) leaves the order confirmed for
  // the next poll cycle; a real mismatch errors it for good so a stale limit price can never fire later once the
  // binding recovers.
  const binding = dependencies.getCurrentAccountBinding();
  if (binding.status === "pending") {
    console.log(`processOrderRequest(${orderRequestId}): account binding pending (${binding.reason}) — order left confirmed, will retry.`);
    return;
  }
  if (binding.status === "mismatch") {
    const message = `Trading blocked by account binding: ${binding.reason}`;
    console.error(`processOrderRequest(${orderRequestId}): ${message}`);
    await db("order_requests").where({ id: orderRequestId }).update({ status: "error", error_message: message, updated_at: db.fn.now() });
    await dependencies.notify(`🛑 Order for ${payload.symbol} (id ${orderRequestId}) was NOT sent to IBKR.\n${message}`);
    return;
  }
  // The limit-price check, repeated from a real-time snapshot on this connection: one snapshot per leg (no streaming line is held),
  // requested and released within this call. Fail closed.
  const priceBlock = await dependencies.endOrderIfLimitPriceUnsafe(orderRequest, ib);
  if (priceBlock) {
    console.error(`processOrderRequest(${orderRequestId}): ${priceBlock.reason}`);
    if (priceBlock.ended) await dependencies.notify(`🛑 Order for ${payload.symbol} (id ${orderRequestId}) was NOT sent to IBKR.\n${priceBlock.reason}`);
    return;
  }
  console.log(`processOrderRequest(${orderRequestId}): building order for ${payload.symbol}, ${payload.legs.length} leg(s).`);
  try {
    const built = await buildIbkrOrder(payload, ib, dependencies);
    if (!built) {
      console.error(`processOrderRequest(${orderRequestId}): buildOrder returned null — could not resolve one or more contract ids.`);
      await db("order_requests")
        .where({ id: orderRequestId })
        .update({ status: "error", error_message: "Could not resolve one or more contract ids.", updated_at: db.fn.now() });
      return;
    }

    const ibkrOrderId = dependencies.getNextOrderId();
    // Conditioned on the row still being "confirmed": a cancel that landed while the order was being built must win —
    // otherwise "cancelled" would be overwritten with "submitted" and an order the app said was cancelled would be
    // placed. Zero rows changed means someone else moved it; do not place.
    const claimed = await db("order_requests")
      .where({ id: orderRequestId, status: "confirmed" })
      .update({ status: "submitted", ibkr_order_id: ibkrOrderId, placed_at: db.fn.now(), updated_at: db.fn.now() })
      .returning("id");
    if (claimed.length === 0) {
      console.log(`processOrderRequest(${orderRequestId}): no longer confirmed (cancelled or already taken) — not placing.`);
      return;
    }

    console.log(`processOrderRequest(${orderRequestId}): placing IBKR order ${ibkrOrderId} (${payload.symbol}, lmtPrice=${built.order.lmtPrice}).`);
    // Name the account on the order itself: if the Gateway session does not manage it, IBKR rejects the order.
    built.order.account = dependencies.getExpectedAccountId();
    ib.placeOrder(ibkrOrderId, built.contract, built.order);
    // Animation-only signal for Iorio Pulse's IBKR-Gateway line (never persisted).
    dependencies.publishPulse("ibkr-gateway").catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "error", error_message: message, updated_at: db.fn.now() });
    await dependencies.notify(`🔥 Order request errored while placing with IBKR: ${payload.symbol} (id ${orderRequestId}).\n${message}`);
  }
}


/**
 * Changes a working single-leg order's limit at IBKR (follow the mid, lib/orderLimitPriceChanges.ts; route POST
 * /orders/:id/reprice, which records the request on the payload and NOTIFYs). The same IBKR order is sent again with the
 * new limit (placeOrder with its own order id), after the live limit-price check. The payload's limit and its change list
 * are written before sending, conditioned on the order still working and the request being the one read, so a fill or a
 * newer request wins. A change that is not sent is dropped with its reason in the list; the order keeps working.
 */
export async function changeSubmittedOrderLimit(orderRequestId: string, dependencies: OrderPlacementDependencies): Promise<void> {
  const { db } = dependencies;
  const ib = dependencies.getIb();
  if (!ib) {
    console.error(`processLimitChange(${orderRequestId}): no IBKR connection — change not sent, will retry on the next LISTEN/poll cycle.`);
    return;
  }
  const orderRequest = await db("order_requests").where({ id: orderRequestId }).whereIn("status", limitChangeableOrderStatuses).first();
  const payload = orderRequest?.payload as OrderRequestPayload | undefined;
  const request = payload?.limitPriceChangeRequest;
  if (!orderRequest || !payload || !request) return;
  const leg = payload.legs.length === 1 ? payload.legs[0] : undefined;
  const from = leg?.unitPrice ?? null;
  const at = new Date().toISOString();
  const { limitPriceChangeRequest: _sent, ...withoutRequest } = payload;
  const stillTheRequest = (builder: ReturnType<typeof db>) =>
    builder.where({ id: orderRequestId }).whereIn("status", limitChangeableOrderStatuses).whereRaw("payload->'limitPriceChangeRequest'->>'requestedAt' = ?", [request.requestedAt]);
  const drop = async (reason: string) => {
    console.warn(`processLimitChange(${orderRequestId}): limit change to ${request.limitPrice} not sent — ${reason}`);
    const changes = from === null ? withoutRequest.limitPriceChanges : [...(withoutRequest.limitPriceChanges ?? []), { at, from, to: request.limitPrice, refused: reason }];
    await stillTheRequest(db("order_requests")).update({ payload: { ...withoutRequest, ...(changes ? { limitPriceChanges: changes } : {}) }, updated_at: db.fn.now() });
  };

  if (!leg || from === null) return drop("only a single-leg order's limit is changed");
  if (!orderRequest.ibkr_order_id) return drop("the order has no IBKR order id");
  if (from === request.limitPrice) return drop("the limit is already that price");
  const halt = await dependencies.fetchTradingHalt();
  if (halt.enabled) return drop(`trading is halted${halt.reason ? ` (${halt.reason})` : ""}`);
  if (dependencies.getCurrentAccountBinding().status !== "ok") return drop("the account binding is not confirmed");

  const changedPayload: OrderRequestPayload = { ...withoutRequest, legs: [{ ...leg, unitPrice: request.limitPrice }] };
  const refusal = await dependencies.limitPriceRefusal(changedPayload, ib);
  if (refusal) return drop(refusal);
  const built = await buildIbkrOrder(changedPayload, ib, dependencies);
  if (!built) return drop("could not resolve the contract id");

  const changes = [...(withoutRequest.limitPriceChanges ?? []), { at, from, to: request.limitPrice }];
  const claimed = await stillTheRequest(db("order_requests")).update({ payload: { ...changedPayload, limitPriceChanges: changes }, updated_at: db.fn.now() }).returning("id");
  if (claimed.length === 0) return; // filled, cancelled or asked again meanwhile: that wins

  dependencies.recentLimitPriceChanges.remember(orderRequest.ibkr_order_id, { orderRequestId, from, to: request.limitPrice });
  built.order.account = dependencies.getExpectedAccountId();
  try {
    console.log(`processLimitChange(${orderRequestId}): changing IBKR order ${orderRequest.ibkr_order_id} (${payload.symbol}) from ${from} to ${request.limitPrice}.`);
    ib.placeOrder(orderRequest.ibkr_order_id, built.contract, built.order);
    dependencies.publishPulse("ibkr-gateway").catch(() => {});
  } catch (error) {
    dependencies.recentLimitPriceChanges.forget(orderRequest.ibkr_order_id);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`processLimitChange(${orderRequestId}): sending the change failed — ${reason}`);
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ payload: { ...changedPayload, legs: [{ ...leg, unitPrice: from }], limitPriceChanges: [...changes.slice(0, -1), { at, from, to: request.limitPrice, refused: reason }] }, updated_at: db.fn.now() });
  }
}
