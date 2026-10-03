import type { Knex } from "knex";

// Order setup warns when the order's commission is above this share of its premium (approved 2026-10-02: 5%).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("signal_settings", (table) => {
    table.decimal("commission_warn_share_of_premium_pct", 5, 2).notNullable().defaultTo(5);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("signal_settings", (table) => {
    table.dropColumn("commission_warn_share_of_premium_pct");
  });
}
