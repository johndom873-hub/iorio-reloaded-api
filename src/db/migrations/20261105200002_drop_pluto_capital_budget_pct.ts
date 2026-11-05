import type { Knex } from "knex";

// Pluto's capital budget, a share of the account, retires with the Pluto and Manual books (Marcelo 2026-11-05): Pluto's
// pots and cap are measured on its own book value (src/books). Down restores it at 50%, the value it had.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("capital_budget_pct");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("capital_budget_pct", 6, 2).notNullable().defaultTo(50);
  });
}
