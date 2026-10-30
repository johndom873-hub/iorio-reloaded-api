import type { Knex } from "knex";

// Every round's notes on its pass (Marcelo 2026-10-30), a round that sent an order included: before, only a round that sent
// nothing kept them, in its pass_skipped event's reason.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_passes", (table) => {
    /** What the strategies' rounds said, "SYMBOL: note" in order; null when the pass stopped before them. */
    table.jsonb("notes").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.dropColumn("notes");
  });
}
