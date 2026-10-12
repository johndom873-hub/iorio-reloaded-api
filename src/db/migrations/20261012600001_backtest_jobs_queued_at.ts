import type { Knex } from "knex";

// Backtesting jobs are listed by their latest activity (Marcelo 2026-10-12): queued or resumed, started, last progress,
// finished. A resume left no timestamp, so queued_at records when a job last entered the queue; it also orders the queue.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.timestamp("queued_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex("backtest_jobs").update({ queued_at: knex.ref("created_at") });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.dropColumn("queued_at");
  });
}
