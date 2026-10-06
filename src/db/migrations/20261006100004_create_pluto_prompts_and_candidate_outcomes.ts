import type { Knex } from "knex";

// Backtest foundation (Marcelo, 2026-09-29: "store exactly what the model saw, build history,
// backtest with a different model later"). Three additions:
//   pluto_prompts            every distinct system prompt text, by content hash — a decision row
//                            points at the exact prompt it was made with
//   pluto_passes.settings_snapshot   the Pluto settings in force when the pass ran
//   pluto_candidate_outcomes hold-to-expiry P&L for EVERY candidate a pass offered (formula
//                            approved 2026-09-29): premium at bid × 100 − intrinsic value at the
//                            expiry close × 100; labelled by the agent once the expiry has settled
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pluto_prompts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("version").notNullable();
    table.text("content_hash").notNullable().unique();
    table.text("content").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable("pluto_decisions", (table) => {
    table.uuid("prompt_id").nullable().references("id").inTable("pluto_prompts");
  });
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.jsonb("settings_snapshot").nullable();
  });
  await knex.schema.createTable("pluto_candidate_outcomes", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("pass_id").notNullable().references("id").inTable("pluto_passes").onDelete("CASCADE");
    table.text("candidate_id").notNullable();
    table.text("symbol").notNullable();
    table.text("strategy_key").notNullable();
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.decimal("premium_bid", 12, 4).notNullable();
    table.integer("multiplier").notNullable().defaultTo(100);
    table.decimal("expiry_close", 12, 4).notNullable();
    table.decimal("hold_to_expiry_pnl", 14, 2).notNullable();
    table.timestamp("labelled_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["pass_id", "candidate_id"]);
    table.index(["expiry"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("pluto_candidate_outcomes");
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.dropColumn("settings_snapshot");
  });
  await knex.schema.alterTable("pluto_decisions", (table) => {
    table.dropColumn("prompt_id");
  });
  await knex.schema.dropTable("pluto_prompts");
}
