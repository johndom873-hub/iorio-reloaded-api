import type { Knex } from "knex";

// Additive: an order IBKR cancelled (or expired at the close) after part of it had already filled used to be
// recorded as "partially_filled" -- indistinguishable from one still working. This is its own final status.
const previousStatuses = [
  "pending_confirmation",
  "confirmed",
  "submitted",
  "filled",
  "partially_filled",
  "cancelled",
  "rejected",
  "error",
  "cancel_requested",
];
const nextStatuses = [...previousStatuses, "cancelled_partially_filled"];

export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE order_requests DROP CONSTRAINT order_requests_status_check");
  await knex.raw(
    `ALTER TABLE order_requests ADD CONSTRAINT order_requests_status_check CHECK (status IN (${nextStatuses.map((s) => `'${s}'`).join(", ")}))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("UPDATE order_requests SET status = 'partially_filled' WHERE status = 'cancelled_partially_filled'");
  await knex.raw("ALTER TABLE order_requests DROP CONSTRAINT order_requests_status_check");
  await knex.raw(
    `ALTER TABLE order_requests ADD CONSTRAINT order_requests_status_check CHECK (status IN (${previousStatuses.map((s) => `'${s}'`).join(", ")}))`,
  );
}
