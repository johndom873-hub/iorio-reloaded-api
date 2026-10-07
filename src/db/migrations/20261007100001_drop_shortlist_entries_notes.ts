import type { Knex } from "knex";

// Shortlist notes removed (Marcelo, 2026-10-07): the column and its UI go. The down restores an empty column only.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.dropColumn("notes");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.text("notes").nullable();
  });
}
