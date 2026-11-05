import type { Knex } from "knex";

// The band quotes keep the contracts at the bid and the ask (Marcelo 2026-11-05), for analysis: the lab caps a Vol Farmer v4 sale at the bid size, Pluto's sales have no size limit.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_quote_band_quotes", (table) => {
    table.integer("bid_size").nullable();
    table.integer("ask_size").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_quote_band_quotes", (table) => {
    table.dropColumn("bid_size");
    table.dropColumn("ask_size");
  });
}
