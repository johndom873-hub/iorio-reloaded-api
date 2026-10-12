import type { Knex } from "knex";

// Prompt v4.1 (2026-10-12): covered calls on held shares. The ticker's free shares get one covered call, the best by Hist
// Yield among those whose assignment clears the cycle break-even plus the minimum profit (on_held_shares), with only a
// positive Hist Edge required; covered-call rolls that lower the strike pass the same break-even rule.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.1").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.1" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.0").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.0" });
}
