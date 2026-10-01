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
