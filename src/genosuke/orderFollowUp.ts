import { db } from "../db/connection.js";
import type { TelegramApi } from "./telegramApi.js";
import { describeOrderFillLine, fillBearingOrderStatuses, fillsAreComplete, loadOrderFills, shouldWaitForFills, type OrderFill } from "../lib/orderFills.js";

export type { OrderFill };

// Genosuke follows the orders it placed until they reach a final status (approved 2026-10-05), and only those, in its own
// voice. Every order, Genosuke's included, is also reported by the trading-events catch-all (lib/orderTelegramNotices.ts);
// both are kept on purpose. Every status change worth hearing about is sent once
// (genosuke_notified_status remembers the last one told), so a restart neither repeats nor loses a message. Fills are read
// from the trades the worker recorded for the order.

const followUpIntervalMs = 5_000;
/** Orders older than this are never re-announced, whatever their notice state. */
const followUpWindowHours = 48;

/** Statuses Genosuke reports: the order is working at IBKR, partly or fully filled, or it ended without (all of) a fill. */
export const notifiableOrderStatuses = ["submitted", "partially_filled", "filled", "cancelled", "cancelled_partially_filled", "rejected", "error"] as const;

export interface OrderNoticeInput {
  id: string;
  status: string;
  errorMessage: string | null;
  /** Why it ended cancelled when no user cancelled it (order_requests.cancellation_reason). */
  cancellationReason: string | null;
  symbol: string;
  /** The order's legs (payload.legs), to tell a filled order whose fills are only partly recorded. */
  legs?: { quantity: number }[];
}

function withFills(headline: string, fills: OrderFill[], someFillsMissing = false): string {
  if (fills.length === 0) return `${headline}\n(fill prices not recorded yet)`;
  return [headline, ...fills.map(describeOrderFillLine), ...(someFillsMissing ? ["(some fills not recorded yet)"] : [])].join("\n");
}

/** Pure: the Telegram message for one status change of an order Genosuke placed. */
export function describeOrderUpdate(order: OrderNoticeInput, fills: OrderFill[]): string {
  switch (order.status) {
    case "submitted":
      return `Working at IBKR: your ${order.symbol} order is placed and resting. I'll tell you when it fills or ends.`;
    case "partially_filled":
      return withFills(`⚠️ ${order.symbol} order partly filled so far, the rest is still working:`, fills);
    case "filled":
      return withFills(`✅ ${order.symbol} order filled — IBKR confirmed the trade:`, fills, order.legs !== undefined && !fillsAreComplete(order.status, order.legs, fills));
    case "cancelled":
      if (order.cancellationReason === "expired_at_close") return `${order.symbol} order expired unfilled at the market close (orders are day orders) — nothing was filled.`;
      if (order.cancellationReason === "not_filled_in_time") return `${order.symbol} order was cancelled after resting unfilled past the time limit — nothing was filled.`;
      if (order.cancellationReason === "not_confirmed_in_time") return `${order.symbol} order was never confirmed and was cancelled after 15 minutes — nothing was sent to IBKR.`;
      return `${order.symbol} order was cancelled at IBKR${order.errorMessage ? ` (${order.errorMessage})` : ""} — nothing was filled.`;
    case "cancelled_partially_filled":
      if (order.cancellationReason === "expired_at_close") return withFills(`⚠️ ${order.symbol} order expired at the market close after partly filling. What was filled:`, fills);
      if (order.cancellationReason === "not_filled_in_time") return withFills(`⚠️ ${order.symbol} order was cancelled past the time limit after partly filling. What was filled:`, fills);
      return withFills(`⚠️ ${order.symbol} order was cancelled at IBKR after partly filling. What was filled:`, fills);
    case "rejected":
      return `❌ IBKR rejected the ${order.symbol} order: ${order.errorMessage ?? "no reason given"}.`;
    case "error":
      return `❌ ${order.symbol} order failed: ${order.errorMessage ?? "unknown error"}.`;
    default:
      return `${order.symbol} order status: ${order.status}.`;
  }
}

export interface OrderNoticeRow extends OrderNoticeInput {
  /** The order's legs (payload.legs), to tell when every fill is recorded. */
  legs: { quantity: number }[];
  /** When the order last changed status. */
  updatedAt: Date;
}

export interface OrderFollowUpDependencies {
  loadOrdersNeedingNotice(): Promise<OrderNoticeRow[]>;
  loadFills(orderId: string): Promise<OrderFill[]>;
  send(text: string): Promise<void>;
  markNotified(orderId: string, status: string): Promise<void>;
  now(): number;
}

/** One pass: tells the chat about every order whose status changed since it was last told. A failed send, or fills still being recorded, leave the order for a later pass. */
export async function sendDueOrderNotices(dependencies: OrderFollowUpDependencies): Promise<number> {
  const orders = await dependencies.loadOrdersNeedingNotice();
  let sent = 0;
  for (const order of orders) {
    try {
      let fills: OrderFill[] = [];
      if (fillBearingOrderStatuses.includes(order.status)) {
        fills = await dependencies.loadFills(order.id);
        if (shouldWaitForFills(order.status, order.legs, fills, order.updatedAt, dependencies.now())) continue;
      }
      await dependencies.send(describeOrderUpdate(order, fills));
      await dependencies.markNotified(order.id, order.status);
      sent += 1;
    } catch (error) {
      console.error(`Genosuke: could not send the ${order.status} notice for order ${order.id}`, error);
    }
  }
  return sent;
}

export function createDatabaseDependencies(serviceUsername: string, send: (text: string) => Promise<void>): OrderFollowUpDependencies {
  return {
    loadOrdersNeedingNotice: async () => {
      const rows = await db("order_requests as orq")
        .join("users as u", "u.id", "orq.requested_by_user_id")
        .where("u.username", serviceUsername)
        .whereIn("orq.status", [...notifiableOrderStatuses])
        .whereRaw("orq.genosuke_notified_status is distinct from orq.status")
        .whereRaw(`orq.created_at > now() - interval '${followUpWindowHours} hours'`)
        .orderBy("orq.updated_at")
        .select(
          "orq.id",
          "orq.status",
          "orq.error_message as errorMessage",
          "orq.cancellation_reason as cancellationReason",
          "orq.updated_at as updatedAt",
          db.raw("orq.payload->>'symbol' as symbol"),
          db.raw("orq.payload->'legs' as legs"),
        );
      return rows.map((row) => ({ ...row, legs: row.legs ?? [], updatedAt: new Date(row.updatedAt) }));
    },
    loadFills: loadOrderFills,
    send,
    markNotified: async (orderId, status) => {
      await db("order_requests").where({ id: orderId }).update({ genosuke_notified_status: status });
    },
    now: () => Date.now(),
  };
}

let followUpTimer: NodeJS.Timeout | null = null;

export function startOrderFollowUp(telegram: TelegramApi, chatId: string, serviceUsername: string): void {
  if (followUpTimer) return;
  const dependencies = createDatabaseDependencies(serviceUsername, (text) => telegram.sendMessage(chatId, text).then(() => undefined));
  let running = false;
  followUpTimer = setInterval(() => {
    if (running) return;
    running = true;
    sendDueOrderNotices(dependencies)
      .catch((error) => console.error("Genosuke: order follow-up pass failed", error instanceof Error ? error.message : error))
      .finally(() => {
        running = false;
      });
  }, followUpIntervalMs);
  followUpTimer.unref();
}
