import type { Knex } from "knex";

// A backtest session replays every look inside Pluto's trading window (docs/backtesting/FULL-FIDELITY-DESIGN.md, step
// 5): each action names its look, each day counts its looks and filled actions, and the session keeps what its run tells
// about it as a whole (notes) with the figures of its looks and system checks (run_statistics).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.jsonb("notes").notNullable().defaultTo("[]");
    table.jsonb("run_statistics");
  });
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.integer("looks_run");
    table.integer("actions_taken");
  });
  await knex.schema.alterTable("backtest_actions", (table) => {
    table.text("look_time");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_actions", (table) => {
    table.dropColumn("look_time");
  });
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.dropColumn("looks_run");
    table.dropColumn("actions_taken");
  });
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("notes");
    table.dropColumn("run_statistics");
  });
}
