import type { Knex } from "knex";

// Vol Farmer v4's Always hold the stock (Marcelo 2026-11-03), the lab's alwaysHoldTheStock: "on" buys shares on any day,
// "off" only on a day a Call is sold with them. Pluto's setting starts "on", every environment; a ticker's own value
// (pluto_ticker_settings, null following Pluto's) moves through the Tickers tab with the allocations.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("vol_farmer_v4_always_hold_the_stock").notNullable().defaultTo("on");
  });
  await knex.raw("alter table pluto_settings add constraint pluto_settings_vol_farmer_v4_always_hold_the_stock_check check (vol_farmer_v4_always_hold_the_stock in ('on', 'off'))");
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.text("always_hold_the_stock").nullable();
  });
  await knex.raw("alter table pluto_ticker_settings add constraint pluto_ticker_settings_always_hold_the_stock_check check (always_hold_the_stock is null or always_hold_the_stock in ('on', 'off'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_ticker_settings drop constraint pluto_ticker_settings_always_hold_the_stock_check");
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.dropColumn("always_hold_the_stock");
  });
  await knex.raw("alter table pluto_settings drop constraint pluto_settings_vol_farmer_v4_always_hold_the_stock_check");
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("vol_farmer_v4_always_hold_the_stock");
  });
}
