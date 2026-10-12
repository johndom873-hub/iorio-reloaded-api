import type { Knex } from "knex";

// Model review (approved by Marcelo 2026-10-10, docs/signal-engine-model-review/REPORT.md): Pluto acts on the valuation
// model. The drift gate measures the edge margin in percentage points (default 10) instead of the old net Edge in
// volatility points, and prompt v4.0 carries the model's figures.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("max_edge_drift_vp", "max_edge_margin_drift_pts");
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("max_edge_margin_drift_pts", 6, 2).notNullable().defaultTo(10).alter();
    table.text("prompt_version").notNullable().defaultTo("v4.0").alter();
  });
  await knex("pluto_settings").update({ max_edge_margin_drift_pts: 10, prompt_version: "v4.0" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.renameColumn("max_edge_margin_drift_pts", "max_edge_drift_vp");
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("max_edge_drift_vp", 6, 2).notNullable().defaultTo(1).alter();
    table.text("prompt_version").notNullable().defaultTo("v3.9").alter();
  });
  await knex("pluto_settings").update({ max_edge_drift_vp: 1, prompt_version: "v3.9" });
}
