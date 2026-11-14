import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { peekPooledQuote, pooledLineState, subscribeToPooledQuote } from "../ibkr/marketDataPool.js";
import { requestOrderLimitPriceChange, type LimitPriceChangeRequestResult } from "./orderLimitPriceChangeRequests.js";
import { followTheMidCheckIntervalSeconds, maxLimitPriceChangesPerOrder } from "./orderLimitPriceChanges.js";
import { limitChangeableOrderStatuses } from "./orderRequestStatuses.js";
import { optionLimitPriceGivingUpOneCent } from "./optionLimitPrice.js";

// Follow the mid on a person's orders (Marcelo 2026-11-14): a Call or Put sale, or a LEAPS buy, confirmed with "Follow the
// mid" ticked has its limit moved to Pluto's price (the mid, one cent towards the other side) every
// followTheMidCheckIntervalSeconds while it works, at most maxLimitPriceChangesPerOrder times, with no worst price: the
// unfilled-order sweep and a cancel are its bounds. Runs in the web process, on its pooled live quotes, so it does not
// depend on Pluto running. Every check reads the followed orders from the database, so a restart picks them up as they are.
// Kept out of the worker's modules (ibkrGatewayOrderPayload.ts, orderLimitPriceChanges.ts): the worker only sends the changes.

/** An order's payload with the person's Follow the mid choice (set at confirm, POST /positions/orders/:id/confirm). */
export type FollowableOrderPayload = OrderRequestPayload & { followTheMid?: true };

/**
 * The manual orders a person may have follow the mid (Marcelo 2026-11-14, a checkbox at confirm): a single-leg Call or Put
 * sale, or a LEAPS buy, not built by Pluto. Answers the side the price is given up towards (optionLimitPriceGivingUpOneCent),
 * or null for any other order (buybacks, rolls, share orders, a Call sold with its shares).
 */
export function manualFollowTheMidSide(order: { request_type: string; pluto_action_id: string | null; payload: { legs: readonly { role: string; action: string }[] } }): "sell" | "buy" | null {
  if (order.pluto_action_id || order.payload.legs.length !== 1) return null;
  const leg = order.payload.legs[0]!;
  if (leg.role !== "option") return null;
  if ((order.request_type === "open_covered_call" || order.request_type === "open_cash_secured_put") && leg.action === "SELL") return "sell";
  if (order.request_type === "open_leaps" && leg.action === "BUY") return "buy";
  return null;
}

interface FollowedOrderRow {
  id: string;
  request_type: string;
  pluto_action_id: string | null;
  payload: FollowableOrderPayload;
}

export interface ManualOrderFollowerDependencies {
  loadFollowedOrders(): Promise<FollowedOrderRow[]>;
  subscribe(contract: PriceContract): Promise<() => void>;
  liveQuote(contract: PriceContract): { bid: number | null; ask: number | null } | null;
  requestChange(orderRequestId: string, limitPrice: number): Promise<LimitPriceChangeRequestResult>;
}

/**
 * The limit a followed order moves to now (optionLimitPriceGivingUpOneCent on a two-sided quote), or null to leave it: no
 * quote, a one-sided or crossed quote, or a price within half a cent of the current limit. Bid 1.40 / ask 1.46 on a sale
 * resting at 1.50 → 1.42; on a LEAPS buy resting at 12.10 under 12.20 / 12.80 → 12.51.
 */
export function followedLimitPriceNow(quote: { bid: number | null; ask: number | null } | null, side: "sell" | "buy", currentLimit: number): number | null {
  if (!quote || quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) return null;
  const price = optionLimitPriceGivingUpOneCent(quote.bid, quote.ask, side);
  return Math.abs(price - currentLimit) < 0.005 ? null : price;
}

function optionContractOf(orderRequestId: string, payload: OrderRequestPayload): PriceContract | null {
  const leg = payload.legs[0];
  if (!leg || leg.role !== "option" || !leg.expiry || leg.strike === undefined || !leg.right) return null;
  return { key: `manual-follow-${orderRequestId}`, legType: "option", symbol: leg.symbol, expiry: leg.expiry, strike: Number(leg.strike), right: leg.right === "C" ? OptionType.Call : OptionType.Put };
}

