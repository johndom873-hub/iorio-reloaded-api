import type { Knex } from "knex";

// Pluto's value minimum is the Edge Yield (Marcelo 2026-10-12): the expected profit as a yearly rate on the exposure, so a
// short-dated contract is not held to the dollars a longer one earns over more days. Replaces the per-contract Edge $.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("min_edge_dollars", "min_edge_yield_pct");
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("min_edge_yield_pct", 10, 2).notNullable().defaultTo(15).alter();
  });
  await knex("pluto_settings").update({ min_edge_yield_pct: 15 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("min_edge_yield_pct", "min_edge_dollars");
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("min_edge_dollars", 10, 2).notNullable().defaultTo(30).alter();
  });
}
