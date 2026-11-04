import type { Knex } from "knex";

// Vol Farmer v4 caps a sale at the bid size of the quote it sells on (Marcelo 2026-11-05): the band quotes keep the contracts at the bid and the ask.
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
