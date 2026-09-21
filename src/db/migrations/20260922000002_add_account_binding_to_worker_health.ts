import type { Knex } from "knex";

// Phase B work package 2: the worker publishes whether it is bound to the IBKR account this
// environment expects. Nullable so an older worker's rows (and the API guard's "worker predates
// binding" check) can be told apart from a real "ok".
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.text("account_binding_status");
    table.text("account_binding_reason");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.dropColumn("account_binding_status");
    table.dropColumn("account_binding_reason");
  });
}
