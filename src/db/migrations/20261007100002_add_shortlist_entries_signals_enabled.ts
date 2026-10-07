import type { Knex } from "knex";

// Per-ticker Signals flag (Marcelo, 2026-10-07). Off: the ticker is price-only (Price Performance, daily bars,
// calendar) and is left out of option-chain capture, Signals and Pluto. New entries start off; every entry
// already on the shortlist when this runs is switched on, so nothing changes for them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.boolean("signals_enabled").notNullable().defaultTo(false);
  });
  // A removed entry can still carry bot_enabled; it is switched on too so the constraint below holds for every row.
  await knex("shortlist_entries").whereNull("removed_at").orWhere({ bot_enabled: true }).update({ signals_enabled: true });
  // Pluto only trades Signals tickers: turning Signals off turns Pluto off in the same update.
  await knex.raw("ALTER TABLE shortlist_entries ADD CONSTRAINT shortlist_entries_bot_requires_signals CHECK (NOT bot_enabled OR signals_enabled)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE shortlist_entries DROP CONSTRAINT shortlist_entries_bot_requires_signals");
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.dropColumn("signals_enabled");
  });
}
