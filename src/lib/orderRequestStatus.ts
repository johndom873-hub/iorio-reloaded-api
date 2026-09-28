// Order-state rules shared by the VPS worker and the API (gap fix 7 for Pluto, 2026-09-28).
// Pure so the state machine is unit-testable without IBKR.

/** Truly final statuses — partially_filled is excluded here because it can still fill more while IBKR works it. */
export const finalOrderRequestStatuses = ["filled", "cancelled", "rejected", "error"] as const;

/** IBKR statuses after which nothing more will ever fill. */
export const finalIbkrStatuses = new Set(["Filled", "Cancelled", "ApiCancelled", "Inactive"]);

/**
 * IBKR error codes that mean "this order was refused" rather than a transient or informational
 * message. Everything else non-informational keeps the historical "error" treatment.
 *   110 price does not conform to the minimum price variation
 *   200 no security definition found
 *   201 order rejected (reason in the message)
 *   203 security is not available or not allowed for this account
 *   321 / 322 order validation errors
 */
export const rejectionErrorCodes = new Set([110, 200, 201, 203, 321, 322]);

/** Informational codes IBKR attaches to accepted orders (399 "Order Message", 202 "Order cancelled", the 2100–2169 system range). */
export function isInformationalIbkrOrderCode(code: number): boolean {
  return code === 399 || code === 202 || (code >= 2100 && code <= 2169);
}

export type MappedOrderRequestStatus = "filled" | "partially_filled" | "cancelled" | "rejected" | "submitted";

/**
 * IBKR orderStatus → our status. A cancelled or inactive order that already filled part of its
 * quantity is reported as partially_filled (final via ibkr_status), never as a bare "cancelled"
 * that hides the fills. "Inactive" with nothing filled is a rejection: IBKR's own definition is
 * an order that is not working because it was invalid, ignored by the destination, or rejected.
 */
export function mapIbkrOrderStatus(status: string, filled: number, remaining: number): MappedOrderRequestStatus | null {
  if (status === "Filled") return "filled";
  if (status === "Cancelled" || status === "ApiCancelled" || status === "Inactive") {
    if (filled > 0) return "partially_filled";
    return status === "Inactive" ? "rejected" : "cancelled";
  }
  if (filled > 0 && remaining > 0) return "partially_filled";
  if (status === "Submitted" || status === "PreSubmitted") return "submitted";
  return null;
}

/** A row that will never change again: a final status, or a partial fill IBKR has stopped working. */
export function isOrderRequestFinal(row: { status: string; ibkr_status?: string | null }): boolean {
  if ((finalOrderRequestStatuses as readonly string[]).includes(row.status)) return true;
  return row.status === "partially_filled" && row.ibkr_status !== null && row.ibkr_status !== undefined && finalIbkrStatuses.has(row.ibkr_status);
}
