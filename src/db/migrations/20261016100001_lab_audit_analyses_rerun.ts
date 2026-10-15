import type { Knex } from "knex";

// How many stored analyses a lab save re-ran, on each audit row the save wrote (the Lab settings section's Change
// history). Null on rows written before this column, and on ticker saves.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_lab_settings_audit", (table) => {
    table.integer("analyses_rerun").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_lab_settings_audit", (table) => {
    table.dropColumn("analyses_rerun");
  });
}
