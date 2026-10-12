import type { Knex } from "knex";

// Backtesting jobs show their total run time (Marcelo 2026-10-12). started_at is the current run's start; a resumed
// download keeps the seconds its earlier runs took here (a resumed backtest starts again from zero).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.integer("earlier_run_seconds").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_jobs", (table) => {
    table.dropColumn("earlier_run_seconds");
  });
}
