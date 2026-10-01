/** Statuses that mean an order is still on its way to, or working at, IBKR. */
export const activeOrderRequestStatuses = ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"] as const;
