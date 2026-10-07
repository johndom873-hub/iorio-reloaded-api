import type { Knex } from "knex";

// Pluto's day-move limit becomes relative to each stock's normal day (Marcelo, 2026-10-07): a ticker is out when today's
// move exceeds this many times its forecast volatility × 100 / √252. Replaces the fixed ±6% limit.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("max_day_move_multiple", 6, 2).notNullable().defaultTo(3);
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("max_abs_day_change_pct");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("max_abs_day_change_pct", 6, 2).notNullable().defaultTo(6);
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("max_day_move_multiple");
  });
}
