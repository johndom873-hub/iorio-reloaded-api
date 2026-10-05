import { easternDateIso, easternInstant } from "../lib/marketSessionStatus.js";

/** order_requests.status values the worker derives from IBKR's orderStatus event. */
export type OrderRequestStatusFromIbkr = "filled" | "cancelled" | "cancelled_partially_filled" | "partially_filled" | "submitted";

/**
 * IBKR reports a cancelled order (including a DAY order expiring at the close) as status "Cancelled" whether or
 * not part of it had filled -- `filled` says which. That check must come before the generic "some filled, some
 * remaining" one: otherwise a cancel after a partial fill reads as "partially_filled" (still working) and the
 * cancel is never recorded.
 */
export function requestStatusForOrderStatusEvent(status: string, filled: number, remaining: number): OrderRequestStatusFromIbkr | null {
  if (status === "Cancelled" || status === "ApiCancelled") return filled > 0 ? "cancelled_partially_filled" : "cancelled";
  if (filled > 0 && remaining > 0) return "partially_filled";
  if (status === "Filled") return "filled";
  if (status === "Submitted" || status === "PreSubmitted") return "submitted";
  return null;
}

/** IBKR's error code for a cancelled order ("Order Canceled - reason:<text>"); sent alongside orderStatus "Cancelled". */
export const ibkrOrderCanceledErrorCode = 202;

/**
 * Why IBKR ended an order nobody asked to cancel. Every order goes out as a DAY order, so one created on an earlier
 * Eastern date, or ended at or after the 16:00 ET close, expired at the close. Earlier in the day it is IBKR's own cancel,
 * which includes the expiry on an early-close day (market_calendar records open days, not close times).
 */
export function cancellationReasonForIbkrCancel(orderCreatedAt: Date, endedAt: Date): "expired_at_close" | "cancelled_by_ibkr" {
  const endedDateIso = easternDateIso(endedAt);
  if (easternDateIso(orderCreatedAt) < endedDateIso) return "expired_at_close";
  return endedAt >= easternInstant(endedDateIso, 16, 0) ? "expired_at_close" : "cancelled_by_ibkr";
}

/** The text after "reason:" in an error 202 message, or null when IBKR gave none (a plain expiry or a requested cancel). */
export function ibkrCancelReasonText(message: string): string | null {
  const match = message.match(/reason:\s*(.*)$/is);
  const text = match?.[1]?.trim() ?? "";
  return text.length > 0 ? text : null;
}
