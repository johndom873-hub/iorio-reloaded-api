import type { Knex } from "knex";

// Fill-far-from-reference breaker (design list, built 2026-09-29): a fill more than this share of
// the reference price away from it (below the bid for a sell, above the ask for a buy) trips the
// `fill_slippage` breaker. Default 25 % — Marcelo to veto.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("max_fill_slippage_pct", 6, 2).notNullable().defaultTo(25);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("max_fill_slippage_pct");
  });
}
