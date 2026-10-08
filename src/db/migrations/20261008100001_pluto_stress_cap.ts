import type { Knex } from "knex";

// Pluto's stress cap (Marcelo, 2026-10-08): an order's new risk is sized so that a move of stress_sigmas forecast standard
// deviations against it by expiry loses at most stress_risk_budget_pct of the account. 0 turns the cap off.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("stress_risk_budget_pct", 6, 2).notNullable().defaultTo(1);
    table.decimal("stress_sigmas", 6, 2).notNullable().defaultTo(2);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("stress_risk_budget_pct");
    table.dropColumn("stress_sigmas");
  });
}
