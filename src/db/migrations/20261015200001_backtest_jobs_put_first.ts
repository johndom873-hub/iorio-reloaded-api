import type { Knex } from "knex";

// A download can go to the top of the queue (Marcelo 2026-10-15): put_first_at orders the queue, the latest first, ahead
// of the jobs never put first. pause_requested stops the running download so it goes back into the queue, right after
// the job that took its place, instead of ending cancelled.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.timestamp("put_first_at", { useTz: true }).nullable();
    table.boolean("pause_requested").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.dropColumn("put_first_at");
    table.dropColumn("pause_requested");
  });
}
