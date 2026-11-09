import type { Knex } from "knex";

// Pluto's own min cash reserve (Marcelo 2026-11-09): the cash its opening orders leave, as a % of Pluto's book value, at
// 2%; Risk & Limits' min cash reserve now holds the Manual book only. Its buybacks of Calls in the money may use it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("min_cash_reserve_pct", 5, 2).notNullable().defaultTo(2);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("min_cash_reserve_pct");
  });
}
