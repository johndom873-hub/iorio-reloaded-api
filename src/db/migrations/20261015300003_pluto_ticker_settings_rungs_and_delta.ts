import type { Knex } from "knex";

// More per-ticker ladder overrides (Marcelo 2026-10-15, via the Analysis modal session): rungs and the |delta| range.
// Null = the strategy's value (pluto_settings.ladder_rungs, ladder_min_abs_delta, ladder_max_abs_delta).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.integer("ladder_rungs").nullable();
    table.decimal("ladder_min_abs_delta", 6, 4).nullable();
    table.decimal("ladder_max_abs_delta", 6, 4).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.dropColumn("ladder_rungs");
    table.dropColumn("ladder_min_abs_delta");
    table.dropColumn("ladder_max_abs_delta");
  });
}
