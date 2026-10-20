import type { Knex } from "knex";

// The shares held each backtest day at the same marks as the account value (Marcelo 2026-10-20, recorded only): the
// Analyse window's price chart draws the share of the account in shares from it. Null for days run before it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.decimal("shares_value_dollars", 16, 2).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.dropColumn("shares_value_dollars");
  });
}
