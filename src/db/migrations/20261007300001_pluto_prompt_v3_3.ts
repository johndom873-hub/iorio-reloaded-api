import type { Knex } from "knex";

// Prompt v3.3 (Marcelo, 2026-10-07): per-ticker system concerns, managed positions (every position on an enabled ticker,
// labelled opened_by), the grade floor in force, buy-writes explained, the trigger's kind only, trade outcomes in recent decisions.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.3").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.3" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.2").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.2" });
}
