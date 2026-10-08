import type { Knex } from "knex";

// Prompt v3.8 (2026-10-08): held positions shown every round with their figures (captured %, max remaining gain, close cost,
// strike distance, event stress loss), each open and roll replacement names the heaviest macro release in its life with the
// sessions until it and after it, and the model is offered event closes (a put's buyback, a whole covered call) before one.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.8").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.8" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("prompt_version").notNullable().defaultTo("v3.7").alter();
  });
  await knex("pluto_settings").update({ prompt_version: "v3.7" });
}
