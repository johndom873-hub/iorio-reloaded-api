import { db } from "../db/connection.js";
import { computeNetLimitPrice, type OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { describeOrderFillLine, fillBearingOrderStatuses, fillsAreComplete, loadOrderFills, shouldWaitForFills, type OrderFill } from "./orderFills.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { describeTradeContract, formatTradePrice } from "./tradeMessageFormatting.js";

// Trading-events catch-all, order side (approved 2026-10-07): every status change of every app order, whoever placed it
// (web, Genosuke or Pluto), is told once to the alerts chat. Pluto's and Genosuke's own messages about their orders stay
// as well, duplicates accepted. telegram_notified_status remembers the last status told, so a restart neither repeats nor
// loses a message. Runs on the web dyno.

const noticeIntervalMs = 5_000;
/** Orders older than this are never announced, whatever their notice state. */
const noticeWindowHours = 48;

export const notifiableOrderStatuses = ["submitted", "partially_filled", "filled", "cancelled", "cancelled_partially_filled", "rejected", "error"] as const;

export interface OrderTelegramNotice {
  id: string;
  status: string;
  requestType: string;
  symbol: string;
  legs: OrderLegPayload[];
  errorMessage: string | null;
  cancellationReason: string | null;
  cancelledByDisplayName: string | null;
  /** "Pluto", "Genosuke" or "<display name>, web". */
  placedBy: string;
}

export function describePlacedBy(
  order: { plutoActionId: string | null; requestedByUsername: string; requestedByDisplayName: string },
  genosukeServiceUsername: string | null,
): string {
  if (order.plutoActionId) return "Pluto";
  if (genosukeServiceUsername && order.requestedByUsername === genosukeServiceUsername) return "Genosuke";
  return `${order.requestedByDisplayName}, web`;
}

function describeOrderLines(legs: OrderLegPayload[]): string[] {
  const contract = (leg: OrderLegPayload) =>
    describeTradeContract({
      legType: leg.role,
      quantity: leg.quantity,
      optionType: leg.right ? (leg.right === "C" ? "call" : "put") : null,
      strikePrice: leg.strike ?? null,
      expiryDate: leg.expiry ?? null,
    });
  const [onlyLeg] = legs;
  if (legs.length === 1 && onlyLeg) return [`• ${onlyLeg.action} ${contract(onlyLeg)}, limit ${formatTradePrice(onlyLeg.unitPrice)}`];
  // A combo has one net limit (computeNetLimitPrice: positive = paid, negative = received).
  const netLimit = computeNetLimitPrice(legs);
  const netLabel = netLimit < 0 ? " net credit" : netLimit > 0 ? " net debit" : " net";
  return [...legs.map((leg) => `• ${leg.action} ${contract(leg)}`), `Limit: ${formatTradePrice(Math.abs(netLimit))}${netLabel}`];
}

/** Pure: the Telegram message for one status change. With no fills recorded, a fill-bearing status lists the order instead. */
export function describeOrderTelegramNotice(order: OrderTelegramNotice, fills: OrderFill[]): string {
  const subject = `${order.symbol} ${order.requestType === "roll_leg" ? "roll" : "order"}`;
  const orderLines = describeOrderLines(order.legs);
  const fillsNotRecordedNote = "(fill prices not recorded yet)";
  // Sent after the fill wait with only some of a filled order's fills (a roll's buy-back without its new leg).
  const someFillsMissing = fills.length > 0 && !fillsAreComplete(order.status, order.legs, fills) ? ["(some fills not recorded yet)"] : [];
  const fillLines = fills.length > 0 ? [...fills.map(describeOrderFillLine), ...someFillsMissing] : [...orderLines, fillsNotRecordedNote];
  const by = `(${order.placedBy})`;
  const message = (headline: string, ...lines: string[]) => [headline, ...lines].join("\n");

  switch (order.status) {
    case "submitted":
      return message(`⏳ ${subject} working at IBKR ${by}:`, ...orderLines);
    case "partially_filled":
      return message(`⚠️ ${subject} partly filled, rest still working ${by}:`, ...fillLines);
    case "filled":
      return message(`✅ ${subject} filled ${by}:`, ...fillLines);
    case "cancelled": {
      if (order.cancelledByDisplayName) return message(`🚫 ${subject} cancelled by ${order.cancelledByDisplayName} — nothing filled:`, ...orderLines);
      if (order.cancellationReason === "expired_at_close") return message(`🚫 ${subject} expired unfilled at the close ${by} — nothing filled:`, ...orderLines);
      if (order.cancellationReason === "not_filled_in_time") return message(`🚫 ${subject} cancelled after resting unfilled past the time limit ${by} — nothing filled:`, ...orderLines);
      if (order.cancellationReason === "not_confirmed_in_time") return message(`🚫 ${subject} never confirmed, cancelled ${by} — nothing sent to IBKR:`, ...orderLines);
      const reason = order.errorMessage ? ` (${order.errorMessage})` : "";
      return message(`🚫 ${subject} cancelled at IBKR ${by} — nothing filled${reason}:`, ...orderLines);
    }
    case "cancelled_partially_filled": {
      const headline = order.cancelledByDisplayName
        ? `⚠️ ${subject} cancelled by ${order.cancelledByDisplayName} after partly filling:`
        : order.cancellationReason === "expired_at_close"
          ? `⚠️ ${subject} expired at the close after partly filling ${by}:`
          : order.cancellationReason === "not_filled_in_time"
            ? `⚠️ ${subject} cancelled past the time limit after partly filling ${by}:`
            : `⚠️ ${subject} cancelled after partly filling ${by}:`;
      return message(headline, ...orderLines, "Filled:", ...(fills.length > 0 ? fills.map(describeOrderFillLine) : [fillsNotRecordedNote]));
    }
    case "rejected":
      return message(`❌ IBKR rejected the ${subject} ${by}: ${order.errorMessage ?? "no reason given"}`, ...orderLines);
    case "error":
      return message(`❌ ${subject} failed ${by}: ${order.errorMessage ?? "unknown error"}`, ...orderLines);
    default:
      return message(`${subject} status: ${order.status} ${by}`, ...orderLines);
  }
}

export interface OrderTelegramNoticeRow extends OrderTelegramNotice {
  /** When the order last changed status. */
  updatedAt: Date;
}

export interface OrderTelegramNoticeDependencies {
  loadOrdersNeedingNotice(): Promise<OrderTelegramNoticeRow[]>;
  loadFills(orderId: string): Promise<OrderFill[]>;
  /** Whether the message was delivered. */
  send(text: string): Promise<boolean>;
  markNotified(orderId: string, status: string): Promise<void>;
  now(): number;
}

/** One pass: tells the chat about every order whose status changed since it was last told. An undelivered message, or fills still being recorded, leave the order for a later pass. */
export async function sendDueOrderTelegramNotices(dependencies: OrderTelegramNoticeDependencies): Promise<number> {
  const orders = await dependencies.loadOrdersNeedingNotice();
  let sent = 0;
  for (const order of orders) {
    try {
      let fills: OrderFill[] = [];
      if (fillBearingOrderStatuses.includes(order.status)) {
        fills = await dependencies.loadFills(order.id);
        // Waits for a new contract's fills (see shouldWaitForFills), then goes out with the order's legs instead.
        if (shouldWaitForFills(order.status, order.legs, fills, order.updatedAt, dependencies.now())) continue;
      }
      if (!(await dependencies.send(describeOrderTelegramNotice(order, fills)))) continue;
      await dependencies.markNotified(order.id, order.status);
      sent += 1;
    } catch (error) {
      console.error(`Order Telegram notice: could not send the ${order.status} notice for order ${order.id}`, error);
    }
  }
  return sent;
}

export function createDatabaseDependencies(): OrderTelegramNoticeDependencies {
  return {
    loadOrdersNeedingNotice: async () => {
      const rows = await db("order_requests as orq")
        .join("users as requester", "requester.id", "orq.requested_by_user_id")
        .leftJoin("users as canceller", "canceller.id", "orq.cancelled_by_user_id")
        .whereIn("orq.status", [...notifiableOrderStatuses])
        .whereRaw("orq.telegram_notified_status is distinct from orq.status")
        // An order cancelled before it was ever sent (a review panel closed without Confirm, a gate-blocked Genosuke or
        // Pluto order) is not news; one left unconfirmed until the stale sweep cancelled it still is.
        .whereRaw("not (orq.status = 'cancelled' and orq.ibkr_order_id is null and orq.cancellation_reason is distinct from 'not_confirmed_in_time')")
        .whereRaw(`orq.created_at > now() - interval '${noticeWindowHours} hours'`)
        .orderBy("orq.updated_at")
        .select(
          "orq.id",
          "orq.status",
          "orq.request_type as requestType",
          "orq.payload",
          "orq.error_message as errorMessage",
          "orq.cancellation_reason as cancellationReason",
          "orq.pluto_action_id as plutoActionId",
          "orq.updated_at as updatedAt",
          "requester.username as requestedByUsername",
          "requester.display_name as requestedByDisplayName",
          "canceller.display_name as cancelledByDisplayName",
        );
      // Read at call time, like notifyTelegram: unset where Genosuke is not set up, and then no order is Genosuke's.
      const genosukeServiceUsername = process.env.GENOSUKE_SERVICE_USERNAME || null;
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        requestType: row.requestType,
        symbol: row.payload.symbol,
        legs: row.payload.legs,
        errorMessage: row.errorMessage,
        cancellationReason: row.cancellationReason,
        cancelledByDisplayName: row.cancelledByDisplayName,
        placedBy: describePlacedBy(row, genosukeServiceUsername),
        updatedAt: new Date(row.updatedAt),
      }));
    },
    loadFills: loadOrderFills,
    send: notifyTelegram,
    markNotified: async (orderId, status) => {
      await db("order_requests").where({ id: orderId }).update({ telegram_notified_status: status });
    },
    now: () => Date.now(),
  };
}

let noticeTimer: NodeJS.Timeout | null = null;

export function startOrderTelegramNotices(): void {
  if (noticeTimer) return;
  const dependencies = createDatabaseDependencies();
  let running = false;
  noticeTimer = setInterval(() => {
    if (running) return;
    running = true;
    sendDueOrderTelegramNotices(dependencies)
      .catch((error) => console.error("Order Telegram notice pass failed", error instanceof Error ? error.message : error))
      .finally(() => {
        running = false;
      });
  }, noticeIntervalMs);
  noticeTimer.unref();
}
