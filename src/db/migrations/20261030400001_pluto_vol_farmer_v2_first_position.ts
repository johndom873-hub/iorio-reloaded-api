import type { Knex } from "knex";

// Vol Farmer v2's First position (Marcelo 2026-10-30): the share of a ticker's pot its first position's shares are bought
// with, the Puts selling on the rest. 50 keeps the halves Pluto has run with.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v2_first_position_pct", 8, 4).notNullable().defaultTo(50);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("vol_farmer_v2_first_position_pct");
  });
}
