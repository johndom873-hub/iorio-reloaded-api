import type { Knex } from "knex";

// Model calls are limited by cost alone (Marcelo, 2026-10-06): the daily call cap goes, the daily cost ceiling stays.
// Each decision records the OpenRouter service tier that served it (default / flex / priority), since Pluto now asks
// for the cheapest eligible endpoint (:floor) and the tier explains the cost per call.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("max_model_calls_per_session");
  });
  await knex.schema.alterTable("pluto_decisions", (table) => {
    table.text("service_tier").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_decisions", (table) => {
    table.dropColumn("service_tier");
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.integer("max_model_calls_per_session").notNullable().defaultTo(20);
  });
}
