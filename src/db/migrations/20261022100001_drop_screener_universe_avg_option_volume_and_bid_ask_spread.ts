import type { Knex } from "knex";

// The Screener no longer collects average option volume or the bid-ask spread (Marcelo 2026-10-22): neither was used.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("screener_universe", (table) => {
    table.dropColumn("avg_option_volume");
    table.dropColumn("bid_ask_spread_pct");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("screener_universe", (table) => {
    table.decimal("avg_option_volume", 14, 2);
    table.decimal("bid_ask_spread_pct", 8, 6);
  });
}
