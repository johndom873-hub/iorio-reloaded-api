import type { Knex } from "knex";

// Vol Farmer v4's top-ups are capped (Marcelo 2026-11-01): a ticker's top-ups take the money it has in (its held shares'
// cost and its open Puts' cash) to at most this % of its pot. 0 means no cap, where Pluto starts.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v4_top_up_cap_pct", 8, 4).notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("vol_farmer_v4_top_up_cap_pct");
  });
}
