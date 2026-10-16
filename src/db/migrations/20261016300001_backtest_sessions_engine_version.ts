import type { Knex } from "knex";

// The engine version a backtest session ran on (backtestEngineVersion in backtestTypes.ts), so the ticker analysis
// compares only results of the same engine. Null: run before versions were recorded. Version 1 is the engine as of
// 3020323 (2026-10-15 22:25 SGT): the sessions created since then are set to it; the older ones ran on engines whose
// default results differ (ladder floor, forward anchor, stock fill) and stay null. Backtests run locally only, so staging
// and prod have no rows to set.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.integer("engine_version").nullable();
  });
  await knex("backtest_sessions").where("created_at", ">=", "2026-10-15T14:25:24Z").update({ engine_version: 1 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("engine_version");
  });
}
