import type { Knex } from "knex";

// How a session of per-ticker pots was asked for, so Run again refills the New session screen: each ticker's lab values
// or the global ones (settings_source), and pots from a starting value split equally or each ticker's own
// (pots_from_starting_value). Null on every "shared_account" session.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.text("settings_source").nullable().checkIn(["per_ticker", "global"]);
    table.boolean("pots_from_starting_value").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("settings_source");
    table.dropColumn("pots_from_starting_value");
  });
}
