import type { Knex } from "knex";

// Prompt v4.3 (2026-10-12): the grade line states the new cut points on the edge margin: strong >= 20%, good 10-20%, weak 0-10%.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.3").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.3" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.2").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.2" });
}
