import type { Knex } from "knex";

// Prompt v4.2 (2026-10-12): Pluto ranks by the model's Edge Yield, not Hist Yield; candidates no longer carry hist_edge_dollars
// or hist_yield_ann_pct, the grade line drops the history figures, and the held-share call needs a positive Edge.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.2").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.2" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v4.1").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v4.1" });
}
