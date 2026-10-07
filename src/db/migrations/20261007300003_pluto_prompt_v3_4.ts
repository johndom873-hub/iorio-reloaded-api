import type { Knex } from "knex";

// Prompt v3.4 (Marcelo, 2026-10-07): the macro flag asks for a stronger edge instead of ruling a trade out, weighted by the
// release (heavy: rate decision, CPI, jobs; medium: core PCE; light: Minutes, PPI, GDP), and only releases still to come are
// listed; earnings outrank any macro release, and no open or roll may stay open through one.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.4").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.4" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.3").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.3" });
}
