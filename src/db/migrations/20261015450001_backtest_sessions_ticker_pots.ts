import type { Knex } from "knex";

// Per-ticker pots in a session (Marcelo 2026-10-15): with book_mode "pots" each ticker has its own baseline values and a
// weight, its pot ÷ every pot, for the ladder's base, in one shared account; symbol_settings holds each ticker's pot,
// weight and resolved values as the session was created. Every earlier session keeps "shared_account" and re-runs unchanged.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.text("book_mode").notNullable().defaultTo("shared_account").checkIn(["shared_account", "pots"]);
    table.jsonb("symbol_settings").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("book_mode");
    table.dropColumn("symbol_settings");
  });
}
