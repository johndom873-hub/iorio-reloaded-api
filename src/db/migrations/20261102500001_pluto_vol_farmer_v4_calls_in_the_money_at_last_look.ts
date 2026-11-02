import type { Knex } from "knex";

// Vol Farmer v4's Calls in the money at the window's end (Marcelo 2026-11-02), the lab's callsInTheMoneyAtLastLook: left
// to be assigned at the close, bought back, or bought back only on the last session before a weekend. Every environment
// starts at "assigned", Pluto's behaviour until now; the live value moves through the Pluto screen like any other setting.

const values = ["assigned", "bought_back", "bought_back_before_weekends"];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("vol_farmer_v4_calls_in_the_money_at_last_look").notNullable().defaultTo("assigned");
  });
  await knex.raw(`alter table pluto_settings add constraint pluto_settings_vol_farmer_v4_calls_in_the_money_at_last_look_check check (vol_farmer_v4_calls_in_the_money_at_last_look in (${values.map((value) => `'${value}'`).join(", ")}))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_settings drop constraint pluto_settings_vol_farmer_v4_calls_in_the_money_at_last_look_check");
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("vol_farmer_v4_calls_in_the_money_at_last_look");
  });
}
