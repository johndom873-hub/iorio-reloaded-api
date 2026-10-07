import type { Knex } from "knex";

// Prompt v3.5 (Marcelo, 2026-10-07): the macro weights follow the new major-event set (heavy: Fed rate decision, CPI, US
// presidential election; medium: US midterm elections; light: GDP).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.5").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.5" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.4").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.4" });
}
