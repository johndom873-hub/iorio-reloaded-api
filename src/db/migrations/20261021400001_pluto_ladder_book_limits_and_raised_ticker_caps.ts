import type { Knex } from "knex";

// The CC + Put Ladder's book-wide caps (Marcelo 2026-10-21): at most 120 open positions and working orders across every
// ladder ticker, at most 100 ladder orders sent a day across the book. The per-ticker caps are raised: 30 open positions
// (was 5) and 10 working orders (was 5); a row still holding the old default of 5 takes the new one, a value someone set is kept.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.integer("ladder_max_open_positions").notNullable().defaultTo(120);
    table.integer("ladder_max_orders_per_day").notNullable().defaultTo(100);
  });
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ladder_max_open_positions_per_ticker SET DEFAULT 30");
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ladder_max_working_orders_per_ticker SET DEFAULT 10");
  await knex("pluto_settings").where({ ladder_max_open_positions_per_ticker: 5 }).update({ ladder_max_open_positions_per_ticker: 30 });
  await knex("pluto_settings").where({ ladder_max_working_orders_per_ticker: 5 }).update({ ladder_max_working_orders_per_ticker: 10 });
}

export async function down(knex: Knex): Promise<void> {
  await knex("pluto_settings").where({ ladder_max_open_positions_per_ticker: 30 }).update({ ladder_max_open_positions_per_ticker: 5 });
  await knex("pluto_settings").where({ ladder_max_working_orders_per_ticker: 10 }).update({ ladder_max_working_orders_per_ticker: 5 });
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ladder_max_open_positions_per_ticker SET DEFAULT 5");
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ladder_max_working_orders_per_ticker SET DEFAULT 5");
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("ladder_max_open_positions");
    table.dropColumn("ladder_max_orders_per_day");
  });
}
