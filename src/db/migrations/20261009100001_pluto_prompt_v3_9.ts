import type { Knex } from "knex";

// Prompt v3.9 (2026-10-09): Edge compares the implied volatility with the forecast on the contract's own clock (trading
// sessions to expiry against the calendar days implied volatility is quoted on); each candidate carries that forecast as
// forecast_vol, and the edge_vp line says so.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.9").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.9" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.8").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.8" });
}
