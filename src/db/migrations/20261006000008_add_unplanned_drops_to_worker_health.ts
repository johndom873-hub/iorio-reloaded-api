import type { Knex } from "knex";

// The worker's connection drops over the last 24 hours, excluding the Gateway's planned 05:30 UTC restart (see
// gatewayDropTracker.ts). Pulse shows and colours this instead of total_reconnects, which is a lifetime counter that only
// resets when the worker restarts, so it always read as a problem. Nullable: a row written by an older worker has no value.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.integer("unplanned_drops_last_24h");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.dropColumn("unplanned_drops_last_24h");
  });
}
