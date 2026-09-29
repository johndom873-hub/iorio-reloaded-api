import type { Knex } from "knex";

// Ticker cooldown moves from sessions to minutes (Marcelo, 2026-09-29): after a *filled* Pluto
// action on a symbol, Pluto waits this long before acting on it again (0 = no cooldown). Default 60,
// so it can close and re-open intraday without firing consecutive trades.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("ticker_cooldown_sessions", "ticker_cooldown_minutes");
  });
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ticker_cooldown_minutes SET DEFAULT 60");
  await knex("pluto_settings").update({ ticker_cooldown_minutes: 60 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("ticker_cooldown_minutes", "ticker_cooldown_sessions");
  });
  await knex.raw("ALTER TABLE pluto_settings ALTER COLUMN ticker_cooldown_sessions SET DEFAULT 1");
  await knex("pluto_settings").update({ ticker_cooldown_sessions: 1 });
}
