/** Statuses that mean an order is still on its way to, or working at, IBKR. */
export const activeOrderRequestStatuses = ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"] as const;

/** Statuses after which an order never changes again (partially_filled is still working; a cancel after a partial fill is cancelled_partially_filled). */
export const finalOrderRequestStatuses = ["filled", "cancelled", "cancelled_partially_filled", "rejected", "error"] as const;

export function isFinalOrderRequestStatus(status: string): boolean {
  return (finalOrderRequestStatuses as readonly string[]).includes(status);
}
