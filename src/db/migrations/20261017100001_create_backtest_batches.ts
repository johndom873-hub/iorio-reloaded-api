import type { Knex } from "knex";

// Backtest batches (Marcelo 2026-10-17): up to 9 runs started together from the New session form, each its own session on
// the same period and settings. A session made before batches has none. Deleting a batch deletes its sessions.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_batches", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("name").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.uuid("batch_id").nullable().references("id").inTable("backtest_batches").onDelete("CASCADE");
    table.integer("run_number").nullable();
    table.index(["batch_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropIndex(["batch_id"]);
    table.dropColumn("run_number");
    table.dropColumn("batch_id");
  });
  await knex.schema.dropTable("backtest_batches");
}
