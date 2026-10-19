import type { Knex } from "knex";

// Prompt v4.5 (2026-10-19): the account block shows the budget Pluto's working orders hold (pluto_budget_in_flight_pct), and
// recent_decisions keeps a reason only for trades and is history, never the ground for a system concern.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.5").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.5" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.4").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.4" });
}
