import type { Knex } from "knex";

// Signals is retired (Marcelo 2026-10-27): Pluto no longer requires a ticker's Signals flag, and nothing reads the flag.
// New entries keep the column's default (false), so the constraint would stop Pluto being switched on for them. The
// column itself is dropped with the retired Signals tables, once the release has settled.
export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE shortlist_entries DROP CONSTRAINT shortlist_entries_bot_requires_signals");
}

export async function down(knex: Knex): Promise<void> {
  await knex("shortlist_entries").where({ bot_enabled: true }).update({ signals_enabled: true });
  await knex.raw("ALTER TABLE shortlist_entries ADD CONSTRAINT shortlist_entries_bot_requires_signals CHECK (NOT bot_enabled OR signals_enabled)");
}
