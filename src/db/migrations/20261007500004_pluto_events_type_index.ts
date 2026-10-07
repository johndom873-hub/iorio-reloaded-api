import type { Knex } from "knex";

// The Event log filters by type (categories, types, excludeTypes, and the ticker trace's pass_started lookup), and Pluto's
// events are kept for good (no pruning since 2026-10-07), so the table only grows.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_events", (table) => {
    table.index(["type", "occurred_at"], "pluto_events_type_occurred_at_index");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_events", (table) => {
    table.dropIndex(["type", "occurred_at"], "pluto_events_type_occurred_at_index");
  });
}
