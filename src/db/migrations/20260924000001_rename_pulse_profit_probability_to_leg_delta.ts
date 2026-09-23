import type { Knex } from "knex";

// Repurposes the Pulse-chart sample table from N(d2) profit probability to
// raw option-leg delta (approved 2026-09-24) — renamed rather than a new
// table since 20260923000004_create_pulse_chart_samples already shipped to
// staging with no other consumers of the old name.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.renameTable("pulse_profit_probability_samples", "pulse_leg_delta_samples");
  await knex.schema.alterTable("pulse_leg_delta_samples", (table) => {
    table.renameColumn("profit_probability", "leg_delta");
  });
  await knex.schema.raw("ALTER INDEX pulse_profit_probability_samples_sampled_at_index RENAME TO pulse_leg_delta_samples_sampled_at_index");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw("ALTER INDEX pulse_leg_delta_samples_sampled_at_index RENAME TO pulse_profit_probability_samples_sampled_at_index");
  await knex.schema.alterTable("pulse_leg_delta_samples", (table) => {
    table.renameColumn("leg_delta", "profit_probability");
  });
  await knex.schema.renameTable("pulse_leg_delta_samples", "pulse_profit_probability_samples");
}