/**
 * One follower: `check()` reads the followed working orders, keeps one pooled quote line per order while it may still change
 * (dropping it once the order is done or at its change cap), and asks for a change where the price has moved a cent or more.
 * An order's first change comes one check after its line opens.
 */
export function createManualOrderFollower(dependencies: ManualOrderFollowerDependencies) {
  const lines = new Map<string, { contract: PriceContract; unsubscribe: () => void }>();
  const lastRefusalByOrder = new Map<string, string>();

  async function check(): Promise<void> {
    const rows = await dependencies.loadFollowedOrders();
    const followable = new Map<string, { row: FollowedOrderRow; side: "sell" | "buy"; contract: PriceContract }>();
    for (const row of rows) {
      const side = manualFollowTheMidSide(row);
      const contract = optionContractOf(row.id, row.payload);
      if (side === null || contract === null || (row.payload.limitPriceChanges?.length ?? 0) >= maxLimitPriceChangesPerOrder) continue;
      followable.set(row.id, { row, side, contract });
    }
    for (const [orderRequestId, line] of lines) {
      if (followable.has(orderRequestId)) continue;
      line.unsubscribe();
      lines.delete(orderRequestId);
      lastRefusalByOrder.delete(orderRequestId);
    }
    for (const [orderRequestId, { row, side, contract }] of followable) {
      if (!lines.has(orderRequestId)) {
        lines.set(orderRequestId, { contract, unsubscribe: await dependencies.subscribe(contract) });
        continue;
      }
      // The worker has not sent the previous change yet.
      if (row.payload.limitPriceChangeRequest) continue;
      const currentLimit = Number(row.payload.legs[0]!.unitPrice);
      const limitPrice = followedLimitPriceNow(dependencies.liveQuote(contract), side, currentLimit);
      if (limitPrice === null) continue;
      const result = await dependencies.requestChange(orderRequestId, limitPrice);
      if (result.ok) {
        lastRefusalByOrder.delete(orderRequestId);
        console.log(`Follow the mid: order ${orderRequestId} (${row.payload.symbol}) limit ${currentLimit} → ${limitPrice} asked.`);
      } else if (lastRefusalByOrder.get(orderRequestId) !== result.error) {
        lastRefusalByOrder.set(orderRequestId, result.error);
        console.warn(`Follow the mid: order ${orderRequestId} (${row.payload.symbol}) limit not changed — ${result.error}`);
      }
    }
  }

  function stop(): void {
    for (const line of lines.values()) line.unsubscribe();
    lines.clear();
    lastRefusalByOrder.clear();
  }

  return { check, stop, followedOrderIds: () => [...lines.keys()] };
}

/** A person's orders working at IBKR with Follow the mid ticked. */
export function loadFollowedManualOrders(): Promise<FollowedOrderRow[]> {
  return db("order_requests")
    .whereIn("status", limitChangeableOrderStatuses)
    .whereNull("pluto_action_id")
    .whereRaw("payload->>'followTheMid' = 'true'")
    .select("id", "request_type", "pluto_action_id", "payload");
}

const defaultDependencies: ManualOrderFollowerDependencies = {
  loadFollowedOrders: loadFollowedManualOrders,
  subscribe: (contract) => subscribeToPooledQuote(contract, () => {}),
  // Only a line IBKR has answered since it opened: a paused or waiting line's quote is old or a stored fallback.
  liveQuote: (contract) => (pooledLineState(contract) === "streaming" ? peekPooledQuote(contract) : null),
  requestChange: (orderRequestId, limitPrice) => requestOrderLimitPriceChange(orderRequestId, limitPrice, undefined),
};

/** Starts the web process's follower of manual orders (server.ts): one check every followTheMidCheckIntervalSeconds. */
export function startManualOrderFollowTheMid(): void {
  const follower = createManualOrderFollower(defaultDependencies);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    follower
      .check()
      .catch((error) => console.warn(`Follow the mid (manual orders) check failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => {
        checking = false;
      });
  }, followTheMidCheckIntervalSeconds * 1000);
  timer.unref?.();
}
