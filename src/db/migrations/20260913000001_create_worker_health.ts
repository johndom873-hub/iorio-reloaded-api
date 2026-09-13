import type { Knex } from "knex";

// Single-row-per-process state table, upserted by ibkrGatewayWorker.ts on
// the VPS and read by the web dyno's GET /system-health/gateway — see that
// route's comment for why this is a table (state) rather than a
// pg_notify/LISTEN event (notificationChannel.ts is for events, not state;
// piggybacking would leave a freshly-restarted web dyno reading "unknown"
// until the next heartbeat). Keyed by process_name rather than a single
// fixed row so a second worker type could exist later without a schema
// change, though there's only ever one row today.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("worker_health", (table) => {
    table.text("process_name").primary();
    table.boolean("connected").notNullable();
    table.bigInteger("uptime_ms");
    table.integer("total_reconnects").notNullable();
    table.integer("last_system_status_code");
    table.integer("client_id");
    table.timestamp("updated_at", { useTz: true }).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("worker_health");
}
