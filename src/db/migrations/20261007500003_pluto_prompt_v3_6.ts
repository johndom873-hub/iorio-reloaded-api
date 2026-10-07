import type { Knex } from "knex";

// Prompt v3.6 (2026-10-07): recent decisions name the outcome cancelled_partially_filled (part filled, the rest cancelled) as
// one that changed the book; the order watch stores it, the prompt used to list partially_filled, which is never final.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.6").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.6" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.5").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.5" });
}
