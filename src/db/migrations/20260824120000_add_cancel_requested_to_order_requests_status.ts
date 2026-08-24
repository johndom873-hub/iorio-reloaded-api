import type { Knex } from "knex";

// Additive: adds a transient status for cancelling an order that's already
// submitted to IBKR. The route sets it and NOTIFYs the worker, which calls
// ib.cancelOrder() and lets the existing orderStatus listener flip it to
// "cancelled" once IBKR confirms — same as every other terminal status.
const previousStatuses = [
  "pending_confirmation",
  "confirmed",
  "submitted",
  "filled",
  "partially_filled",
  "cancelled",
  "rejected",
  "error",
];
const nextStatuses = [...previousStatuses, "cancel_requested"];

export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE order_requests DROP CONSTRAINT order_requests_status_check");
  await knex.raw(
    `ALTER TABLE order_requests ADD CONSTRAINT order_requests_status_check CHECK (status IN (${nextStatuses.map((s) => `'${s}'`).join(", ")}))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE order_requests DROP CONSTRAINT order_requests_status_check");
  await knex.raw(
    `ALTER TABLE order_requests ADD CONSTRAINT order_requests_status_check CHECK (status IN (${previousStatuses.map((s) => `'${s}'`).join(", ")}))`,
  );
}
