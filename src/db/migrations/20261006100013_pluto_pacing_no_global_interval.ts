import type { Knex } from "knex";

// Model calls are cheap (Marcelo, 2026-10-06): no global spacing between calls, and a ticker may be re-decided
// after 5 minutes instead of 10.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("global_min_call_interval_seconds");
    table.integer("per_ticker_model_cooldown_minutes").notNullable().defaultTo(5).alter();
  });
  await knex("pluto_settings").update({ per_ticker_model_cooldown_minutes: 5 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.integer("global_min_call_interval_seconds").notNullable().defaultTo(60);
    table.integer("per_ticker_model_cooldown_minutes").notNullable().defaultTo(10).alter();
  });
}
