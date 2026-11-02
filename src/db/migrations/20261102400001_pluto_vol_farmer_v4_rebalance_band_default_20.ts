import type { Knex } from "knex";

// Vol Farmer v4's rebalancing band defaults to 20% of the pot (Marcelo 2026-11-02): over 2022–2026 and 2026 the 5% to 20%
// bands gave a similar CAGR and drawdown, and 20% trades about an eighth as often. Only the column default changes: the
// live value stays whatever it is set to, and moves through the Pluto screen like any other setting.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v4_rebalance_band_pct", 8, 4).notNullable().defaultTo(20).alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v4_rebalance_band_pct", 8, 4).notNullable().defaultTo(5).alter();
  });
}
