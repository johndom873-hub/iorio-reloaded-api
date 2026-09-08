import type { Knex } from "knex";

// Tracks whether a Telegram alert has already been sent for this row sitting
// too long in "confirmed"/"cancel_requested" (the worker hasn't picked it up)
// -- see alertOnStaleOrderRequests in ibkrGatewayWorker.ts. Root-caused
// 2026-09-08: the worker silently stopped processing orders for 3 days
// (Sep 5-8) after a startup DB blip left main() in a broken-but-alive state
// with no crash, no restart, and no alert -- nothing detected a confirmed
// order sitting untouched. Cleared once the row leaves that stale state, so
// a future stall on the same row alerts again.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.timestamp("stale_alert_sent_at", { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("stale_alert_sent_at");
  });
}
