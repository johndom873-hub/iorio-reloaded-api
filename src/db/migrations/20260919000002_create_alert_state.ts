import type { Knex } from "knex";

// One row per alert that is currently "down" (already announced on Telegram).
// A row's existence IS the state: present = an outage/failure was already
// alerted, absent = healthy or never alerted. Lives in Postgres rather than
// process memory so it's shared between the VPS worker and the Heroku health
// check, and survives the worker's systemd restarts (an in-memory throttle
// would reset on every restart and defeat the purpose).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("alert_state", (table) => {
    table.text("alert_key").primary();
    table.timestamp("first_alerted_at", { useTz: true }).notNullable();
    table.timestamp("last_alerted_at", { useTz: true }).notNullable();
    table.text("last_message").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("alert_state");
}
