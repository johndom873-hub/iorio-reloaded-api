import type { Knex } from "knex";

// Prompt v3.7 (2026-10-07): covered calls that buy the missing shares are no longer called buy-writes, and the model is told
// not to use the word in its reasons (the operators read Call/Put wording only).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.7").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.7" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.6").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.6" });
}
