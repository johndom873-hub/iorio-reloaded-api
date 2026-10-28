import type { Knex } from "knex";

// Pluto's excess allowance (Marcelo 2026-10-28): every ticker's pot is its allocation of Pluto's budget raised by this
// share, so the pots can add up to more than the budget, whose cash they share. 0 = the pots are the allocations.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("excess_allowance_pct", 8, 4).notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("excess_allowance_pct");
  });
}
