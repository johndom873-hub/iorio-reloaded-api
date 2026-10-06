import type { Knex } from "knex";

// Prompt v3.2 (Marcelo, 2026-10-06): the short-dated policy, rule 3 tightened, the move_context block.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.2").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.2" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3" });
}
