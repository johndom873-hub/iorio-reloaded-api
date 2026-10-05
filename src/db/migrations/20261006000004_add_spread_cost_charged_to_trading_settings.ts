import type { Knex } from "knex";

// Signals friction charges this share of the half-spread (Marcelo 2026-10-05): orders go out at the mid, so a fill can be
// at most half a spread below the fair price at that moment, and on average somewhere in between. Default 50%, editable on
// Risk & Limits. Additive with a default, so the old web dynos serving during a release keep working.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trading_settings", (table) => {
    table.decimal("spread_cost_charged_pct", 5, 2).notNullable().defaultTo(50);
  });
  await knex.raw("alter table trading_settings add constraint trading_settings_spread_cost_charged_in_range check (spread_cost_charged_pct between 0 and 100)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table trading_settings drop constraint if exists trading_settings_spread_cost_charged_in_range");
  await knex.schema.alterTable("trading_settings", (table) => {
    table.dropColumn("spread_cost_charged_pct");
  });
}
