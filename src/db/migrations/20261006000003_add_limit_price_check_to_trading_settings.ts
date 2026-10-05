import type { Knex } from "knex";

// The limit-price check (Marcelo 2026-10-05): an order's limit price may not be worse than the live mid by more than
// max(deviation % of the mid, a dollar floor). Both are editable on Risk & Limits. Defaults 10% and $0.05 (proposed, approved).
// Additive with defaults, so the old web dynos serving during a release keep working.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trading_settings", (table) => {
    table.decimal("price_check_max_deviation_pct", 5, 2).notNullable().defaultTo(10);
    table.decimal("price_check_min_tolerance_dollars", 6, 2).notNullable().defaultTo(0.05);
  });
  await knex.raw(`
    alter table trading_settings
      add constraint trading_settings_price_check_in_range check (
        price_check_max_deviation_pct between 0 and 100 and price_check_min_tolerance_dollars between 0 and 1000)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table trading_settings drop constraint if exists trading_settings_price_check_in_range");
  await knex.schema.alterTable("trading_settings", (table) => {
    table.dropColumn("price_check_max_deviation_pct");
    table.dropColumn("price_check_min_tolerance_dollars");
  });
}
