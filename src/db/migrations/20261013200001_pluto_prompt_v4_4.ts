import type { Knex } from "knex";

// Prompt v4.4 (2026-10-12): code sells the call on free shares itself (highest premium yield above the cycle break-even plus
// the minimum profit, earnings included); the model is no longer offered covered calls on a ticker holding free shares.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.4").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.4" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.3").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.3" });
}
