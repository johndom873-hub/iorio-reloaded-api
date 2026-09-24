import type { Knex } from "knex";

// A priority reservation (the 10:00 ET chain capture) always succeeds and is
// subtracted from what every non-priority holder may take, so the capture can
// never be starved by live screens — approved 2026-09-24 ("Fit" variant, see
// PROGRESS.md "DAY SIGNALS").
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("ibkr_market_data_line_reservations", (table) => {
    table.boolean("priority").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("ibkr_market_data_line_reservations", (table) => {
    table.dropColumn("priority");
  });
}
